import { Effect } from "effect"
import type { SessionInfo, SessionOrgChoice } from "@standard-artifacts/protocol"
import { Accounts, SignInError } from "./accounts"
import { readCookie } from "./auth"
import { challengeOfState, isChallenge, issueCode, redeemCode, returnPage, type CodeStore, type PendingCode } from "./desktop-handoff"
import type { Env } from "./env"
import { ORG_COOKIE, SESSION_COOKIE, SESSION_MAX_AGE_S, STATE_COOKIE, STATE_MAX_AGE_S, TICKET_COOKIE, TICKET_TTL_S, cookieName, safeReturnTo, setCookie, type Session } from "./session"

/**
 * Browser sign-in, outside the HttpApi because these are redirects and cookies:
 *
 *   GET  /api/auth/login     → AuthKit (WorkOS's hosted sign-in). ?return_to=/path, ?invitation_token=…, ?screen=sign-up,
 *                              ?desktop=<PKCE challenge> for the desktop app (see desktop-handoff.ts)
 *   GET  /api/auth/callback  ← AuthKit, with ?code&state: sets the session cookie, lands on return_to
 *                              (a desktop sign-in gets a page that hands a one-time code to the app instead)
 *   POST /api/auth/desktop/exchange  { code, verifier } from the desktop app: sets the session cookie there
 *   POST /api/auth/ticket    the session → a 5-minute ticket (JSON, plus a cookie for <img> URLs)
 *   GET  /api/auth/orgs      the orgs the signed-in person belongs to
 *   POST /api/auth/orgs      { name }: a new org, with them as owner, and switch to it
 *   POST /api/auth/switch    { orgId }: re-scope the session to another of their orgs
 *   POST /api/auth/logout    clear the cookies; answers where to go to end the AuthKit session too
 *
 * POSTs must come from the app's own pages (Origin check) on top of SameSite=Lax.
 */

const json = (body: unknown, status = 200, cookies: ReadonlyArray<string> = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" })
  for (const c of cookies) headers.append("set-cookie", c)
  return new Response(JSON.stringify(body), { status, headers })
}

const redirect = (location: string, cookies: ReadonlyArray<string> = []) => {
  const headers = new Headers({ location, "cache-control": "no-store" })
  for (const c of cookies) headers.append("set-cookie", c)
  return new Response(null, { status: 302, headers })
}

const status: Record<SignInError["reason"], number> = { "signed-out": 401, forbidden: 403, invalid: 400, unavailable: 503, misconfigured: 503 }

/** A page for a sign-in that went wrong on the way back from AuthKit. Plain, like the turned-off share link page. */
const errorPage = (message: string, code: number) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Couldn't sign in</title><body style="font:15px/1.5 system-ui;margin:0;display:grid;place-items:center;height:100vh;color:#1f1f1d"><div style="max-width:380px;padding:16px"><h1 style="font-size:18px">Couldn't sign in</h1><p style="color:#73736e">${escapeHtml(message)}</p><p><a href="/api/auth/login" style="color:#2f6fed">Try again</a></p></div>`,
    { status: code, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  )

/** Desktop sign-in codes live in the org's WorkspaceCell (see desktop-handoff.ts). */
const cellCodeStore = (env: Env, orgId: string): CodeStore => {
  const cell = () => env.WORKSPACE.get(env.WORKSPACE.idFromName(orgId))
  return {
    put: async (hash, pending) => void (await cell().putDesktopCode(hash, pending)),
    take: async (hash): Promise<PendingCode | null> => await cell().takeDesktopCode(hash),
  }
}

const withCookies = (response: Response, cookies: ReadonlyArray<string>) => {
  for (const c of cookies) response.headers.append("set-cookie", c)
  return response
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export const isAuthPath = (pathname: string) => pathname.startsWith("/api/auth/")

export const authRoute = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    const cookies = request.headers.get("cookie") ?? undefined
    // The credential cookies are `__Host-` prefixed wherever they're Secure (see cookieName).
    const SESSION = cookieName(request.url, SESSION_COOKIE)
    const TICKET = cookieName(request.url, TICKET_COOKIE)

    if (accounts.mode === "dev") {
      // No sign-in here: everyone is the local owner. Never pretend otherwise.
      if (route === "POST /api/auth/ticket") return json({ mode: "dev" } satisfies SessionInfo)
      if (route === "GET /api/auth/login" || route === "GET /api/auth/callback") return redirect("/")
      return json({ _tag: "NotFound", message: "This server has no sign-in (AUTH_MODE=dev)." }, 404)
    }

    // Live mode without its config: say so, loudly, everywhere sign-in would happen.
    if (accounts.problem) {
      if (request.method === "GET" && url.pathname !== "/api/auth/orgs") return errorPage(accounts.problem, 503)
      return json({ mode: "live", signedIn: false, problem: accounts.problem } satisfies SessionInfo, 503)
    }

    if (request.method === "POST" && !sameOrigin(request, accounts.appOrigin(request))) {
      return json({ _tag: "Forbidden", message: "Cross-site request refused" }, 403)
    }

    const clear = (name: string) => setCookie(request.url, name, "", 0)
    const sessionCookies = (session: Session, sealed: string) => [
      setCookie(request.url, SESSION, sealed, SESSION_MAX_AGE_S),
      // Not a secret, and it outlives the session: the next sign-in lands in the same org.
      setCookie(request.url, ORG_COOKIE, session.org.id, 60 * 60 * 24 * 365),
    ]

    /** The browser's session, refreshed if its access token is about to expire. */
    const current = Effect.gen(function* () {
      const stored = yield* accounts.readSession(readCookie(cookies, SESSION))
      if (!stored) return yield* new SignInError({ reason: "signed-out", message: "Sign in to continue." })
      const session = yield* accounts.fresh(stored)
      return { session, changed: session !== stored }
    })

    /** A ticket for the session, and the cookies that go with it. */
    const ticketed = (session: Session, changed: boolean) =>
      Effect.gen(function* () {
        const minted = yield* accounts.mint(session)
        const set = changed ? sessionCookies(session, yield* accounts.sealSession(session)) : []
        set.push(setCookie(request.url, TICKET, minted.ticket, TICKET_TTL_S))
        const body: SessionInfo = {
          mode: "live",
          signedIn: true,
          ticket: minted.ticket,
          expiresAt: minted.expiresAt,
          user: { id: minted.principal.actor.id, name: session.user.name, email: session.user.email, avatarUrl: session.user.avatarUrl },
          // The ticket's plan and role: live from billing, and read-only for an Editor on Free limits.
          org: { ...session.org, plan: minted.principal.plan },
          role: minted.principal.role,
        }
        return json(body, 200, set)
      })

    /** Failures as JSON; a session that's over also loses its cookies. */
    const failed = (e: SignInError) => {
      if (e.reason === "misconfigured") return json({ mode: "live", signedIn: false, problem: e.message } satisfies SessionInfo, 503)
      if (e.reason === "signed-out") {
        return json({ mode: "live", signedIn: false } satisfies SessionInfo, 401, [clear(SESSION), clear(TICKET)])
      }
      return json({ _tag: e.reason === "forbidden" ? "Forbidden" : e.reason === "invalid" ? "Invalid" : "Unavailable", message: e.message }, status[e.reason])
    }

    switch (route) {
      case "GET /api/auth/login": {
        const screen = url.searchParams.get("screen")
        const desktop = url.searchParams.get("desktop")
        if (desktop !== null && !isChallenge(desktop)) return errorPage("The app sent a sign-in request this server can't read. Update the app and try again.", 400)
        return yield* accounts
          .startSignIn(request, {
            returnTo: url.searchParams.get("return_to"),
            invitationToken: url.searchParams.get("invitation_token"),
            ...(screen === "sign-up" || screen === "sign-in" ? { screenHint: screen } : {}),
            desktop,
          })
          .pipe(
            Effect.map((start) => redirect(start.location, [setCookie(request.url, STATE_COOKIE, start.stateCookie, STATE_MAX_AGE_S)])),
            Effect.catchTag("SignInError", (e) => Effect.succeed(errorPage(e.message, status[e.reason]))),
          )
      }

      case "GET /api/auth/callback": {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        if (!code || !state) {
          const reason = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          return errorPage(reason ?? "The sign-in page didn't send us back a code.", 400)
        }
        return yield* accounts
          .finishSignIn(request, { code, state, stateCookie: readCookie(cookies, STATE_COOKIE), lastOrg: readCookie(cookies, ORG_COOKIE) })
          .pipe(
            Effect.flatMap(({ session, returnTo }) =>
              Effect.flatMap(accounts.sealSession(session), (sealed) => {
                const landing = safeReturnTo(returnTo, accounts.appOrigin(request))
                // The state matched the sealed cookie, so this is the challenge the login started with.
                const challenge = challengeOfState(state)
                if (!challenge) return Effect.succeed(redirect(landing, [...sessionCookies(session, sealed), clear(STATE_COOKIE), clear(TICKET)]))
                // The desktop app's sign-in: the session goes to the app, never to this browser.
                return Effect.tryPromise({
                  try: () => issueCode((orgId) => cellCodeStore(env, orgId), { orgId: session.org.id, challenge, sealed, returnTo: landing }),
                  catch: () => new SignInError({ reason: "unavailable", message: "Couldn't hand the sign-in to the app. Sign in again from the app." }),
                }).pipe(Effect.map((code) => withCookies(returnPage(code), [clear(STATE_COOKIE)])))
              }),
            ),
            Effect.catchTag("SignInError", (e) => Effect.succeed(errorPage(e.message, status[e.reason]))),
          )
      }

      case "POST /api/auth/ticket":
        return yield* current.pipe(
          Effect.flatMap(({ session, changed }) => ticketed(session, changed)),
          Effect.catchTag("SignInError", (e) => Effect.succeed(failed(e))),
        )

      case "GET /api/auth/orgs": {
        // Only needs who's asking, so it never refreshes: that would race the page's ticket renewals over the refresh token.
        const session = yield* accounts.readSession(readCookie(cookies, SESSION))
        if (!session) return failed(new SignInError({ reason: "signed-out", message: "Sign in to continue." }))
        return yield* accounts.orgs(session).pipe(
          Effect.map((orgs: ReadonlyArray<SessionOrgChoice>) => json(orgs)),
          Effect.catchTag("SignInError", (e) => Effect.succeed(failed(e))),
        )
      }

      case "POST /api/auth/orgs":
      case "POST /api/auth/switch": {
        const body = yield* Effect.promise(() => request.json().catch((): unknown => null))
        const field = (name: string) => (typeof body === "object" && body !== null && typeof (body as Record<string, unknown>)[name] === "string" ? String((body as Record<string, unknown>)[name]) : "")
        return yield* current.pipe(
          Effect.flatMap(({ session }) => (route === "POST /api/auth/orgs" ? accounts.createOrg(session, field("name")) : accounts.switchOrg(session, field("orgId")))),
          Effect.flatMap((session) => ticketed(session, true)),
          Effect.catchTag("SignInError", (e) => Effect.succeed(failed(e))),
        )
      }

      case "POST /api/auth/desktop/exchange": {
        // JSON only: a form on another site can't send it without a preflight, which this route never answers.
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
          return json({ _tag: "Invalid", message: "Send the code and verifier as JSON." }, 415)
        }
        const body = yield* Effect.promise(() => request.json().catch((): unknown => null))
        const { code, verifier } = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
        const redeemed = yield* Effect.tryPromise(() => redeemCode((orgId) => cellCodeStore(env, orgId), code, verifier)).pipe(Effect.orElseSucceed(() => undefined))
        if (!redeemed) return json({ _tag: "Unavailable", message: "Couldn't finish signing in. Try again in a moment." }, 503)
        if (!redeemed.ok) return json({ _tag: "Invalid", reason: redeemed.reason, message: redeemed.message }, 400)
        return json({ returnTo: redeemed.returnTo }, 200, [
          setCookie(request.url, SESSION, redeemed.sealed, SESSION_MAX_AGE_S),
          setCookie(request.url, ORG_COOKIE, redeemed.orgId, 60 * 60 * 24 * 365),
          clear(TICKET),
        ])
      }

      case "POST /api/auth/logout": {
        const session = yield* accounts.readSession(readCookie(cookies, SESSION))
        return json({ redirect: accounts.signOutUrl(request, session) }, 200, [clear(SESSION), clear(TICKET), clear(STATE_COOKIE)])
      }

      default:
        return json({ _tag: "NotFound", message: "Not found" }, 404)
    }
  }).pipe(Effect.withSpan("Http.auth"))

/** A POST from the app's own pages. Browsers send Origin on every POST; a request without one isn't from a page. */
function sameOrigin(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin")
  if (origin === null) return true
  return origin === appOrigin || origin === new URL(request.url).origin
}
