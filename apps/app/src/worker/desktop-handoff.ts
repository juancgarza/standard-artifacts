/**
 * Signing in the desktop app (RFC 8252, with PKCE from RFC 7636).
 *
 * AuthKit can't run inside the app's window (Google refuses embedded browsers),
 * so the app signs in through the person's own browser and gets the session
 * back with a one-time code:
 *
 *   1. The app makes a random verifier, keeps it in memory, and opens
 *      `/api/auth/login?desktop=<challenge>` in the browser, where the challenge
 *      is base64url(SHA-256(verifier)).
 *   2. The challenge rides in AuthKit's `state` (`<random>.<challenge>`). The
 *      whole state is sealed in the sign-in cookie, so the callback only accepts
 *      the challenge the login started with.
 *   3. After the callback, instead of setting the browser's session cookie, the
 *      Worker seals the session and keeps it in the org's WorkspaceCell under a
 *      one-time code (60 seconds, single use, bound to the challenge), then shows
 *      a page that hands `stdartifacts://auth/callback?code=…` to the app.
 *   4. The app POSTs the code and its verifier to `/api/auth/desktop/exchange`
 *      from its own session, which sets the usual session cookie there.
 *
 * A code that another app on the machine catches (any app can claim a URL
 * scheme) is useless without the verifier, which never left the app.
 *
 * Why a row in a Durable Object rather than a sealed, self-contained code:
 * single use needs a strongly consistent record of spent codes anyway, and the
 * cell's synchronous SQL makes "take" atomic. It also keeps the link short and
 * opaque: no session material travels through the OS's URL handling, and the
 * cell stores only a hash of the code and the session sealed as the cookie is.
 *
 * Only type imports, so tests load this file directly.
 */

/** How long a code waits for the app. The browser hands it over at once; this only covers a slow click on the button. */
export const DESKTOP_CODE_TTL_S = 60

/** base64url(SHA-256(verifier)): 43 characters, no padding. */
export const isChallenge = (s: string | null | undefined): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s)

/** RFC 7636's code_verifier: 43 to 128 unreserved characters. */
export const isVerifier = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(s)

/** AuthKit's `state` for a desktop sign-in. Neither part can contain a dot. */
export const desktopState = (random: string, challenge: string) => `${random}.${challenge}`

/** The challenge a desktop sign-in's `state` carries, or undefined for a browser sign-in. Trust it only once the state matched the sealed cookie. */
export function challengeOfState(state: string): string | undefined {
  const [random, challenge, ...rest] = state.split(".")
  return random && rest.length === 0 && isChallenge(challenge) ? challenge : undefined
}

/** S256: base64url(SHA-256(verifier)). */
export async function challengeOf(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
}

// --- Codes ---------------------------------------------------------------------------------------

/** What waits behind a code: the session, sealed as its cookie, and where to land. */
export interface PendingCode {
  readonly challenge: string
  /** The session cookie's value, sealed by Accounts. */
  readonly sealed: string
  readonly returnTo: string
  /** Seconds since the epoch. */
  readonly expiresAt: number
}

/** Where an org's codes live. Taking a code removes it, so a code works once whatever happens next. */
export interface CodeStore {
  put(hash: string, pending: PendingCode): Promise<void>
  take(hash: string): Promise<PendingCode | null>
}

/** `sdc.<base64url(orgId)>.<secret>`: the org says which cell holds it (as share links do); the secret is 32 random bytes. */
export function newCode(orgId: string): string {
  return `sdc.${b64url(new TextEncoder().encode(orgId))}.${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
}

/** The org a code belongs to, or undefined if it isn't shaped like one. */
export function codeOrg(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined
  const m = /^sdc\.([A-Za-z0-9_-]{1,100})\.[A-Za-z0-9_-]{43}$/.exec(code)
  if (!m) return undefined
  try {
    const org = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromB64url(m[1]!))
    return /^[\w-]{1,64}$/.test(org) ? org : undefined
  } catch {
    return undefined
  }
}

/** Codes are kept hashed, so the cell's storage holds nothing that could be redeemed. */
export async function hashCode(code: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Mint a code for a session that just signed in. */
export async function issueCode(
  storeFor: (orgId: string) => CodeStore,
  input: { readonly orgId: string; readonly challenge: string; readonly sealed: string; readonly returnTo: string },
  nowS = Math.floor(Date.now() / 1000),
): Promise<string> {
  const code = newCode(input.orgId)
  await storeFor(input.orgId).put(await hashCode(code), { challenge: input.challenge, sealed: input.sealed, returnTo: input.returnTo, expiresAt: nowS + DESKTOP_CODE_TTL_S })
  return code
}

export type Redeemed =
  | { readonly ok: true; readonly orgId: string; readonly sealed: string; readonly returnTo: string }
  | { readonly ok: false; readonly reason: "malformed" | "unknown" | "expired" | "mismatch"; readonly message: string }

/**
 * Trade a code and its verifier for the sealed session. The code is spent
 * before anything is checked, so a wrong verifier burns it too: whoever
 * caught the link gets one guess, and the app signs in again.
 */
export async function redeemCode(storeFor: (orgId: string) => CodeStore, code: unknown, verifier: unknown, nowS = Math.floor(Date.now() / 1000)): Promise<Redeemed> {
  const orgId = codeOrg(code)
  if (!orgId || !isVerifier(verifier)) return { ok: false, reason: "malformed", message: "That sign-in code isn't valid." }
  const pending = await storeFor(orgId).take(await hashCode(code as string))
  if (!pending) return { ok: false, reason: "unknown", message: "That sign-in code isn't valid or was already used. Sign in again." }
  if (pending.expiresAt < nowS) return { ok: false, reason: "expired", message: "That sign-in code expired. Sign in again." }
  if ((await challengeOf(verifier)) !== pending.challenge) return { ok: false, reason: "mismatch", message: "That sign-in code was started by another app. Sign in again." }
  return { ok: true, orgId, sealed: pending.sealed, returnTo: pending.returnTo }
}

// --- The page that hands the code to the app -----------------------------------------------------

export const DESKTOP_SCHEME = "stdartifacts"

export const callbackLink = (code: string) => `${DESKTOP_SCHEME}://auth/callback?code=${encodeURIComponent(code)}`

/**
 * "Return to Standard Artifacts": opens the app's link at once (the browser
 * asks first), with a button for when it didn't. Nothing else on the page, and
 * nothing it loads, so the code can't leak through a referrer.
 */
export function returnPage(code: string): Response {
  const link = callbackLink(code)
  const attr = escapeHtml(link)
  const script = `location.href=${JSON.stringify(link).replace(/</g, "\\u003c")}`
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Return to Standard Artifacts</title><body style="font:15px/1.5 system-ui;margin:0;display:grid;place-items:center;height:100vh;color:#1f1f1d;background:#fff"><div style="max-width:380px;padding:16px;text-align:center"><h1 style="font-size:18px">You're signed in</h1><p style="color:#73736e">Return to the Standard Artifacts app to continue. You can close this tab afterwards.</p><p><a href="${attr}" style="display:inline-block;padding:8px 14px;border-radius:8px;background:#1f1f1d;color:#fff;text-decoration:none;font-weight:500">Return to Standard Artifacts</a></p></div><script>${script}</script>`
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  })
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// --- base64url (kept here so this file has no runtime imports) ------------------------------------

function b64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
