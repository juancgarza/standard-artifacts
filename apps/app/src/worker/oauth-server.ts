import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import {
  ConsentAnswer,
  ConsentProblem,
  Forbidden,
  NotFound,
  type ConnectedAgent,
  type ConsentInfo,
  type ConsentOrg,
  type ConsentResult,
  type Principal,
  type SessionOrgChoice,
} from "@standard-artifacts/protocol"
import { Accounts, SignInError } from "./accounts"
import { Billing } from "./billing"
import type { Grant, PendingCode, Refreshed, Taken } from "./cells/grants"
import type { ConsentRequest, RegisteredClient } from "./cells/oauth-cell"
import type { CellResult } from "./cells/workspace-cell"
import { Bindings } from "./env"
import {
  CODE_TTL_S,
  LIMITS,
  REQUEST_TTL_S,
  SCOPE,
  ACCESS_TOKEN_TTL_S,
  agentNameOf,
  basicCredentials,
  checkClientMetadata,
  fetchMetadataDocument,
  hashSecret,
  isChallenge,
  isRegisteredClientId,
  isRequestId,
  kindOfSecret,
  mcpResource,
  newClientId,
  newClientSecret,
  newRequestId,
  newSecret,
  redirectMatches,
  resourceMatches,
  secretOrg,
  summarizeRedirect,
  timingSafeEqual,
  toB64url,
  verifyPkce,
  withParams,
  type AuthMethod,
} from "./oauth"
import { readCookie } from "./auth"
import { SESSION_COOKIE, agentRole, cookieName, userActorId, type Session } from "./session"

/**
 * The OAuth authorization server for remote MCP (see oauth.ts for the
 * protocol and oauth-routes.ts for the HTTP surface). It's on in live mode
 * with sign-in configured; a dev server has no sign-in, so its /mcp needs none.
 */

/** An OAuth error answer (RFC 6749 §5.2): `error`, a sentence for people, and the HTTP status. */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  error: Schema.String,
  description: Schema.String,
  status: Schema.Number,
}) {}

/** Why the consent page can't go on, in words for the person looking at it. */
export class ConsentError extends Schema.TaggedError<ConsentError>()("ConsentError", {
  reason: ConsentProblem,
  message: Schema.String,
}) {}

/** A client, from its registration or its metadata document. */
interface Client {
  readonly id: string
  readonly name: string | null
  readonly uri: string | null
  readonly logoUri: string | null
  readonly redirectUris: ReadonlyArray<string>
  readonly authMethod: AuthMethod
  readonly secretHash: string | null
  readonly metadataDocument: boolean
}

export interface TokenResponse {
  readonly access_token: string
  readonly token_type: "Bearer"
  readonly expires_in: number
  readonly refresh_token: string
  readonly scope: string
}

export class OAuthServer extends Context.Service<
  OAuthServer,
  {
    /** Live mode with sign-in configured. Off, discovery and every endpoint answer 404. */
    readonly enabled: boolean
    /** This server's address: the issuer, and the origin of the /mcp resource. */
    readonly origin: (request: Request) => string
    readonly register: (request: Request, body: unknown) => Effect.Effect<Record<string, unknown>, OAuthError>
    /** Where /api/oauth/authorize sends the browser: the consent page (via sign-in if needed), back to the client with an error, or a page saying what's wrong. */
    readonly authorize: (request: Request) => Effect.Effect<string>
    readonly consent: (request: Request, requestId: string | null) => Effect.Effect<ConsentInfo, ConsentError>
    /** The person's answer. A new session comes back when approving meant switching orgs (the route sets its cookie). */
    readonly answer: (request: Request, body: unknown) => Effect.Effect<{ readonly result: ConsentResult; readonly session: Session | undefined }, ConsentError>
    readonly token: (request: Request, form: URLSearchParams) => Effect.Effect<TokenResponse, OAuthError>
    readonly revoke: (form: URLSearchParams) => Effect.Effect<void>
    readonly connections: (p: Principal, origin: string) => Effect.Effect<ReadonlyArray<ConnectedAgent>, Forbidden | NotFound>
    readonly disconnect: (p: Principal, id: string) => Effect.Effect<void, Forbidden | NotFound>
    /** Someone was removed from the org: their agents are refused (403) at once, until they're back or disconnected. */
    readonly memberRemoved: (p: Principal, userId: string) => Effect.Effect<void>
  }
>()("@standard-artifacts/OAuthServer") {
  static readonly layer = Layer.effect(
    OAuthServer,
    Effect.gen(function* () {
      const env = yield* Bindings
      const accounts = yield* Accounts
      const billing = yield* Billing
      const secret = yield* Config.option(Config.Redacted("TICKET_SECRET"))
      const enabled = accounts.mode === "live" && !accounts.problem && Option.isSome(secret)
      const csrfKey = Option.isSome(secret)
        ? yield* Effect.promise(() =>
            crypto.subtle.importKey("raw", new TextEncoder().encode(`oauth-consent:${Redacted.value(secret.value)}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
          )
        : undefined

      const registry = () => env.OAUTH.get(env.OAUTH.idFromName("registry"))
      const cellOf = (orgId: string) => env.WORKSPACE.get(env.WORKSPACE.idFromName(orgId))
      const origin = (request: Request) => accounts.appOrigin(request)
      const nowS = () => Math.floor(Date.now() / 1000)
      const rpc = <T>(call: () => Promise<T>): Effect.Effect<T> => Effect.promise(async () => await call())

      const oauthError = (error: string, description: string, status = 400) => new OAuthError({ error, description, status })
      const consentError = (reason: ConsentProblem, message: string) => new ConsentError({ reason, message })

      /** The caller's IP, for rate limits. Behind Cloudflare it's `cf-connecting-ip`; locally there's one caller. */
      const callerOf = (request: Request) => request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? "local"
      const allow = (request: Request, kind: keyof typeof LIMITS) => rpc(() => registry().hit(`${kind}:${callerOf(request)}`, LIMITS[kind].max, LIMITS[kind].windowS))

      // --- Clients ------------------------------------------------------------------------------

      const fromRegistration = (c: RegisteredClient): Client => ({ ...c, metadataDocument: false })

      /** A client by id: a registration, or a metadata document fetched from its URL. Null when there's no such client. */
      const loadClient = Effect.fn("OAuth.loadClient")(function* (clientId: string | null) {
        if (!clientId) return null
        if (isRegisteredClientId(clientId)) {
          const found = yield* rpc(() => registry().client(clientId))
          return found ? fromRegistration(found) : null
        }
        if (!clientId.startsWith("https://")) return null
        const doc = yield* Effect.promise(() => fetchMetadataDocument(clientId))
        if (!doc.ok) {
          console.warn(`OAuth: couldn't use the metadata document at ${clientId}: ${doc.reason}`)
          return null
        }
        return { id: clientId, ...doc.value, secretHash: null, metadataDocument: true } satisfies Client
      })

      const register: OAuthServer["Service"]["register"] = Effect.fn("OAuth.register")(function* (request, body) {
        if (!(yield* allow(request, "register"))) return yield* oauthError("too_many_requests", "Too many registrations from here. Try again in a minute.", 429)
        const checked = checkClientMetadata(body)
        if (!checked.ok) return yield* oauthError(checked.error, checked.description)
        const m = checked.value
        const id = newClientId()
        const clientSecret = m.authMethod === "none" ? undefined : newClientSecret()
        const issuedAt = nowS()
        yield* rpc(async () =>
          registry().registerClient({
            id,
            secretHash: clientSecret ? await hashSecret(clientSecret) : null,
            authMethod: m.authMethod,
            name: m.name,
            uri: m.uri,
            logoUri: m.logoUri,
            redirectUris: m.redirectUris,
            createdAt: issuedAt,
          }),
        )
        return {
          client_id: id,
          client_id_issued_at: issuedAt,
          ...(clientSecret && { client_secret: clientSecret, client_secret_expires_at: 0 }),
          ...(m.name && { client_name: m.name }),
          ...(m.uri && { client_uri: m.uri }),
          ...(m.logoUri && { logo_uri: m.logoUri }),
          redirect_uris: m.redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: m.authMethod,
          scope: SCOPE,
        }
      })

      // --- Authorize → consent ------------------------------------------------------------------

      /** The consent page showing a problem instead of a form (codes only: the page has the words). */
      const problemPage = (reason: ConsentProblem) => `/authorize?error=${reason}`

      const authorize: OAuthServer["Service"]["authorize"] = Effect.fn("OAuth.authorize")(function* (request) {
        if (!enabled) return problemPage("not-enabled")
        if (!(yield* allow(request, "authorize"))) return problemPage("unavailable")
        const q = new URL(request.url).searchParams
        const client = yield* loadClient(q.get("client_id"))
        if (!client) return problemPage("unknown-client")
        // Until the redirect URI checks out, nothing goes back to it: that would make this an open redirect.
        const redirectUri = q.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null)
        if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) return problemPage("redirect-mismatch")

        const state = q.get("state")
        const iss = origin(request)
        const back = (error: string, description: string) => withParams(redirectUri, { error, error_description: description, ...(state !== null && { state }), iss })
        if (q.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.")
        const challenge = q.get("code_challenge")
        if (q.get("code_challenge_method") !== "S256" || !isChallenge(challenge)) return back("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.")
        const resources = q.getAll("resource")
        if (resources.length > 1 || !resourceMatches(resources[0], iss)) return back("invalid_target", `This server only issues tokens for ${mcpResource(iss)}.`)
        if (q.get("prompt") === "none") return back("consent_required", "Approving a connection needs the person.")

        const id = newRequestId()
        const pending: ConsentRequest = {
          clientId: client.id,
          redirectUri,
          state,
          challenge,
          resource: mcpResource(iss),
          clientName: client.name,
          clientUri: client.uri,
          logoUri: client.logoUri,
          metadataDocument: client.metadataDocument,
          expiresAt: nowS() + REQUEST_TTL_S,
        }
        yield* rpc(() => registry().putRequest(id, pending))
        const page = `/authorize?request=${id}`
        const session = yield* accounts.readSession(sessionCookie(request))
        // Signed out: AuthKit first, then straight back to the consent page.
        return session ? page : `/api/auth/login?return_to=${encodeURIComponent(page)}`
      })

      const sessionOf = Effect.fn("OAuth.session")(function* (request: Request) {
        const session = yield* accounts.readSession(sessionCookie(request))
        if (!session) return yield* consentError("signed-out", "Sign in to continue.")
        return session
      })

      const signInProblem = (e: SignInError) =>
        e.reason === "signed-out"
          ? consentError("signed-out", e.message)
          : e.reason === "forbidden"
            ? consentError("forbidden", e.message)
            : consentError("unavailable", e.message)

      /** A request that's still waiting. Gone and expired read the same to the person: start again from the app. */
      const waiting = Effect.fn("OAuth.waiting")(function* (requestId: string | null) {
        if (!isRequestId(requestId)) return yield* consentError("bad-request", "This sign-in link is incomplete. Start again from the app you're connecting.")
        const request = yield* rpc(() => registry().request(requestId))
        if (!request || request.expiresAt < nowS()) {
          return yield* consentError("expired", "This request expired or was already answered. Start again from the app you're connecting.")
        }
        return request
      })

      const csrfFor = (requestId: string, userId: string) =>
        Effect.promise(async () => (csrfKey ? toB64url(new Uint8Array(await crypto.subtle.sign("HMAC", csrfKey, new TextEncoder().encode(`${requestId}.${userId}`)))) : ""))

      /** The most an agent can do in an org, for this person, and why not more. */
      const accessIn = Effect.fn("OAuth.accessIn")(function* (org: SessionOrgChoice, session: Session) {
        if (org.role === "viewer") return { maxAccess: "read", limit: `You're a Viewer in ${org.name}, so agents you connect there can read but not edit.` } as const
        const plan = yield* billing.livePlan(org.id, org.id === session.org.id ? session.org.plan : "free")
        if (agentRole(billing.effectiveRole(org.role, plan)) === "viewer") {
          return { maxAccess: "read", limit: `${org.name} is on the Free plan, where only the owner edits. Upgrade to Team to let your agents edit there.` } as const
        }
        return { maxAccess: "write", limit: null } as const
      })

      const orgChoices = Effect.fn("OAuth.orgChoices")(function* (session: Session) {
        const orgs = yield* accounts.orgs(session).pipe(Effect.mapError(signInProblem))
        if (orgs.length === 0) return yield* consentError("no-membership", "You aren't a member of any workspace yet. Open Standard Artifacts to make one, then try again.")
        return yield* Effect.forEach(orgs, (org) => Effect.map(accessIn(org, session), (access): ConsentOrg => ({ ...org, ...access })), { concurrency: 4 })
      })

      const consent: OAuthServer["Service"]["consent"] = Effect.fn("OAuth.consent")(function* (request, requestId) {
        if (!enabled) return yield* consentError("not-enabled", "This server doesn't sign agents in.")
        const session = yield* sessionOf(request)
        const pending = yield* waiting(requestId)
        const orgs = yield* orgChoices(session)
        const summary = summarizeRedirect({ clientName: pending.clientName, redirectUri: pending.redirectUri, metadataUrl: pending.metadataDocument ? pending.clientId : undefined })
        return {
          request: requestId!,
          client: {
            id: pending.clientId,
            name: pending.clientName,
            agentName: agentNameOf(pending.clientName),
            logoUri: pending.logoUri,
            uri: pending.clientUri,
            redirectKind: summary.kind,
            redirectHost: summary.host,
            verified: summary.verified,
            warning: summary.warning,
          },
          user: { id: userActorId(session.user.id), name: session.user.name, email: session.user.email, avatarUrl: session.user.avatarUrl },
          orgs,
          csrf: yield* csrfFor(requestId!, session.user.id),
          expiresAt: pending.expiresAt * 1000,
        } satisfies ConsentInfo
      })

      const decodeAnswer = Schema.decodeUnknownEffect(ConsentAnswer)

      const answer: OAuthServer["Service"]["answer"] = Effect.fn("OAuth.answer")(function* (request, body) {
        if (!enabled) return yield* consentError("not-enabled", "This server doesn't sign agents in.")
        const input = yield* decodeAnswer(body).pipe(Effect.mapError(() => consentError("bad-request", "The answer didn't come through. Reload the page and try again.")))
        let session = yield* sessionOf(request)
        const pending = yield* waiting(input.request)
        if (!timingSafeEqual(input.csrf, yield* csrfFor(input.request, session.user.id))) {
          return yield* consentError("forbidden", "This page belongs to another sign-in. Reload it and try again.")
        }
        const iss = origin(request)
        const agentName = agentNameOf(pending.clientName)
        const back = (params: Record<string, string>) => withParams(pending.redirectUri, { ...params, ...(pending.state !== null && { state: pending.state }), iss })
        const take = Effect.flatMap(
          rpc(() => registry().takeRequest(input.request)),
          (taken) => (taken ? Effect.void : Effect.fail(consentError("expired", "This request was already answered. Start again from the app you're connecting."))),
        )

        if (input.decision === "deny") {
          yield* take
          return { result: { redirect: back({ error: "access_denied", error_description: "The person declined to connect." }), clientName: agentName, approved: false }, session: undefined }
        }

        const orgs = yield* orgChoices(session)
        const org = orgs.find((o) => o.id === input.orgId)
        if (!org) return yield* consentError("no-membership", "You aren't a member of that workspace. Pick another one.")
        const access = input.access ?? org.maxAccess
        if (access === "write" && org.maxAccess !== "write") return yield* consentError("forbidden", org.limit ?? "You can only connect this agent read-only there.")

        // Another org than the browser's: switch into it first, so its sign-in rules (SSO, MFA) apply here as in the app.
        let switched: Session | undefined
        if (org.id !== session.org.id) {
          switched = yield* accounts.switchOrg(session, org.id).pipe(Effect.mapError(signInProblem))
          session = switched
        }
        yield* take

        const plan = yield* billing.livePlan(org.id, session.org.plan)
        const person: Principal = {
          orgId: org.id,
          orgName: org.name,
          plan,
          role: billing.effectiveRole(org.role, plan),
          actor: { type: "user", id: userActorId(session.user.id), name: session.user.name },
        }
        const code = newSecret("code", org.id)
        const pendingCode: PendingCode = {
          clientId: pending.clientId,
          clientName: pending.clientName,
          clientUri: pending.clientUri,
          logoUri: pending.logoUri,
          metadataDocument: pending.metadataDocument,
          redirectUri: pending.redirectUri,
          challenge: pending.challenge,
          resource: pending.resource,
          userId: person.actor.id,
          userName: session.user.name,
          agentName,
          access,
          role: org.role,
          expiresAt: nowS() + CODE_TTL_S,
        }
        const cell = cellOf(org.id)
        // Touching the org's cell as the person also tells it which org it is, so the grant's tokens can name it.
        yield* rpc(() => cell.touch(person))
        yield* rpc(async () => cell.putOAuthCode(await hashSecret(code), pendingCode))
        return { result: { redirect: back({ code }), clientName: agentName, approved: true }, session: switched }
      })

      // --- Tokens -------------------------------------------------------------------------------

      /** Who's calling the token endpoint: Basic, or client_id (and client_secret) in the form. */
      const authenticate = Effect.fn("OAuth.authenticate")(function* (request: Request, form: URLSearchParams) {
        const basic = basicCredentials(request.headers.get("authorization"))
        const clientId = basic?.id ?? form.get("client_id")
        const given = basic?.secret ?? form.get("client_secret")
        if (!clientId) return yield* oauthError("invalid_client", "Say which client is asking (client_id).", 401)
        if (isRegisteredClientId(clientId)) {
          const client = yield* rpc(() => registry().client(clientId))
          if (!client) return yield* oauthError("invalid_client", "This client isn't registered here. Register again.", 401)
          if (client.secretHash) {
            if (!given || !timingSafeEqual(yield* Effect.promise(() => hashSecret(given)), client.secretHash)) {
              return yield* oauthError("invalid_client", "The client secret is wrong.", 401)
            }
          }
          return clientId
        }
        // A metadata-document client is public: the code (or refresh token) is bound to its id, and PKCE proves the rest.
        if (clientId.startsWith("https://")) return clientId
        return yield* oauthError("invalid_client", "Unknown client.", 401)
      })

      const issue = (orgId: string) =>
        Effect.promise(async () => {
          const access = newSecret("access", orgId)
          const refresh = newSecret("refresh", orgId)
          return { access, refresh, accessHash: await hashSecret(access), refreshHash: await hashSecret(refresh) }
        })

      const response = (t: { readonly access: string; readonly refresh: string }): TokenResponse => ({
        access_token: t.access,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_S,
        refresh_token: t.refresh,
        scope: SCOPE,
      })

      const codeMessages: Record<Exclude<Taken, { ok: true }>["reason"], string> = {
        unknown: "That authorization code isn't valid.",
        expired: "That authorization code expired. Sign in again.",
        used: "That authorization code was already used, so the sign-in it made was ended. Sign in again.",
      }
      const refreshMessages: Record<Exclude<Refreshed, { ok: true }>["reason"], string> = {
        unknown: "This sign-in ended or was disconnected. Sign in again.",
        expired: "This sign-in expired. Sign in again.",
        client: "That refresh token belongs to another client.",
        reused: "That refresh token was already used, so this sign-in was ended to be safe. Sign in again.",
      }

      const exchange = Effect.fn("OAuth.exchange")(function* (request: Request, form: URLSearchParams) {
        const clientId = yield* authenticate(request, form)
        const resource = form.get("resource")
        if (!resourceMatches(resource, origin(request))) return yield* oauthError("invalid_target", `This server only issues tokens for ${mcpResource(origin(request))}.`)
        switch (form.get("grant_type")) {
          case "authorization_code": {
            const code = form.get("code")
            const orgId = secretOrg("code", code)
            if (!code || !orgId) return yield* oauthError("invalid_grant", codeMessages.unknown)
            const codeHash = yield* Effect.promise(() => hashSecret(code))
            const cell = cellOf(orgId)
            const taken = yield* rpc((): Promise<Taken> => cell.takeOAuthCode(codeHash))
            if (!taken.ok) return yield* oauthError("invalid_grant", codeMessages[taken.reason])
            const c = taken.code
            if (c.clientId !== clientId) return yield* oauthError("invalid_grant", "That code was issued to another client.")
            const redirectUri = form.get("redirect_uri")
            if (redirectUri !== null && redirectUri !== c.redirectUri) return yield* oauthError("invalid_grant", "redirect_uri doesn't match the one the code was issued for.")
            if (!(yield* Effect.promise(() => verifyPkce(form.get("code_verifier"), c.challenge)))) {
              return yield* oauthError("invalid_grant", "code_verifier doesn't match the code_challenge.")
            }
            const t = yield* issue(orgId)
            const id = `grt_${toB64url(crypto.getRandomValues(new Uint8Array(12)))}`
            const grant = yield* rpc((): Promise<Grant | null> => cell.createOAuthGrant({ codeHash, id, code: c, accessHash: t.accessHash, refreshHash: t.refreshHash }))
            if (!grant) return yield* oauthError("invalid_grant", codeMessages.used)
            return response(t)
          }
          case "refresh_token": {
            const token = form.get("refresh_token")
            const orgId = secretOrg("refresh", token)
            if (!token || !orgId) return yield* oauthError("invalid_grant", refreshMessages.unknown)
            const t = yield* issue(orgId)
            const hash = yield* Effect.promise(() => hashSecret(token))
            const refreshed = yield* rpc((): Promise<Refreshed> => cellOf(orgId).refreshOAuthToken(hash, clientId, { accessHash: t.accessHash, refreshHash: t.refreshHash }))
            if (!refreshed.ok) return yield* oauthError("invalid_grant", refreshMessages[refreshed.reason])
            return response(t)
          }
          default:
            return yield* oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.")
        }
      })

      const token: OAuthServer["Service"]["token"] = Effect.fn("OAuth.token")(function* (request, form) {
        if (!enabled) return yield* oauthError("invalid_request", "This server doesn't sign agents in.", 404)
        const caller = `tokenFailures:${callerOf(request)}`
        const tooMany = oauthError("too_many_requests", "Too many requests from here. Try again in a minute.", 429)
        if (!(yield* allow(request, "token"))) return yield* tooMany
        if (yield* rpc(() => registry().blocked(caller, LIMITS.tokenFailures.max, LIMITS.tokenFailures.windowS))) return yield* tooMany
        return yield* exchange(request, form).pipe(
          Effect.tapError(() => rpc(() => registry().hit(caller, Number.MAX_SAFE_INTEGER, LIMITS.tokenFailures.windowS))),
        )
      })

      const revoke: OAuthServer["Service"]["revoke"] = Effect.fn("OAuth.revoke")(function* (form) {
        const token = form.get("token")
        const kind = token ? kindOfSecret(token) : undefined
        if (!token || (kind !== "access" && kind !== "refresh")) return
        const orgId = secretOrg(kind, token)
        if (!orgId) return
        const hash = yield* Effect.promise(() => hashSecret(token))
        yield* rpc(() => cellOf(orgId).revokeOAuthToken(hash))
      })

      // --- Connected agents -----------------------------------------------------------------------

      const fromCell = <T>(r: CellResult<T>) =>
        r.ok ? Effect.succeed(r.value) : Effect.fail(r.reason === "forbidden" ? new Forbidden({ message: r.error }) : new NotFound({ message: r.error }))

      const iso = (s: number | null) => (s === null ? null : new Date(s * 1000).toISOString())

      const connections: OAuthServer["Service"]["connections"] = Effect.fn("OAuth.connections")(function* (p) {
        const grants = yield* fromCell(yield* rpc((): Promise<CellResult<Array<Grant>>> => cellOf(p.orgId).listOAuthGrants(p)))
        return grants.map(
          (g): ConnectedAgent => ({
            id: g.id,
            clientName: g.clientName,
            agentName: g.agentName,
            logoUri: g.logoUri,
            clientUri: g.clientUri,
            redirectHost: summarizeRedirect({ clientName: g.clientName, redirectUri: g.redirectUri }).host,
            access: g.access,
            connectedBy: { id: g.userId, name: g.userName },
            member: g.role !== "removed",
            connectedAt: iso(g.createdAt)!,
            lastUsedAt: iso(g.lastUsedAt),
          }),
        )
      })

      const disconnect: OAuthServer["Service"]["disconnect"] = Effect.fn("OAuth.disconnect")(function* (p, id) {
        yield* fromCell(yield* rpc((): Promise<CellResult<null>> => cellOf(p.orgId).revokeOAuthGrant(p, id)))
      })

      const memberRemoved: OAuthServer["Service"]["memberRemoved"] = Effect.fn("OAuth.memberRemoved")(function* (p, userId) {
        yield* rpc(() => cellOf(p.orgId).oauthRoleChecked(userId, "removed"))
      })

      return OAuthServer.of({ enabled, origin, register, authorize, consent, answer, token, revoke, connections, disconnect, memberRemoved })
    }),
  )
}

const sessionCookie = (request: Request) => readCookie(request.headers.get("cookie") ?? undefined, cookieName(request.url, SESSION_COOKIE))
