import type { Plan, Role } from "@standard-artifacts/protocol"

/**
 * The pieces of sign-in that don't talk to anything: sealing cookies, reading
 * WorkOS access tokens, mapping roles and ids, and checking config. Only type
 * imports, so tests load this file directly.
 *
 * Ids. A person's actor id is `usr_` plus their WorkOS user id without its
 * `user_` prefix (WorkOS `user_01HX…` is `usr_01HX…`), so it maps back. An
 * org's id is its WorkOS organization id (`org_01HX…`), which also names its
 * WorkspaceCell. Dev mode's `usr_dev` and `dev` can't collide with these.
 */

export const SESSION_COOKIE = "standard_artifacts_session"
/** The sign-in attempt in flight (state and where to land), for the length of one AuthKit round trip. */
export const STATE_COOKIE = "standard_artifacts_signin"
/** The short-lived ticket, for requests the app can't add a header to (`<img>` asset URLs). */
export const TICKET_COOKIE = "standard_artifacts_ticket"
/** The org this browser last worked in, to land there after the next sign-in. Not a secret. */
export const ORG_COOKIE = "standard_artifacts_org"

/** Session cookies last this long; WorkOS can end the session sooner (the refresh then fails). */
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30
export const STATE_MAX_AGE_S = 60 * 10
/** Tickets can't be revoked, so they're short. The web app asks for a new one a minute before. */
export const TICKET_TTL_S = 60 * 5
/** Refresh the WorkOS access token when it has less than this left. */
export const REFRESH_MARGIN_S = 60

/** What the session cookie holds, sealed. Kept small: a cookie has 4 KB. */
export interface Session {
  readonly v: 1
  readonly refreshToken: string
  /** WorkOS session id (the access token's `sid`), for signing out of AuthKit too. */
  readonly sessionId: string
  /** When the access token we last got expires (seconds). Its claims are what's below. */
  readonly accessExp: number
  readonly user: { readonly id: string; readonly name: string; readonly email: string; readonly avatarUrl: string | null }
  readonly org: { readonly id: string; readonly name: string; readonly plan: Plan }
  readonly role: Role
}

export interface SignInState {
  readonly state: string
  readonly returnTo: string
  readonly exp: number
}

// --- Ids ---------------------------------------------------------------------------------

export const userActorId = (workosUserId: string) => `usr_${workosUserId.replace(/^user_/, "")}`

/** The WorkOS user id behind an actor id, or undefined for ids that aren't from WorkOS (`usr_dev`). */
export function workosUserId(actorId: string): string | undefined {
  const rest = actorId.startsWith("usr_") ? actorId.slice(4) : ""
  return /^[0-9A-Z]{26}$/.test(rest) ? `user_${rest}` : undefined
}

// --- Roles -------------------------------------------------------------------------------

const rank: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 }

/**
 * Our role from WorkOS role slugs. The `owner`, `editor` and `viewer` slugs map
 * to themselves; WorkOS's defaults `admin` and `member` map to owner and editor.
 * Anything else counts as viewer, so an unknown role never grants edit access.
 * With several roles, the highest wins.
 */
export function roleFromSlugs(slugs: ReadonlyArray<string | null | undefined>): Role {
  let best: Role = "viewer"
  for (const slug of slugs) {
    const role = slugRoles[slug ?? ""]
    if (role && rank[role] > rank[best]) best = role
  }
  return best
}

const slugRoles: Record<string, Role> = { owner: "owner", admin: "owner", editor: "editor", member: "editor", viewer: "viewer" }

/**
 * The WorkOS slug to write for a role: ours if the environment has it, else
 * WorkOS's default (admin, member). `available` undefined means we couldn't
 * list roles, so ours is tried. Undefined when there's nothing to map to.
 */
export function slugForRole(role: Role, available: ReadonlySet<string> | undefined): string | undefined {
  if (!available || available.has(role)) return role
  const fallback = role === "owner" ? "admin" : role === "editor" ? "member" : undefined
  return fallback && available.has(fallback) ? fallback : undefined
}

export const higherRole = (a: Role, b: Role): Role => (rank[a] >= rank[b] ? a : b)

/** An agent acts for a person and never above editor (as hosted runs do). */
export const agentRole = (role: Role): Role => (role === "owner" ? "editor" : role)

// --- WorkOS access tokens ------------------------------------------------------------------

export interface AccessClaims {
  readonly sid: string
  readonly exp: number
  readonly orgId: string | undefined
  readonly roles: ReadonlyArray<string>
}

/**
 * The claims of a WorkOS access token. Not verified: we only read tokens that
 * WorkOS just handed us over TLS in answer to our API key, never ones from a
 * browser. (Verifying would need RS256, which celld can't do.)
 */
export function accessClaims(token: string): AccessClaims | undefined {
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(fromB64url(token.split(".")[1] ?? "")))
    if (typeof payload !== "object" || payload === null) return undefined
    const c = payload as Record<string, unknown>
    if (typeof c.sid !== "string" || typeof c.exp !== "number") return undefined
    const roles = Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === "string") : typeof c.role === "string" ? [c.role] : []
    return { sid: c.sid, exp: c.exp, orgId: typeof c.org_id === "string" ? c.org_id : undefined, roles }
  } catch {
    return undefined
  }
}

// --- Names ---------------------------------------------------------------------------------

export interface PersonName {
  readonly email: string
  readonly first_name?: string | null | undefined
  readonly last_name?: string | null | undefined
}

export function displayName(user: PersonName): string {
  const full = [user.first_name, user.last_name].map((s) => s?.trim()).filter(Boolean).join(" ")
  return (full || user.email.split("@")[0] || user.email).slice(0, 80)
}

/** The org made for someone signing in with none: "Ada's workspace". */
export function workspaceName(user: PersonName): string {
  const first = user.first_name?.trim() || user.email.split("@")[0] || "My"
  return `${first.slice(0, 60)}'s workspace`
}

// --- Config ----------------------------------------------------------------------------------

export interface SignInConfig {
  readonly AUTH_MODE?: string | undefined
  readonly TICKET_SECRET?: string | undefined
  readonly WORKOS_API_KEY?: string | undefined
  readonly WORKOS_CLIENT_ID?: string | undefined
  readonly WORKOS_COOKIE_PASSWORD?: string | undefined
  readonly APP_URL?: string | undefined
}

export const MIN_COOKIE_PASSWORD = 32

/**
 * Why live-mode sign-in can't work with this config, or undefined when it can.
 * Live mode never falls back to dev: the web app shows this instead of a sign-in button.
 */
export function signInProblem(config: SignInConfig): string | undefined {
  const missing = (["TICKET_SECRET", "WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"] as const).filter((k) => !config[k]?.trim())
  if (missing.length) return `Sign-in isn't configured on this server: set ${missing.join(", ")}.`
  if ((config.WORKOS_COOKIE_PASSWORD ?? "").length < MIN_COOKIE_PASSWORD) {
    return `WORKOS_COOKIE_PASSWORD must be at least ${MIN_COOKIE_PASSWORD} characters.`
  }
  if (config.APP_URL?.trim()) {
    try {
      const url = new URL(config.APP_URL)
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error()
    } catch {
      return "APP_URL must be the app's address, like https://app.example.com."
    }
  }
  return undefined
}

// --- Sealed cookies ----------------------------------------------------------------------------

/**
 * AES-256-GCM, with a key derived (HKDF-SHA256) from WORKOS_COOKIE_PASSWORD. Each
 * value names its purpose as associated data, so a sealed sign-in state can't be
 * replayed as a session. Format: `v1.<iv>.<ciphertext>`, base64url.
 */
export async function cookieKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("standard-artifacts"), info: new TextEncoder().encode("session cookie v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

export async function seal(key: CryptoKey, purpose: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(value))
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) }, key, data)
  return `v1.${toB64url(iv)}.${toB64url(new Uint8Array(sealed))}`
}

/** The value, or undefined if it wasn't sealed by us for this purpose (or is damaged). */
export async function unseal(key: CryptoKey, purpose: string, sealed: string | undefined): Promise<unknown> {
  const [version, iv, data] = sealed?.split(".") ?? []
  if (version !== "v1" || !iv || !data) return undefined
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: new TextEncoder().encode(purpose) }, key, fromB64url(data))
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    return undefined
  }
}

export function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false
  const s = v as Partial<Session>
  return (
    s.v === 1 &&
    typeof s.refreshToken === "string" &&
    typeof s.sessionId === "string" &&
    typeof s.accessExp === "number" &&
    typeof s.user?.id === "string" &&
    typeof s.org?.id === "string" &&
    (s.role === "owner" || s.role === "editor" || s.role === "viewer")
  )
}

export function isSignInState(v: unknown): v is SignInState {
  if (typeof v !== "object" || v === null) return false
  const s = v as Partial<SignInState>
  return typeof s.state === "string" && typeof s.returnTo === "string" && typeof s.exp === "number"
}

// --- Redirects and cookies --------------------------------------------------------------------

/**
 * Only a path on this app (`/boards/b_1`), never another site (`//evil.test`,
 * `https://…`, `/\evil`, `/%09/evil`). The path is resolved against the app's
 * origin and must stay on it; what comes back is just its path, query and hash.
 * Control characters and backslashes are refused outright: browsers strip or
 * reinterpret them, which is how `/\t/evil.test` becomes `//evil.test`.
 */
export function safeReturnTo(path: string | null | undefined, appOrigin = "https://app.invalid"): string {
  if (!path || !path.startsWith("/") || path.length > 1000 || /[\u0000-\u001f\u007f\\]/.test(path)) return "/"
  let url: URL
  let origin: string
  try {
    origin = new URL(appOrigin).origin
    url = new URL(path, origin)
  } catch {
    return "/"
  }
  if (url.origin !== origin) return "/"
  const local = `${url.pathname}${url.search}${url.hash}`
  // `/.//evil` resolves to the path `//evil`, which a browser reads as another host.
  if (!local.startsWith("/") || local.startsWith("//") || local.startsWith("/api/")) return "/"
  return local
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Cookies are Secure everywhere except over plain http to this machine (local testing), where browsers would drop them. */
const isSecure = (requestUrl: string) => {
  try {
    const url = new URL(requestUrl)
    return url.protocol === "https:" || !LOOPBACK.has(url.hostname)
  } catch {
    // Not an absolute URL: assume production, where cookies are Secure.
    return true
  }
}

/**
 * The name to use for a credential cookie (the session, the ticket). Where
 * cookies are Secure it carries the `__Host-` prefix, so the browser only
 * accepts it from this exact host, over https, for Path=/ and with no Domain:
 * a sibling subdomain can't plant or shadow it. Plain-http localhost keeps the
 * bare name, since browsers refuse `__Host-` cookies without Secure.
 */
export const cookieName = (requestUrl: string, name: string) => (isSecure(requestUrl) ? `__Host-${name}` : name)

/** A Set-Cookie value: HttpOnly, SameSite=Lax, Path=/, and Secure, except over plain http to this machine. */
export function setCookie(requestUrl: string, name: string, value: string, maxAge: number): string {
  const secure = isSecure(requestUrl) ? "; Secure" : ""
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

// --- Personal access tokens --------------------------------------------------------------------

/**
 * `sat_<hex(orgId)>_<secret>`: the org rides in the token so the Worker can find
 * its cell (hex, because base64url could contain the `_` separator); the 32
 * characters after it are the secret.
 */
export function newApiToken(orgId: string): string {
  const org = Array.from(new TextEncoder().encode(orgId), (b) => b.toString(16).padStart(2, "0")).join("")
  return `sat_${org}_${toB64url(crypto.getRandomValues(new Uint8Array(24)))}`
}

/** The org a token belongs to, or undefined if it isn't shaped like one. */
export function apiTokenOrg(token: string): string | undefined {
  const hex = /^sat_((?:[0-9a-f]{2}){1,64})_[A-Za-z0-9_-]{32}$/.exec(token)?.[1]
  if (!hex) return undefined
  const org = String.fromCharCode(...(hex.match(/../g) ?? []).map((h) => parseInt(h, 16)))
  return /^[\w-]{1,64}$/.test(org) ? org : undefined
}

/** Tokens are long and random, so a plain SHA-256 is the right hash (no salt or stretching needed). */
export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

export const randomState = () => toB64url(crypto.getRandomValues(new Uint8Array(24)))

// --- base64url -----------------------------------------------------------------------------------

export function toB64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
