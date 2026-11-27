import { ACCESS_TOKEN_TTL_S, REFRESH_RETRY_GRACE_S, REFRESH_TOKEN_TTL_S, type Access } from "../oauth.ts"

/**
 * The OAuth grants of one org, kept in its WorkspaceCell's SQLite (see
 * oauth.ts for the protocol). A grant is one person letting one client act
 * for them in this org, with "write" or "read" access. Its codes and tokens
 * live beside it, by hash only.
 *
 * Why the org's cell: a grant is bound to one org from the moment it exists
 * (the consent page picks the org before a code is issued), access checks
 * already land here for `sat_` tokens, and revoking, listing and a member's
 * removal stay inside one strongly consistent store. Every method is
 * synchronous, so "take a code" and "rotate a refresh token" are atomic.
 *
 * Refresh tokens rotate: each one works once and is replaced. Presenting a
 * rotated token again means two parties hold it, so the whole grant is
 * revoked (reuse detection), with one exception: within a few seconds of the
 * rotation, before its replacement was ever used, the client is retrying a
 * refresh whose answer it never got. It gets a new pair, and the pair it
 * missed is retired (and would revoke the grant if it ever turned up).
 *
 * Only type imports at runtime (and constants from oauth.ts), so tests run it
 * on node:sqlite.
 */

type Value = ArrayBuffer | string | number | null

/** The part of SqlStorage this needs (node:sqlite stands in for it in tests). */
export interface Sql {
  exec<T extends Record<string, Value>>(query: string, ...bindings: Array<unknown>): { toArray(): Array<T> }
}

/** What a code carries from the consent page to the token request. */
export interface PendingCode {
  readonly clientId: string
  readonly clientName: string | null
  readonly clientUri: string | null
  readonly logoUri: string | null
  /** True when the client id is a metadata document URL (shared by every install of the app). */
  readonly metadataDocument: boolean
  readonly redirectUri: string
  readonly challenge: string
  readonly resource: string
  readonly userId: string
  readonly userName: string
  readonly agentName: string
  readonly access: Access
  /** The person's role when they approved. */
  readonly role: string
  /** Seconds since the epoch. */
  readonly expiresAt: number
}

export interface Grant {
  readonly id: string
  readonly userId: string
  readonly userName: string
  readonly clientId: string
  readonly clientName: string | null
  readonly clientUri: string | null
  readonly logoUri: string | null
  readonly redirectUri: string
  readonly agentName: string
  readonly access: Access
  /** The person's role as last checked with the account service, or "removed" once they left the org. */
  readonly role: string
  /** When the role was last checked (ms). */
  readonly checkedAt: number
  readonly resource: string
  /** Seconds. */
  readonly createdAt: number
  readonly lastUsedAt: number | null
}

type GrantRow = {
  id: string; user_id: string; user_name: string; client_id: string; client_name: string | null; client_uri: string | null; logo_uri: string | null
  redirect_uri: string; agent_name: string; access: string; role: string; checked_at: number; resource: string; created_at: number; last_used_at: number | null
}
type TokenRow = { hash: string; grant_id: string; kind: "access" | "refresh"; expires_at: number; created_at: number; rotated_at: number | null; replaced_by: string | null }
type CodeRow = { hash: string; data: string; expires_at: number; used_at: number | null; grant_id: string | null; replayed: number }

const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  clientId: r.client_id,
  clientName: r.client_name,
  clientUri: r.client_uri,
  logoUri: r.logo_uri,
  redirectUri: r.redirect_uri,
  agentName: r.agent_name,
  access: r.access === "read" ? "read" : "write",
  role: r.role,
  checkedAt: r.checked_at,
  resource: r.resource,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
})

export type Taken = { readonly ok: true; readonly code: PendingCode } | { readonly ok: false; readonly reason: "unknown" | "expired" | "used" }
export type Refreshed = { readonly ok: true; readonly grant: Grant } | { readonly ok: false; readonly reason: "unknown" | "expired" | "client" | "reused" }

/** Whether a grant can still be used: its newest refresh token hasn't expired. */
const LIVE = "EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.kind = 'refresh' AND t.rotated_at IS NULL AND t.expires_at > ?)"

export class GrantStore {
  private ready = false
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  private tables() {
    if (this.ready) return
    this.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_grants (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL, client_id TEXT NOT NULL, client_name TEXT, client_uri TEXT,
      logo_uri TEXT, redirect_uri TEXT NOT NULL, agent_name TEXT NOT NULL, access TEXT NOT NULL, role TEXT NOT NULL,
      checked_at INTEGER NOT NULL, resource TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_codes (
      hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, grant_id TEXT, replayed INTEGER NOT NULL DEFAULT 0)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_tokens (
      hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      rotated_at INTEGER, replaced_by TEXT)`)
    this.sql.exec("CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens (grant_id)")
    this.sql.exec("CREATE INDEX IF NOT EXISTS oauth_grants_user ON oauth_grants (user_id)")
    this.ready = true
  }

  private grant(id: string): Grant | null {
    const row = this.sql.exec<GrantRow>("SELECT * FROM oauth_grants WHERE id = ?", id).toArray()[0]
    return row ? toGrant(row) : null
  }

  /** Drop what can't be used anymore: expired codes and access tokens, and refresh tokens past their expiry. */
  private prune(now: number) {
    this.sql.exec("DELETE FROM oauth_codes WHERE expires_at < ?", now - 24 * 60 * 60)
    this.sql.exec("DELETE FROM oauth_tokens WHERE expires_at < ?", now - 60)
  }

  // --- Codes -------------------------------------------------------------------------------

  putCode(hash: string, code: PendingCode, now: number): void {
    this.tables()
    this.prune(now)
    this.sql.exec("INSERT INTO oauth_codes (hash, data, expires_at) VALUES (?, ?, ?)", hash, JSON.stringify(code), code.expiresAt)
  }

  /**
   * Spend a code. A code works once: a second try is a replay, which also
   * revokes the grant the first one made (RFC 6749 §4.1.2).
   */
  takeCode(hash: string, now: number): Taken {
    this.tables()
    const row = this.sql.exec<CodeRow>("SELECT * FROM oauth_codes WHERE hash = ?", hash).toArray()[0]
    if (!row) return { ok: false, reason: "unknown" }
    if (row.used_at !== null) {
      this.sql.exec("UPDATE oauth_codes SET replayed = 1 WHERE hash = ?", hash)
      if (row.grant_id) this.revokeGrant(row.grant_id)
      return { ok: false, reason: "used" }
    }
    this.sql.exec("UPDATE oauth_codes SET used_at = ? WHERE hash = ?", now, hash)
    if (row.expires_at < now) return { ok: false, reason: "expired" }
    return { ok: true, code: JSON.parse(row.data) as PendingCode }
  }

  /**
   * The grant behind a redeemed code, with its first tokens. A client
   * registered per install (not a metadata document) that connects again
   * replaces its earlier grant for this person, so "Connected agents" doesn't
   * fill up with the same app. Null if the code was replayed meanwhile.
   */
  createGrant(input: { readonly codeHash: string; readonly id: string; readonly code: PendingCode; readonly accessHash: string; readonly refreshHash: string; readonly now: number }): Grant | null {
    this.tables()
    const { code, now } = input
    const codeRow = this.sql.exec<CodeRow>("SELECT * FROM oauth_codes WHERE hash = ?", input.codeHash).toArray()[0]
    if (!codeRow || codeRow.replayed) return null
    if (!code.metadataDocument) {
      for (const old of this.sql.exec<{ id: string }>("SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ?", code.userId, code.clientId).toArray()) {
        this.revokeGrant(old.id)
      }
    }
    this.sql.exec(
      `INSERT INTO oauth_grants (id, user_id, user_name, client_id, client_name, client_uri, logo_uri, redirect_uri, agent_name, access, role, checked_at, resource, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, code.userId, code.userName, code.clientId, code.clientName, code.clientUri, code.logoUri, code.redirectUri, code.agentName, code.access,
      code.role, now * 1000, code.resource, now,
    )
    this.sql.exec("UPDATE oauth_codes SET grant_id = ? WHERE hash = ?", input.id, input.codeHash)
    this.issue(input.id, input.accessHash, input.refreshHash, now)
    return this.grant(input.id)
  }

  private issue(grantId: string, accessHash: string, refreshHash: string, now: number) {
    this.sql.exec("INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, 'access', ?, ?)", accessHash, grantId, now + ACCESS_TOKEN_TTL_S, now)
    this.sql.exec("INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, 'refresh', ?, ?)", refreshHash, grantId, now + REFRESH_TOKEN_TTL_S, now)
  }

  // --- Tokens ------------------------------------------------------------------------------

  /** An access token's grant, or null when it's unknown, expired or revoked. Notes when the grant was last used, to the minute. */
  resolveAccess(hash: string, now: number): { readonly grant: Grant; readonly expiresAt: number } | null {
    this.tables()
    const token = this.sql.exec<TokenRow>("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'access'", hash).toArray()[0]
    if (!token || token.expires_at <= now) return null
    const grant = this.grant(token.grant_id)
    if (!grant) return null
    if (grant.lastUsedAt === null || now - grant.lastUsedAt >= 60) {
      this.sql.exec("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?", now, grant.id)
    }
    return { grant: { ...grant, lastUsedAt: now }, expiresAt: token.expires_at }
  }

  /** Trade a refresh token for a new pair (see the class comment for rotation and reuse). */
  refresh(hash: string, clientId: string, next: { readonly accessHash: string; readonly refreshHash: string }, now: number): Refreshed {
    this.tables()
    const token = this.sql.exec<TokenRow>("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'", hash).toArray()[0]
    if (!token) return { ok: false, reason: "unknown" }
    const grant = this.grant(token.grant_id)
    if (!grant) return { ok: false, reason: "unknown" }
    if (grant.clientId !== clientId) return { ok: false, reason: "client" }
    if (token.rotated_at !== null) {
      const child = token.replaced_by ? this.sql.exec<TokenRow>("SELECT * FROM oauth_tokens WHERE hash = ?", token.replaced_by).toArray()[0] : undefined
      const retry = now - token.rotated_at <= REFRESH_RETRY_GRACE_S && child !== undefined && child.rotated_at === null
      if (!retry) {
        this.revokeGrant(grant.id)
        return { ok: false, reason: "reused" }
      }
      // The client never got the pair we made: retire it (it counts as reuse if it ever turns up) and its access token.
      this.sql.exec("UPDATE oauth_tokens SET rotated_at = ? WHERE hash = ?", now - REFRESH_RETRY_GRACE_S - 1, child.hash)
      this.sql.exec("DELETE FROM oauth_tokens WHERE grant_id = ? AND kind = 'access' AND created_at >= ?", grant.id, token.rotated_at)
    } else if (token.expires_at <= now) {
      return { ok: false, reason: "expired" }
    }
    this.sql.exec("UPDATE oauth_tokens SET rotated_at = ?, replaced_by = ? WHERE hash = ?", now, next.refreshHash, hash)
    this.issue(grant.id, next.accessHash, next.refreshHash, now)
    this.prune(now)
    return { ok: true, grant }
  }

  /** Revoke the grant a token belongs to (RFC 7009: revoking either token ends the grant). */
  revokeToken(hash: string): boolean {
    this.tables()
    const token = this.sql.exec<TokenRow>("SELECT * FROM oauth_tokens WHERE hash = ?", hash).toArray()[0]
    return token ? this.revokeGrant(token.grant_id) : false
  }

  revokeGrant(id: string): boolean {
    this.tables()
    this.sql.exec("DELETE FROM oauth_tokens WHERE grant_id = ?", id)
    return this.sql.exec("DELETE FROM oauth_grants WHERE id = ? RETURNING id", id).toArray().length > 0
  }

  // --- People ------------------------------------------------------------------------------

  /** The account service confirmed a person's role (or that they left: "removed"). Their grants act with it until the next check. */
  roleChecked(userId: string, role: string, nowMs: number): void {
    this.tables()
    this.sql.exec("UPDATE oauth_grants SET role = ?, checked_at = ? WHERE user_id = ?", role, nowMs, userId)
  }

  /** Live grants: everyone's (for owners) or one person's. Newest first. */
  list(userId: string | null, now: number): Array<Grant> {
    this.tables()
    const rows = userId
      ? this.sql.exec<GrantRow>(`SELECT * FROM oauth_grants g WHERE g.user_id = ? AND ${LIVE} ORDER BY g.created_at DESC`, userId, now).toArray()
      : this.sql.exec<GrantRow>(`SELECT * FROM oauth_grants g WHERE ${LIVE} ORDER BY g.created_at DESC`, now).toArray()
    return rows.map(toGrant)
  }

  get(id: string): Grant | null {
    this.tables()
    return this.grant(id)
  }
}
