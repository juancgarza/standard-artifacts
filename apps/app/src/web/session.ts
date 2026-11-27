import { useSyncExternalStore } from "react"
import { authorizeRooms } from "@standard-artifacts/room"
import type { SessionInfo, SessionOrgChoice } from "@standard-artifacts/protocol"

/**
 * The browser's sign-in, in live mode. The session itself is an httpOnly cookie
 * the page can't read; what the page holds is a short-lived ticket from
 * `POST /api/auth/ticket`, sent as a bearer token on API calls and as
 * `?ticket=` on sockets. It's renewed a minute before it expires, one tab at a
 * time (Web Locks), since renewing can rotate the session's refresh token.
 *
 * A dev server has no sign-in: everything here stays empty and requests go out
 * as they always did.
 */

export type SignedIn = Extract<SessionInfo, { signedIn: true }>

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "dev" }
  | { readonly status: "signed-in"; readonly info: SignedIn }
  /** No session. A share-link guest still gets in; anyone else sees the sign-in screen. */
  | { readonly status: "signed-out"; readonly problem?: string | undefined }

let state: SessionState = { status: "loading" }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<SessionState> | undefined

const RENEW_BEFORE_MS = 60_000
const RETRY_MS = 15_000

function set(next: SessionState) {
  state = next
  for (const l of listeners) l()
}

export const getSession = () => state

export function useSession(): SessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSession,
    getSession,
  )
}

/** One tab renews at a time; the others wait and then read the cookie it left. */
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  return locks ? locks.request("standard-artifacts:ticket", run) : run()
}

const post = (path: string, body?: unknown) =>
  fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

/** Read what a `/api/auth/*` answer says about the session. Throws a readable error for anything else. */
async function read(res: Response): Promise<SessionState> {
  const body: unknown = await res.json().catch(() => null)
  const info = body as SessionInfo | null
  if (info?.mode === "dev") return { status: "dev" }
  if (info?.mode === "live" && info.signedIn) return { status: "signed-in", info }
  if (info?.mode === "live") return { status: "signed-out", problem: info.problem }
  const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : undefined
  throw new Error(message ?? `Request failed (${res.status})`)
}

function schedule() {
  clearTimeout(timer)
  if (state.status !== "signed-in") return
  timer = setTimeout(() => void renew(), Math.max(5_000, state.info.expiresAt - Date.now() - RENEW_BEFORE_MS))
}

/** Apply a fresh answer. If the session now belongs to another org or person (another tab switched), this page starts over. */
function adopt(next: SessionState) {
  const prev = state
  if (prev.status === "signed-in" && next.status === "signed-in" && (prev.info.org.id !== next.info.org.id || prev.info.user.id !== next.info.user.id)) {
    window.location.reload()
    return
  }
  set(next)
  schedule()
}

/** Ask for a new ticket (deduplicated). Network trouble keeps the current one and tries again shortly. */
export function renew(): Promise<SessionState> {
  inflight ??= exclusive(() => post("/api/auth/ticket").then(read))
    .then(
      (next) => {
        adopt(next)
        return next
      },
      () => {
        clearTimeout(timer)
        timer = setTimeout(() => void renew(), RETRY_MS)
        return state
      },
    )
    .finally(() => (inflight = undefined))
  return inflight
}

/** The first look: dev, signed in, or not. */
export function startSession(): Promise<SessionState> {
  if (state.status !== "loading") return Promise.resolve(state)
  return renew().then((s) => (s.status === "loading" ? { status: "signed-out" as const } : s))
}

const valid = () => (state.status === "signed-in" && state.info.expiresAt - Date.now() > 5_000 ? state.info.ticket : undefined)

/** The ticket for the next request, renewed first if it's about to run out (a tab that slept). */
export async function ticket(): Promise<string | undefined> {
  if (state.status !== "signed-in") return undefined
  if (state.info.expiresAt - Date.now() < RENEW_BEFORE_MS / 2) await renew()
  return state.status === "signed-in" ? state.info.ticket : undefined
}

/** Headers for a plain fetch: the bearer ticket when there is one. */
export async function authHeaders(): Promise<Record<string, string>> {
  const t = await ticket()
  return t ? { authorization: `Bearer ${t}` } : {}
}

/** A socket address with the current ticket. Browsers can't set headers on sockets. */
export function withTicket(url: string): string {
  const t = valid()
  if (!t) {
    if (state.status === "signed-in") void renew()
    return url
  }
  const u = new URL(url)
  u.searchParams.set("ticket", t)
  return u.toString()
}

// Every room socket (boards, tables, docs, trackers) connects, and reconnects, with the current ticket.
authorizeRooms(withTicket)

if (typeof document !== "undefined") {
  // Timers don't run while a laptop sleeps: check when the page is looked at again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.status === "signed-in" && state.info.expiresAt - Date.now() < RENEW_BEFORE_MS) void renew()
  })
}

/** Send the browser to sign in (AuthKit), coming back to `returnTo`. */
export function signIn(options: { readonly returnTo?: string; readonly screen?: "sign-up"; readonly invitationToken?: string } = {}) {
  const q = new URLSearchParams()
  q.set("return_to", options.returnTo ?? `${window.location.pathname}${window.location.search}`)
  if (options.screen) q.set("screen", options.screen)
  if (options.invitationToken) q.set("invitation_token", options.invitationToken)
  window.location.assign(`/api/auth/login?${q}`)
}

const AFTER_SIGN_IN = "standard-artifacts:after-sign-in"

/**
 * "Not you?" on the consent page signs out all the way (AuthKit too), which
 * lands on the app's front page. Remember the consent page, so signing in
 * again from there goes straight back to it. Only consent pages qualify.
 */
export function rememberAfterSignIn(path: string) {
  try {
    if (/^\/authorize\?request=req_[\w-]+$/.test(path)) sessionStorage.setItem(AFTER_SIGN_IN, path)
  } catch {
    // storage blocked: they start again from their app
  }
}

/** Where to land after the next sign-in, once (see rememberAfterSignIn). */
export function takeAfterSignIn(): string | undefined {
  try {
    const path = sessionStorage.getItem(AFTER_SIGN_IN)
    sessionStorage.removeItem(AFTER_SIGN_IN)
    return path && /^\/authorize\?request=req_[\w-]+$/.test(path) ? path : undefined
  } catch {
    return undefined
  }
}

export async function signOut() {
  clearTimeout(timer)
  const res = await post("/api/auth/logout").catch(() => null)
  const body = (await res?.json().catch(() => null)) as { redirect?: string } | null
  window.location.assign(body?.redirect ?? "/")
}

export async function listOrgs(): Promise<ReadonlyArray<SessionOrgChoice>> {
  const res = await fetch("/api/auth/orgs", { credentials: "same-origin" })
  const body = (await res.json().catch(() => null)) as ReadonlyArray<SessionOrgChoice> | { message?: string } | null
  if (!res.ok || !Array.isArray(body)) throw new Error((body as { message?: string } | null)?.message ?? "Couldn't load your workspaces")
  return body
}

/** Re-scope the session to another org (or a new one), then start the app over in it. */
async function rescope(path: string, body: unknown) {
  const next = await exclusive(async () => read(await post(path, body)))
  if (next.status !== "signed-in") throw new Error("Your session ended. Sign in again.")
  window.location.assign("/")
}

export const switchOrg = (orgId: string) => rescope("/api/auth/switch", { orgId })
export const createOrg = (name: string) => rescope("/api/auth/orgs", { name })
