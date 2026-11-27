import { DurableObject } from "cloudflare:workers"
import type { Env } from "../env"
import type { AuthMethod } from "../oauth"

/**
 * What the OAuth server keeps before anyone has picked an org (see oauth.ts):
 * the clients that registered, the consent requests waiting on the consent
 * page, and rate-limit counters. One instance (`OAuthCell.registry`) for the
 * whole deployment: registrations and sign-ins are rare next to MCP traffic,
 * which never comes here (grants and tokens live in each org's WorkspaceCell).
 *
 * Everything is synchronous SQL, so a consent request is taken exactly once
 * and a counter can't be raced past its limit.
 */

export interface RegisteredClient {
  readonly id: string
  /** SHA-256 of the secret, for clients that asked for one; null for public clients. */
  readonly secretHash: string | null
  readonly authMethod: AuthMethod
  readonly name: string | null
  readonly uri: string | null
  readonly logoUri: string | null
  readonly redirectUris: ReadonlyArray<string>
  /** Seconds. */
  readonly createdAt: number
}

/** An authorization request between /api/oauth/authorize and the consent page's answer. */
export interface ConsentRequest {
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string | null
  readonly challenge: string
  readonly resource: string
  /** The client's name, logo and home page, from its registration or metadata document. */
  readonly clientName: string | null
  readonly clientUri: string | null
  readonly logoUri: string | null
  readonly metadataDocument: boolean
  /** Seconds. */
  readonly expiresAt: number
}

type ClientRow = { id: string; secret_hash: string | null; auth_method: string; name: string | null; uri: string | null; logo_uri: string | null; redirect_uris: string; created_at: number }

export class OAuthCell extends DurableObject<Env> {
  /** The name of the one instance. */
  static readonly registry = "registry"

  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, secret_hash TEXT, auth_method TEXT NOT NULL, name TEXT, uri TEXT, logo_uri TEXT,
      redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER)`)
    this.sql.exec("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)")
    this.sql.exec("CREATE TABLE IF NOT EXISTS hits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)")
  }

  // --- Clients -----------------------------------------------------------------------------

  registerClient(client: RegisteredClient): void {
    this.sql.exec(
      "INSERT INTO clients (id, secret_hash, auth_method, name, uri, logo_uri, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      client.id, client.secretHash, client.authMethod, client.name, client.uri, client.logoUri, JSON.stringify(client.redirectUris), client.createdAt,
    )
  }

  client(id: string): RegisteredClient | null {
    const row = this.sql.exec<ClientRow>("SELECT * FROM clients WHERE id = ?", id).toArray()[0]
    if (!row) return null
    const now = Math.floor(Date.now() / 1000)
    this.sql.exec("UPDATE clients SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)", now, id, now - 3600)
    return {
      id: row.id,
      secretHash: row.secret_hash,
      authMethod: row.auth_method as AuthMethod,
      name: row.name,
      uri: row.uri,
      logoUri: row.logo_uri,
      redirectUris: JSON.parse(row.redirect_uris) as Array<string>,
      createdAt: row.created_at,
    }
  }

  // --- Consent requests --------------------------------------------------------------------

  putRequest(id: string, request: ConsentRequest): void {
    const now = Math.floor(Date.now() / 1000)
    this.sql.exec("DELETE FROM requests WHERE expires_at < ?", now)
    this.sql.exec("INSERT INTO requests (id, data, expires_at) VALUES (?, ?, ?)", id, JSON.stringify(request), request.expiresAt)
  }

  /** A waiting request, or null when it was answered or never existed. Expired ones come back too: the page says so. */
  request(id: string): ConsentRequest | null {
    const row = this.sql.exec<{ data: string }>("SELECT data FROM requests WHERE id = ?", id).toArray()[0]
    return row ? (JSON.parse(row.data) as ConsentRequest) : null
  }

  /** Answer a request: it's gone after this, so a consent can't be replayed. */
  takeRequest(id: string): ConsentRequest | null {
    const row = this.sql.exec<{ data: string }>("DELETE FROM requests WHERE id = ? RETURNING data", id).toArray()[0]
    return row ? (JSON.parse(row.data) as ConsentRequest) : null
  }

  // --- Rate limits -------------------------------------------------------------------------

  /** Count one hit on `key` in a fixed window. False once there have been `max` in the window. */
  hit(key: string, max: number, windowS: number): boolean {
    const now = Math.floor(Date.now() / 1000)
    const start = now - (now % windowS)
    const row = this.sql.exec<{ window_start: number; count: number }>("SELECT window_start, count FROM hits WHERE key = ?", key).toArray()[0]
    if (!row || row.window_start !== start) {
      this.sql.exec("INSERT OR REPLACE INTO hits (key, window_start, count) VALUES (?, ?, 1)", key, start)
      if (Math.random() < 0.01) this.sql.exec("DELETE FROM hits WHERE window_start < ?", start - 3600)
      return true
    }
    if (row.count >= max) return false
    this.sql.exec("UPDATE hits SET count = count + 1 WHERE key = ?", key)
    return true
  }

  /** Whether `key` has used up its `max` in the current window, without counting a hit. */
  blocked(key: string, max: number, windowS: number): boolean {
    const now = Math.floor(Date.now() / 1000)
    const row = this.sql.exec<{ window_start: number; count: number }>("SELECT window_start, count FROM hits WHERE key = ?", key).toArray()[0]
    return !!row && row.window_start === now - (now % windowS) && row.count >= max
  }
}
