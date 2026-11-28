import { BrowserWindow, dialog, shell, type Session } from "electron"
import { browserSignInUrl, destinationOf, isSignOutUrl } from "./links"
import { newPkce, type Pkce } from "./pkce"

/**
 * Signing in and out of Standard Artifacts Cloud from the app (RFC 8252).
 *
 * AuthKit can't run in the app's window (Google refuses embedded browsers), so
 * the app's own `/api/auth/login` opens in the person's browser with a PKCE
 * challenge. The browser comes back with `stdartifacts://auth/callback?code=…`,
 * and the app trades the code and its verifier for the session cookie, from
 * its own session, so the cookie lands here and not in the browser. See
 * apps/app/src/worker/desktop-handoff.ts for the server's half.
 *
 * Signing out clears everything the app's session kept and ends the AuthKit
 * session in the background, without leaving the window.
 *
 * There's one of these per workspace (server), each on that workspace's own session.
 */

/** As long as the server keeps a sign-in open (STATE_MAX_AGE_S). */
const PENDING_FOR_MS = 10 * 60_000
/** How long after the app's sign-out the navigation to AuthKit's sign-out counts as part of it. */
const SIGN_OUT_FOR_MS = 30_000

export interface SignIn {
  /** Sign in through the person's browser, for a navigation to the app's `/api/auth/login`. */
  readonly start: (loginUrl: string) => void
  /** The code from `stdartifacts://auth/callback`. */
  readonly finish: (code: string) => Promise<void>
  /** True for AuthKit's sign-out right after the page signed out: the one navigation off the app that stays in the app. */
  readonly isSignOut: (url: string) => boolean
  /** End the AuthKit session in the background, then show the signed-out app. */
  readonly signOut: (logoutUrl: string) => Promise<void>
  /** Notice the page signing out (POST /api/auth/logout), to clear what the app's session kept. */
  readonly watch: () => void
  /** When this workspace's sign-in started, while one is open: a callback link belongs to the newest. */
  readonly pendingSince: () => number | null
}

export function createSignIn(options: { readonly appOrigin: string; readonly session: Session; readonly show: (href: string) => void }): SignIn {
  const { appOrigin, session, show } = options
  let pending: (Pkce & { readonly until: number; readonly since: number }) | undefined
  let signingOutUntil = 0
  let clearing: Promise<void> | undefined
  const live = () => (pending && pending.until > Date.now() ? pending : undefined)

  const failed = (detail: string) => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const box = { type: "warning" as const, message: "Couldn't sign in", detail }
    void (parent ? dialog.showMessageBox(parent, box) : dialog.showMessageBox(box))
  }

  /** Everything the page kept: cookies, local storage, caches. The window then starts over. */
  const clearAll = () => session.clearStorageData().catch(() => {})

  return {
    start(loginUrl) {
      // Signing in again while a sign-in is open reuses its verifier, so whichever browser tab finishes still works.
      const current = live() ?? { ...newPkce(), until: Date.now() + PENDING_FOR_MS, since: Date.now() }
      pending = current
      void shell.openExternal(browserSignInUrl(loginUrl, appOrigin, current.challenge))
    },

    async finish(code) {
      // A link the app didn't ask for, or one from before it restarted: there's no verifier to go with it.
      const current = live()
      if (!current) return
      let res: Response
      try {
        res = await session.fetch(new URL("/api/auth/desktop/exchange", appOrigin).toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, verifier: current.verifier }),
          // Sends and keeps the session's cookies, so the server's Set-Cookie lands where the window reads it.
          credentials: "include",
          cache: "no-store",
        })
      } catch {
        return failed("Couldn't reach Standard Artifacts. Check your connection, then sign in again.")
      }
      const body = (await res.json().catch(() => null)) as { returnTo?: unknown; message?: unknown } | null
      // A failed code keeps the verifier: another tab of the same sign-in may still bring the right one.
      if (!res.ok) return failed(typeof body?.message === "string" ? body.message : "Sign-in didn't finish. Try again.")
      if (pending === current) pending = undefined
      const returnTo = typeof body?.returnTo === "string" ? body.returnTo : "/"
      show(returnTo.startsWith("/") && destinationOf(new URL(returnTo, appOrigin).toString(), appOrigin) === "in-app" ? returnTo : "/")
    },

    isSignOut: (url) => isSignOutUrl(url) && Date.now() < signingOutUntil,

    async signOut(logoutUrl) {
      signingOutUntil = 0
      // WorkOS ends the session on this request; where it redirects next doesn't matter.
      await session.fetch(logoutUrl, { redirect: "manual", cache: "no-store" }).catch(() => undefined)
      await (clearing ?? clearAll())
      clearing = undefined
      show("/")
    },

    watch() {
      session.webRequest.onCompleted({ urls: ["*://*/api/auth/logout"] }, (details) => {
        if (details.method !== "POST" || details.statusCode !== 200 || new URL(details.url).origin !== appOrigin) return
        // The server has cleared its cookies; whatever the page navigates to next starts signed out.
        pending = undefined
        signingOutUntil = Date.now() + SIGN_OUT_FOR_MS
        clearing = clearAll()
      })
    },

    pendingSince: () => live()?.since ?? null,
  }
}
