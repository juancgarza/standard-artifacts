import { DurableObject } from "cloudflare:workers"
import { Result, Schema } from "effect"
import {
  ClientMessage,
  Principal,
  actorKey,
  actorName,
  canEdit,
  colorFor,
  kindOfId,
  mentionsAdded,
  mentionsEdited,
  type Actor,
  type Member,
  searchItems,
  type Presence,
  type ServerMessage,
} from "@standard-artifacts/protocol"
import type { Env } from "../env"
import { contentHash, deleteArtifact, searchConfig, writeBatchSize, writeItems, type IndexItem } from "../search-index"

export type ApplyOutcome = { ok: true; applied: number; seq: number } | { ok: false; error: string; applied: number }
export type PresenceOutcome = { ok: true } | { ok: false; error: string }
export type OpResult<S> = { ok: true; state: S } | { ok: false; error: string }
export type ParseResult<O> = { ok: true; op: O } | { ok: false; error: string }

/** Header the Worker uses to hand the verified principal to a cell. Never trusted from clients. */
export const PRINCIPAL_HEADER = "x-standard-artifacts-principal"
/** Header carrying the artifact id, so a cell knows which artifact it is (for filing mentions). */
export const ARTIFACT_HEADER = "x-standard-artifacts-artifact"

type AgentRow = { connection_id: string; member: string; expires_at: number }

/** How long edits gather before they're indexed: one embedding and write per burst, not per keystroke. */
const INDEX_DELAY_MS = 15_000
/** A failing index retries at 30s, 1m, 2m… up to an hour; content is never lost, since each flush diffs the whole state. */
const indexRetryDelay = (attempts: number) => Math.min(30_000 * 2 ** attempts, 3_600_000)
/** How often a busy cell tells the workspace it changed. Home and the sidebar catch up this far behind the edit. */
const CHANGE_DELAY_MS = 2000
const CHANGE_RETRY_MS = 10_000

/**
 * Base class for every surface's cell (table, board, doc).
 *
 * - One authoritative state per cell, changed only by `commit`, which applies
 *   an op, persists it, appends it to the op log with its actor, and fans it out.
 * - People connect over hibernatable WebSockets. Read-only members (viewers,
 *   guests) still get presence; their ops are rejected.
 * - Agents don't hold sockets. They post ops and presence over RPC, and their
 *   presence carries a TTL so a crashed run disappears instead of lingering.
 *   Alarms sweep expired agents (celld has alarms, not cron).
 * - Search: commits mark the cell dirty, and an alarm sends what changed to the
 *   workspace's search index (see flushIndex).
 * - Home: commits also tell the workspace the artifact changed, at most every
 *   CHANGE_DELAY_MS (see flushChanged), so its "last updated" stays true.
 */
export abstract class RoomCell<S, O> extends DurableObject<Env> {
  protected sql: SqlStorage
  private cached: S | undefined
  private destroyed = false

  protected abstract parseOp(raw: unknown): ParseResult<O>
  protected abstract applyOp(state: S, op: O, by: string): OpResult<S>
  /** Load state from SQLite (runs after each wake from hibernation). */
  protected abstract load(): S
  /** Write the effect of `op` to SQLite. Called after applyOp succeeds. */
  protected abstract persist(op: O, after: S, by: string): void

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room_ops (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, op TEXT NOT NULL, at TEXT NOT NULL)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room_agents (
      connection_id TEXT PRIMARY KEY, member TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
    this.sql.exec("CREATE TABLE IF NOT EXISTS room_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    this.sql.exec("CREATE TABLE IF NOT EXISTS search_index (item TEXT PRIMARY KEY, hash TEXT NOT NULL)")
  }

  private meta(key: string): string | undefined {
    return this.sql.exec<{ value: string }>("SELECT value FROM room_meta WHERE key = ?", key).toArray()[0]?.value
  }

  private setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec("DELETE FROM room_meta WHERE key = ?", key)
    else this.sql.exec("INSERT INTO room_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
  }

  /** Remember which org and artifact this cell is (the Worker tells us on every call). */
  private identify(orgId: string, artifactId: string | null) {
    if (!artifactId) return
    this.sql.exec("INSERT INTO room_meta (key, value) VALUES ('org', ?), ('artifact', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", orgId, artifactId)
  }

  private identity(): { orgId: string; artifactId: string } | null {
    const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM room_meta").toArray()
    const org = rows.find((r) => r.key === "org")?.value
    const artifact = rows.find((r) => r.key === "artifact")?.value
    return org && artifact ? { orgId: org, artifactId: artifact } : null
  }

  /**
   * A person's edit that adds "@claude" files a mention in the org's inbox;
   * edits to an already-queued mention keep its text current. Agents never file.
   */
  private fileMentions(before: S, after: S, actor: Actor) {
    if (actor.type !== "user") return
    const id = this.identity()
    const kind = id && kindOfId(id.artifactId)
    if (!id || !kind) return
    const added = mentionsAdded(kind, before, after)
    const addedKeys = new Set(added.map((h) => JSON.stringify(h.target)))
    const edited = mentionsEdited(kind, before, after).filter((h) => !addedKeys.has(JSON.stringify(h.target)))
    if (!added.length && !edited.length) return
    const inbox = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(id.orgId))
    const base = { artifactId: id.artifactId, kind, requestedBy: actorKey(actor), requestedByName: actorName(actor) }
    this.ctx.waitUntil(
      Promise.all([
        ...added.map((h) => inbox.fileMention({ ...base, target: h.target, text: h.text, isNew: true })),
        ...edited.map((h) => inbox.fileMention({ ...base, target: h.target, text: h.text, isNew: false })),
      ]).catch(() => undefined),
    )
  }

  protected state(): S {
    return (this.cached ??= this.load())
  }

  private seq(): number {
    return this.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM room_ops").one().seq ?? 0
  }

  // --- People: WebSockets -----------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }
    // Set by our own Worker after authentication; clients can't reach a cell directly.
    const principal = decodePrincipal(request.headers.get(PRINCIPAL_HEADER) ?? "")
    if (Result.isFailure(principal)) return new Response("Bad principal", { status: 400 })
    const p = principal.success
    this.identify(p.orgId, request.headers.get(ARTIFACT_HEADER))
    const member: Member = {
      connectionId: crypto.randomUUID(),
      actor: p.actor,
      name: actorName(p.actor),
      color: colorFor(actorKey(p.actor)),
      readOnly: !canEdit(p),
      presence: {},
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(member)

    const init: ServerMessage<S> = {
      type: "init",
      self: member,
      members: this.members().filter((m) => m.connectionId !== member.connectionId),
      state: this.state(),
      seq: this.seq(),
    }
    server.send(JSON.stringify(init))
    this.broadcast({ type: "join", member }, server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const current = ws.deserializeAttachment() as Member
    const decoded = decodeClientMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
    if (Result.isFailure(decoded)) return
    const msg = decoded.success
    if (msg.type === "presence") {
      const member: Member = { ...current, presence: msg.presence }
      ws.serializeAttachment(member)
      this.broadcast({ type: "presence", connectionId: member.connectionId, presence: msg.presence }, ws)
      return
    }
    const member = current
    if (member.readOnly) return send(ws, { type: "reject", id: msg.id, error: "Read-only" })
    const parsed = this.parseOp(msg.op)
    if (!parsed.ok) return send(ws, { type: "reject", id: msg.id, error: parsed.error })
    const result = this.commit(parsed.op, actorKey(member.actor), member.connectionId, msg.id, member.actor)
    if (!result.ok) send(ws, { type: "reject", id: msg.id, error: result.error })
  }

  async webSocketClose(ws: WebSocket) {
    this.leave(ws)
  }

  async webSocketError(ws: WebSocket) {
    this.leave(ws)
  }

  private leave(ws: WebSocket) {
    const member = ws.deserializeAttachment() as Member | null
    try {
      ws.close(1000)
    } catch {
      // already closed
    }
    if (member) this.broadcast({ type: "leave", connectionId: member.connectionId }, ws)
  }

  // --- Shared write path --------------------------------------------------------

  protected commit(op: O, by: string, origin?: string, clientOpId?: string, actor?: Actor): { ok: true; seq: number } | { ok: false; error: string } {
    const before = this.state()
    const result = this.applyOp(before, op, by)
    if (!result.ok) return result
    const write = () => {
      this.persist(op, result.state, by)
      return this.sql
        .exec<{ seq: number }>(
          "INSERT INTO room_ops (actor, op, at) VALUES (?, ?, ?) RETURNING seq",
          by, JSON.stringify(op), new Date().toISOString(),
        )
        .one().seq
    }
    const seq = this.ctx.storage.transactionSync ? this.ctx.storage.transactionSync(write) : write()
    this.cached = result.state
    this.broadcast({ type: "op", seq, op, actorId: by, origin, clientOpId })
    if (actor) this.fileMentions(before, result.state, actor)
    this.queueIndex(INDEX_DELAY_MS)
    this.queueChanged()
    return { ok: true, seq }
  }

  // --- Telling the workspace --------------------------------------------------------

  /** Like queueIndex, the window doesn't slide: steady edits still report every CHANGE_DELAY_MS. */
  private queueChanged() {
    if (this.meta("changed_at") !== undefined || !this.identity()) return
    this.setMeta("changed_at", String(Date.now() + CHANGE_DELAY_MS))
    this.ctx.waitUntil(this.scheduleAlarm())
  }

  private async flushChanged() {
    const due = this.meta("changed_at")
    if (due === undefined || Number(due) > Date.now()) return
    this.setMeta("changed_at", null)
    const id = this.identity()
    if (!id) return
    try {
      await this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(id.orgId)).contentChanged(id.artifactId)
    } catch (e) {
      console.error(`Couldn't tell the workspace ${id.artifactId} changed:`, e)
      if (!this.destroyed && this.meta("changed_at") === undefined) this.setMeta("changed_at", String(Date.now() + CHANGE_RETRY_MS))
    }
  }

  // --- Search index ---------------------------------------------------------------

  /** Schedule a flush unless one is already due: the window doesn't slide, so steady edits still get indexed. */
  private queueIndex(delay: number) {
    if (this.meta("index_at") !== undefined || !searchConfig(this.env) || !this.identity()) return
    this.setMeta("index_at", String(Date.now() + delay))
    this.ctx.waitUntil(this.scheduleAlarm())
  }

  /**
   * Send the index what changed since the last flush, by comparing each item's
   * hash, so an edit to one row re-embeds one row. Writes are idempotent and
   * hashes are recorded only after they land, so a crash or failure just
   * repeats work. Edits that land during the await queue their own flush.
   */
  private async flushIndex() {
    const due = this.meta("index_at")
    if (due === undefined || Number(due) > Date.now()) return
    this.setMeta("index_at", null)
    const config = searchConfig(this.env)
    const id = this.identity()
    const kind = id && kindOfId(id.artifactId)
    if (!config || !id || !kind) return
    try {
      const indexed = new Map(this.sql.exec<{ item: string; hash: string }>("SELECT item, hash FROM search_index").toArray().map((r) => [r.item, r.hash]))
      const items = searchItems(kind, this.state())
      const current = new Set(items.map((i) => i.item))
      const removed = [...indexed.keys()].filter((item) => !current.has(item))
      const changed: Array<IndexItem & { readonly hash: string }> = []
      for (const item of items) {
        const hash = await contentHash(item.text)
        if (indexed.get(item.item) !== hash) changed.push({ ...item, hash })
      }
      if (removed.length) {
        await writeItems(config, id.orgId, id.artifactId, kind, [], removed)
        if (!this.destroyed) for (const item of removed) this.sql.exec("DELETE FROM search_index WHERE item = ?", item)
      }
      for (let i = 0; i < changed.length && !this.destroyed; i += writeBatchSize) {
        const batch = changed.slice(i, i + writeBatchSize)
        await writeItems(config, id.orgId, id.artifactId, kind, batch, [])
        // Deleted while that write was in flight: this cell's storage is gone, so don't touch it.
        if (this.destroyed) break
        for (const { item, hash } of batch) {
          this.sql.exec("INSERT INTO search_index (item, hash) VALUES (?, ?) ON CONFLICT(item) DO UPDATE SET hash = excluded.hash", item, hash)
        }
      }
      // That write may have landed after destroy's delete, so delete again.
      if (this.destroyed) return await deleteArtifact(config, id.orgId, id.artifactId)
      this.setMeta("index_attempts", null)
    } catch (e) {
      console.error(`Search index flush failed for ${id.artifactId}:`, e)
      if (this.destroyed) return
      const attempts = Number(this.meta("index_attempts") ?? 0)
      this.setMeta("index_attempts", String(attempts + 1))
      if (this.meta("index_at") === undefined) this.setMeta("index_at", String(Date.now() + indexRetryDelay(attempts)))
    }
  }

  /** Index this artifact from scratch. Unchanged text costs an embedding again, so this is an explicit, owner-only act. */
  async reindex(orgId: string, artifactId: string) {
    this.identify(orgId, artifactId)
    this.sql.exec("DELETE FROM search_index")
    this.setMeta("index_at", null)
    this.queueIndex(0)
  }

  // --- Agents: RPC ----------------------------------------------------------------

  /** Apply a batch of ops as an agent (or script). Stops at the first failure. */
  async agentApply(rawOps: ReadonlyArray<unknown>, principal: Principal, artifactId?: string): Promise<ApplyOutcome> {
    if (!canEdit(principal)) return { ok: false, error: "Read-only", applied: 0 }
    this.identify(principal.orgId, artifactId ?? null)
    const by = actorKey(principal.actor)
    let applied = 0
    for (const raw of rawOps) {
      const parsed = this.parseOp(raw)
      if (!parsed.ok) return { ok: false, error: `op ${applied}: ${parsed.error}`, applied }
      const r = this.commit(parsed.op, by, undefined, undefined, principal.actor)
      if (!r.ok) return { ok: false, error: `op ${applied}: ${r.error}`, applied }
      applied++
    }
    return { ok: true, applied, seq: this.seq() }
  }

  /**
   * Show an agent in the room. `runId` identifies one agent run; presence
   * expires after `ttlSeconds` unless refreshed. ttlSeconds = 0 removes it.
   */
  async agentPresence(principal: Principal, runId: string, presence: Presence, ttlSeconds: number): Promise<PresenceOutcome> {
    if (principal.actor.type !== "agent") return { ok: false, error: "Only agents set server presence" }
    const connectionId = `agent:${runId}`
    const existing = this.sql.exec<AgentRow>("SELECT * FROM room_agents WHERE connection_id = ?", connectionId).toArray()[0]
    if (ttlSeconds <= 0) {
      if (existing) {
        this.sql.exec("DELETE FROM room_agents WHERE connection_id = ?", connectionId)
        this.broadcast({ type: "leave", connectionId })
      }
      return { ok: true }
    }
    const member: Member = {
      connectionId,
      actor: principal.actor,
      name: actorName(principal.actor),
      color: colorFor(actorKey(principal.actor)),
      readOnly: false,
      presence,
    }
    const expiresAt = Date.now() + Math.min(ttlSeconds, 600) * 1000
    this.sql.exec(
      "INSERT INTO room_agents (connection_id, member, expires_at) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET member = excluded.member, expires_at = excluded.expires_at",
      connectionId, JSON.stringify(member), expiresAt,
    )
    this.broadcast(existing ? { type: "presence", connectionId, presence } : { type: "join", member })
    await this.scheduleAlarm()
    return { ok: true }
  }

  async alarm() {
    const now = Date.now()
    const expired = this.sql
      .exec<{ connection_id: string }>("DELETE FROM room_agents WHERE expires_at <= ? RETURNING connection_id", now)
      .toArray()
    for (const row of expired) this.broadcast({ type: "leave", connectionId: row.connection_id })
    await this.flushChanged()
    await this.flushIndex()
    if (!this.destroyed) await this.scheduleAlarm()
  }

  /** A cell has one alarm, so it's set for whichever comes first: an agent's presence expiring, a change report or an index flush. */
  private async scheduleAlarm() {
    const expiry = this.sql.exec<{ t: number | null }>("SELECT MIN(expires_at) AS t FROM room_agents").one().t
    const times = [expiry, this.meta("changed_at"), this.meta("index_at")].flatMap((t) => (t === null || t === undefined ? [] : [Number(t)]))
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times))
  }

  async snapshot() {
    return { state: this.state(), seq: this.seq() }
  }

  /** Called when the artifact is deleted. */
  async destroy() {
    const config = searchConfig(this.env)
    const id = this.identity()
    this.destroyed = true
    // Search already hides deleted artifacts; this is what actually removes their text from the index.
    if (config && id) {
      await deleteArtifact(config, id.orgId, id.artifactId).catch((e) => console.error(`Search index delete failed for ${id.artifactId}; its text stays in the index:`, e))
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4004, "Deleted")
      } catch {
        // ignore
      }
    }
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.cached = undefined
  }

  // --- Fan-out ----------------------------------------------------------------------

  protected members(): Member[] {
    const people = this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment() as Member | null)
      .filter((m): m is Member => m !== null)
    const agents = this.sql
      .exec<AgentRow>("SELECT * FROM room_agents WHERE expires_at > ?", Date.now())
      .toArray()
      .map((r) => JSON.parse(r.member) as Member)
    return [...people, ...agents]
  }

  protected broadcast(msg: ServerMessage<S, O>, except?: WebSocket) {
    const data = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      try {
        ws.send(data)
      } catch {
        // socket closing; webSocketClose will clean up
      }
    }
  }
}

const send = (ws: WebSocket, msg: ServerMessage) => ws.send(JSON.stringify(msg))
const decodePrincipal = Schema.decodeUnknownResult(Schema.fromJsonString(Principal))
const decodeClientMessage = Schema.decodeUnknownResult(Schema.fromJsonString(ClientMessage))
