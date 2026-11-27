/**
 * Sign-in for remote MCP clients (Claude, ChatGPT, Codex, Cursor, VS Code…):
 * a small OAuth 2.1 authorization server in the Worker, following the MCP
 * authorization spec. WorkOS stays the identity provider; this server owns
 * the consent screen and the grants.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728: /mcp and who signs in for it
 *   GET  /.well-known/oauth-authorization-server       RFC 8414: the endpoints below
 *   POST /api/oauth/register    RFC 7591 dynamic client registration
 *   GET  /api/oauth/authorize   → the consent page (/authorize), after sign-in
 *   POST /api/oauth/token       authorization_code (PKCE S256) and refresh_token
 *   POST /api/oauth/revoke      RFC 7009
 *   GET  /mcp/whoami            who a token acts as
 *
 * Clients either register (a short `cl_…` id) or name themselves with an
 * https URL that serves their metadata (a Client ID Metadata Document).
 * Tokens are opaque, bound to the `/mcp` resource (RFC 8707), and kept only
 * as hashes. A grant belongs to one person in one org, with "read and write"
 * or "read only" access, and every request checks it again.
 *
 * Design borrowed from Executor (https://executor.sh, MIT, (c) Useful Software Co):
 * grants bound to one organization with an access choice, loopback redirects
 * for native clients, a 401 vs 403 split, and `/mcp/whoami`.
 *
 * This file holds the parts that don't talk to anything: PKCE, redirect URIs,
 * client metadata, token formats and the consent screen's warnings. No
 * runtime imports, so tests load it directly.
 */

/** Access tokens are short: a revoked grant also stops at once, but a stolen token is worth little. */
export const ACCESS_TOKEN_TTL_S = 60 * 60
/** A refresh token lasts this long from when it's issued; each refresh issues a new one (rotation). */
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60
/** A just-rotated refresh token may be presented again this soon (the client never got our answer). */
export const REFRESH_RETRY_GRACE_S = 30
/** An authorization code waits this long for the client to redeem it. */
export const CODE_TTL_S = 5 * 60
/** How long the consent page waits for an answer. */
export const REQUEST_TTL_S = 15 * 60

/** The one scope: this server's tools. `offline_access` is accepted and implied (refresh tokens always come). */
export const SCOPE = "mcp"

/** Rate limits, per caller IP. Generous: hosted clients (Claude.ai, ChatGPT) share a few IPs across all their users. */
export const LIMITS = {
  register: { max: 60, windowS: 60 },
  authorize: { max: 120, windowS: 60 },
  token: { max: 600, windowS: 60 },
  /** Failed token requests: a wrong code, verifier or refresh token. */
  tokenFailures: { max: 60, windowS: 60 },
} as const

export type Access = "write" | "read"

// --- PKCE (RFC 7636, S256 only) --------------------------------------------------------------

/** base64url(SHA-256(verifier)): 43 characters, no padding. */
export const isChallenge = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s)

/** RFC 7636's code_verifier: 43 to 128 unreserved characters. */
export const isVerifier = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(s)

export async function s256(verifier: string): Promise<string> {
  return toB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
}

/** Whether `verifier` is the one behind `challenge`. Constant-time on the digests. */
export async function verifyPkce(verifier: unknown, challenge: string): Promise<boolean> {
  if (!isVerifier(verifier) || !isChallenge(challenge)) return false
  return timingSafeEqual(await s256(verifier), challenge)
}

// --- Redirect URIs ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])

/** Schemes an app may never ask us to send a browser to. */
const UNSAFE_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "about", "blob", "filesystem", "view-source", "ftp", "ws", "wss", "mailto", "tel", "sms"])

export type RedirectKind =
  /** An https page: a hosted client (Claude.ai, ChatGPT) or a web app. */
  | "web"
  /** http://127.0.0.1:<any port>/…: a native client listening on this computer (RFC 8252 §7.3). */
  | "loopback"
  /** A private-use scheme (`cursor://…`, `vscode://…`): an installed app (RFC 8252 §7.1). */
  | "app"

export type RedirectCheck = { readonly ok: true; readonly kind: RedirectKind; readonly url: URL } | { readonly ok: false; readonly reason: string }

/**
 * Whether a client may register this redirect URI: https anywhere, plain http
 * only to this computer, or an app's own scheme. Never a fragment, credentials,
 * or a scheme that runs code in the page.
 */
export function checkRedirectUri(uri: unknown): RedirectCheck {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2000) return { ok: false, reason: "A redirect URI must be a URL of up to 2000 characters." }
  if (/[\u0000- \u007f\\]/.test(uri)) return { ok: false, reason: "A redirect URI can't contain spaces, control characters or backslashes." }
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return { ok: false, reason: `${uri} isn't a URL.` }
  }
  if (url.hash || uri.includes("#")) return { ok: false, reason: "A redirect URI can't have a fragment (#…)." }
  if (url.username || url.password) return { ok: false, reason: "A redirect URI can't carry a user name or password." }
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if (scheme === "https") return url.hostname ? { ok: true, kind: "web", url } : { ok: false, reason: "An https redirect URI needs a host." }
  if (scheme === "http") {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? { ok: true, kind: "loopback", url }
      : { ok: false, reason: "Plain http redirect URIs must point at this computer (127.0.0.1, [::1] or localhost). Use https." }
  }
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || UNSAFE_SCHEMES.has(scheme)) return { ok: false, reason: `${scheme}: isn't allowed as a redirect URI.` }
  return { ok: true, kind: "app", url }
}

export const isLoopbackRedirect = (uri: string) => {
  const c = checkRedirectUri(uri)
  return c.ok && c.kind === "loopback"
}

/**
 * Whether `requested` is one of the client's redirect URIs: exactly, or, for
 * a loopback URI, the same address and path on any port (native apps pick a
 * free port each time, RFC 8252 §7.3). `localhost` and `127.0.0.1` don't stand
 * in for each other.
 */
export function redirectMatches(registered: ReadonlyArray<string>, requested: string): boolean {
  if (registered.includes(requested)) return true
  const asked = checkRedirectUri(requested)
  if (!asked.ok || asked.kind !== "loopback") return false
  const key = (u: URL) => `${u.protocol}//${u.hostname}${u.pathname}${u.search}`
  return registered.some((r) => {
    const c = checkRedirectUri(r)
    return c.ok && c.kind === "loopback" && key(c.url) === key(asked.url)
  })
}

/** The redirect with the answer added (`code` and `state`, or `error`), plus `iss` (RFC 9207). */
export function withParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return url.toString()
}

// --- Client metadata (RFC 7591 registration, and Client ID Metadata Documents) ---------------

export type AuthMethod = "none" | "client_secret_post" | "client_secret_basic"

export interface ClientMetadata {
  readonly name: string | null
  readonly uri: string | null
  readonly logoUri: string | null
  readonly redirectUris: ReadonlyArray<string>
  readonly authMethod: AuthMethod
}

export type MetadataCheck = { readonly ok: true; readonly value: ClientMetadata } | { readonly ok: false; readonly error: "invalid_redirect_uri" | "invalid_client_metadata"; readonly description: string }

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null)
const httpsUrl = (v: unknown) => {
  if (typeof v !== "string" || v.length > 2000) return null
  try {
    const u = new URL(v)
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null
  } catch {
    return null
  }
}

/**
 * A client's metadata, as registered or as its metadata document says. Only
 * what we use is kept; names are trimmed, and logos and home pages must be
 * https (others are dropped, not refused).
 */
export function checkClientMetadata(body: unknown, options: { readonly document?: boolean } = {}): MetadataCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "invalid_client_metadata", description: "Send the client's metadata as a JSON object." }
  const m = body as Record<string, unknown>
  const uris = m.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0) return { ok: false, error: "invalid_redirect_uri", description: "List at least one redirect URI in redirect_uris." }
  if (uris.length > 10) return { ok: false, error: "invalid_redirect_uri", description: "At most 10 redirect URIs." }
  for (const uri of uris) {
    const c = checkRedirectUri(uri)
    if (!c.ok) return { ok: false, error: "invalid_redirect_uri", description: c.reason }
  }
  const grantTypes = m.grant_types ?? ["authorization_code"]
  if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code") || grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return { ok: false, error: "invalid_client_metadata", description: "grant_types may only be authorization_code and refresh_token." }
  }
  const responseTypes = m.response_types ?? ["code"]
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== "code")) return { ok: false, error: "invalid_client_metadata", description: "response_types may only be code." }
  const method = m.token_endpoint_auth_method ?? "none"
  // A metadata document is public, so its client can't have a secret.
  const allowed: ReadonlyArray<unknown> = options.document ? ["none"] : ["none", "client_secret_post", "client_secret_basic"]
  if (!allowed.includes(method)) {
    return { ok: false, error: "invalid_client_metadata", description: `token_endpoint_auth_method must be one of ${allowed.join(", ")}.` }
  }
  return {
    ok: true,
    value: { name: text(m.client_name, 80), uri: httpsUrl(m.client_uri), logoUri: httpsUrl(m.logo_uri), redirectUris: uris as Array<string>, authMethod: method as AuthMethod },
  }
}

/** Registered client ids: `cl_` and 24 random characters. Anything with `://` is a metadata document URL. */
export const isRegisteredClientId = (id: string) => /^cl_[A-Za-z0-9_-]{24}$/.test(id)
export const newClientId = () => `cl_${toB64url(crypto.getRandomValues(new Uint8Array(18)))}`
export const newClientSecret = () => `scs_${toB64url(crypto.getRandomValues(new Uint8Array(32)))}`

// --- Client ID Metadata Documents --------------------------------------------------------------

/**
 * Why this client_id can't be a metadata document URL, or undefined when it
 * can be fetched: https on the default port, a real public host name (no IP
 * addresses, no `localhost` or internal names), a path, and nothing else.
 * The fetch itself follows no redirects, so the host checked is the host asked.
 */
export function metadataUrlProblem(clientId: string): string | undefined {
  if (clientId.length > 1000) return "That client id is too long."
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return "That client id isn't a registered client or a URL."
  }
  if (url.protocol !== "https:") return "A client id URL must use https."
  if (url.username || url.password || url.hash) return "A client id URL can't carry credentials or a fragment."
  if (url.port && url.port !== "443") return "A client id URL must use the standard https port."
  if (url.pathname === "/" || url.pathname === "") return "A client id URL must have a path."
  if (url.pathname.split("/").some((s) => s === "." || s === "..")) return "A client id URL can't contain . or .. segments."
  if (isPrivateHost(url.hostname)) return "A client id URL must be on a public host."
  return undefined
}

/**
 * Hosts a server-side fetch must not reach: IP literals (all of them: a
 * metadata document has a name), loopback and link-local names, single-label
 * and internal names. DNS can still point a public name at a private address;
 * on Cloudflare the Worker's fetch can't reach private networks anyway.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "")
  if (!h || h.startsWith("[") || /^[\d.]+$/.test(h) || /^0x/i.test(h)) return true
  if (!h.includes(".")) return true
  return /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa|test|invalid|example)$/.test(h)
}

export type DocumentResult = { readonly ok: true; readonly value: ClientMetadata } | { readonly ok: false; readonly reason: string }

/**
 * Fetch and check a client's metadata document: no redirects, a time limit,
 * a size limit, JSON, and its `client_id` must be the URL it came from.
 */
export async function fetchMetadataDocument(
  clientId: string,
  fetcher: typeof fetch = fetch,
  limits: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
): Promise<DocumentResult> {
  const problem = metadataUrlProblem(clientId)
  if (problem) return { ok: false, reason: problem }
  const maxBytes = limits.maxBytes ?? 16 * 1024
  let res: Response
  try {
    res = await fetcher(clientId, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(limits.timeoutMs ?? 5000) })
  } catch {
    return { ok: false, reason: "The app's metadata didn't load in time." }
  }
  if (res.status !== 200) return { ok: false, reason: `The app's metadata answered ${res.status}.` }
  const declared = Number(res.headers.get("content-length") ?? "0")
  if (declared > maxBytes) return { ok: false, reason: "The app's metadata is too large." }
  const body = await readLimited(res, maxBytes)
  if (body === undefined) return { ok: false, reason: "The app's metadata is too large." }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, reason: "The app's metadata isn't JSON." }
  }
  if (typeof json !== "object" || json === null || (json as Record<string, unknown>).client_id !== clientId) {
    return { ok: false, reason: "The app's metadata names a different client_id." }
  }
  const checked = checkClientMetadata(json, { document: true })
  return checked.ok ? checked : { ok: false, reason: checked.description }
}

async function readLimited(res: Response, maxBytes: number): Promise<string | undefined> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

// --- What the consent page says about a client -------------------------------------------------

/** Hosts we know belong to the apps people connect. Only used to soften or sharpen the consent page's wording. */
const KNOWN_HOSTS: ReadonlyArray<{ readonly host: string; readonly owner: "anthropic" | "openai" | "microsoft" | "cursor" }> = [
  { host: "claude.ai", owner: "anthropic" },
  { host: "claude.com", owner: "anthropic" },
  { host: "anthropic.com", owner: "anthropic" },
  { host: "chatgpt.com", owner: "openai" },
  { host: "openai.com", owner: "openai" },
  { host: "vscode.dev", owner: "microsoft" },
  { host: "cursor.com", owner: "cursor" },
]

const ownerOfHost = (host: string) => KNOWN_HOSTS.find((k) => host === k.host || host.endsWith(`.${k.host}`))?.owner

/** Which company a client's name claims to be from, if it names a well-known app. */
function claimedOwner(name: string): "anthropic" | "openai" | "microsoft" | "cursor" | undefined {
  const n = name.toLowerCase()
  if (/claude|anthropic/.test(n)) return "anthropic"
  if (/chatgpt|openai|codex/.test(n)) return "openai"
  if (/vs ?code|visual studio/.test(n)) return "microsoft"
  if (/cursor/.test(n)) return "cursor"
  return undefined
}

export interface RedirectSummary {
  readonly kind: RedirectKind
  /** What to show: the host for a web redirect, the scheme for an app. */
  readonly host: string
  /** Whether we know who's on the other end: a known host, this computer, or the host that published the metadata. */
  readonly verified: boolean
  /** A sentence to show above the buttons, when something looks off. */
  readonly warning: string | null
}

/**
 * What the consent page says about where the answer goes. A loopback
 * redirect is an app on this computer. A web redirect is checked against
 * the hosts we know, and against the host that published the client's
 * metadata. An app that names itself after Claude or ChatGPT but sends you
 * elsewhere gets a pointed warning.
 */
export function summarizeRedirect(input: { readonly clientName: string | null; readonly redirectUri: string; readonly metadataUrl?: string | undefined }): RedirectSummary {
  const check = checkRedirectUri(input.redirectUri)
  if (!check.ok) return { kind: "web", host: input.redirectUri, verified: false, warning: "This app's return address looks wrong. Don't approve it." }
  const claimed = input.clientName ? claimedOwner(input.clientName) : undefined
  if (check.kind === "loopback") return { kind: "loopback", host: "this computer", verified: true, warning: null }
  if (check.kind === "app") {
    const scheme = check.url.protocol.slice(0, -1)
    return { kind: "app", host: `${scheme}://`, verified: false, warning: null }
  }
  const host = check.url.hostname.toLowerCase()
  const owner = ownerOfHost(host)
  const published = input.metadataUrl ? new URL(input.metadataUrl).hostname.toLowerCase() : undefined
  const verified = owner !== undefined || (published !== undefined && (host === published || host.endsWith(`.${published}`)))
  if (claimed && owner !== claimed) {
    return { kind: "web", host, verified: false, warning: `This app calls itself ${input.clientName}, but it would send you to ${host}. Only approve it if you set it up yourself.` }
  }
  if (published && !verified) return { kind: "web", host, verified: false, warning: `This app is published by ${published} but sends you to ${host}. Only approve it if you trust both.` }
  if (!verified) return { kind: "web", host, verified: false, warning: `We haven't verified ${host}. Only approve it if you trust it.` }
  return { kind: "web", host, verified: true, warning: null }
}

/**
 * The agent a client acts as in the workspace, as people see it ("Claude via
 * Ada"): the well-known apps by their usual names, anything else by its own
 * name. Clients often add the server's name ("Claude Code (stdartifacts)").
 */
export function agentNameOf(clientName: string | null | undefined): string {
  const raw = (clientName ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim()
  const n = raw.toLowerCase()
  if (n.includes("claude code") || n.includes("claude-code")) return "Claude Code"
  if (n.includes("claude") || n.includes("anthropic")) return "Claude"
  if (n.includes("chatgpt") || n.includes("openai")) return n.includes("codex") ? "Codex" : "ChatGPT"
  if (n.includes("codex")) return "Codex"
  if (n.includes("cursor")) return "Cursor"
  if (/vs ?code|visual studio code/.test(n)) return "VS Code"
  return raw.slice(0, 40) || "Agent"
}

export const agentIdOf = (name: string) => `agt_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent"}`

// --- Resource (RFC 8707) ----------------------------------------------------------------------

/** The one resource tokens are for: this server's /mcp. */
export const mcpResource = (origin: string) => `${origin}/mcp`

/**
 * Whether a `resource` parameter names /mcp on this server. Absent is fine
 * (RFC 8707 makes it optional; the token is still for /mcp). A trailing
 * slash is tolerated; anything else is another resource.
 */
export function resourceMatches(resource: string | null | undefined, origin: string): boolean {
  if (resource === null || resource === undefined || resource === "") return true
  return resource === mcpResource(origin) || resource === `${mcpResource(origin)}/`
}

// --- Token formats -------------------------------------------------------------------------------

/**
 * `<prefix>_<hex(orgId)>_<secret>`, as access tokens (`sat_`) are: the org
 * says which WorkspaceCell holds the grant; the 32 characters after it are the
 * secret. `sac_` codes, `sao_` access tokens, `sar_` refresh tokens.
 */
export type SecretKind = "code" | "access" | "refresh"
const PREFIX: Record<SecretKind, string> = { code: "sac", access: "sao", refresh: "sar" }

export function newSecret(kind: SecretKind, orgId: string): string {
  const org = Array.from(new TextEncoder().encode(orgId), (b) => b.toString(16).padStart(2, "0")).join("")
  return `${PREFIX[kind]}_${org}_${toB64url(crypto.getRandomValues(new Uint8Array(24)))}`
}

/** The org a code or token belongs to, or undefined if it isn't one of this kind. */
export function secretOrg(kind: SecretKind, token: unknown): string | undefined {
  if (typeof token !== "string") return undefined
  const hex = new RegExp(`^${PREFIX[kind]}_((?:[0-9a-f]{2}){1,64})_[A-Za-z0-9_-]{32}$`).exec(token)?.[1]
  if (!hex) return undefined
  const org = String.fromCharCode(...(hex.match(/../g) ?? []).map((h) => parseInt(h, 16)))
  return /^[\w-]{1,64}$/.test(org) ? org : undefined
}

export const kindOfSecret = (token: string): SecretKind | undefined =>
  token.startsWith("sao_") ? "access" : token.startsWith("sar_") ? "refresh" : token.startsWith("sac_") ? "code" : undefined

/** Long random secrets, so a plain SHA-256 is the right hash. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Consent requests waiting on the consent page: `req_` and 24 random characters. */
export const newRequestId = () => `req_${toB64url(crypto.getRandomValues(new Uint8Array(18)))}`
export const isRequestId = (s: unknown): s is string => typeof s === "string" && /^req_[A-Za-z0-9_-]{24}$/.test(s)

// --- Small helpers -------------------------------------------------------------------------------

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function toB64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** `Authorization: Basic base64(client_id:client_secret)` (RFC 6749 §2.3.1: each part form-encoded first). */
export function basicCredentials(header: string | null | undefined): { readonly id: string; readonly secret: string } | undefined {
  if (!header?.startsWith("Basic ")) return undefined
  try {
    const decoded = atob(header.slice(6).trim())
    const colon = decoded.indexOf(":")
    if (colon < 0) return undefined
    return { id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " ")), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " ")) }
  } catch {
    return undefined
  }
}
