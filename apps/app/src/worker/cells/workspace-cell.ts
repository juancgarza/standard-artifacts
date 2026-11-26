import { DurableObject } from "cloudflare:workers"
import type { Env } from "../env"
import { runnerEnabled } from "./runner-cell"
import {
  canEdit,
  folderProblem,
  sharePath,
  targetKey,
  type ApiToken,
  type ArtifactAccess,
  type OrgDirectory,
  type ShareLink,
  type CreateMention,
  type Mention,
  type MentionTarget,
  kinds,
  type Artifact,
  type CreateArtifact,
  type CreateFolder,
  type Folder,
  type Principal,
  type UpdateArtifact,
  type UpdateFolder,
  uniqueFolderName,
} from "@standard-artifacts/protocol"

/** RPC results are plain data; the Worker maps failures to typed API errors. */
export type CellResult<T> = { ok: true; value: T } | { ok: false; reason: "forbidden" | "not-found"; error: string }

/** Folder writes can also be refused for breaking a rule (a taken name, a cycle). */
export type FolderResult<T> = { ok: true; value: T } | { ok: false; reason: "forbidden" | "not-found" | "invalid"; error: string }

/** Header the Worker uses to say which one artifact a share-link guest's socket may hear about. Never trusted from clients. */
export const SCOPE_HEADER = "x-standard-artifacts-scope"

type Listener = { scope: string | null }

type FolderRow = { id: string; name: string; parent_id: string | null; created_by: string; created_at: string; updated_at: string }

type Row = {
  id: string
  kind: Artifact["kind"]
  title: string
  created_by: string
  created_by_name: string | null
  client: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  folder_id: string | null
}

/**
 * One cell per org. It is the index of the org's boards, tables and docs; each
 * artifact's content will live in its own cell (TableCell, BoardCell, DocCell).
 * Permission checks happen here, not in the router, so every entry point
 * (HTTP, WebSocket, MCP) gets the same rules.
 */
export class WorkspaceCell extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    // Added after the first version: migrate workspaces created before archiving existed.
    const columns = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(artifacts)").toArray().map((c) => c.name))
    if (!columns.has("archived_at")) this.sql.exec("ALTER TABLE artifacts ADD COLUMN archived_at TEXT")
    if (!columns.has("client")) this.sql.exec("ALTER TABLE artifacts ADD COLUMN client TEXT")
    if (!columns.has("folder_id")) this.sql.exec("ALTER TABLE artifacts ADD COLUMN folder_id TEXT")
    this.sql.exec(`CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    if (!columns.has("created_by_name")) {
      this.sql.exec("ALTER TABLE artifacts ADD COLUMN created_by_name TEXT")
      // Fill in names for artifacts made before names were kept, from the member directory.
      this.sharing()
      this.sql.exec("UPDATE artifacts SET created_by_name = (SELECT name FROM principals WHERE principals.key = artifacts.created_by) WHERE created_by_name IS NULL")
    }
  }

  // --- Live index ------------------------------------------------------------------------

  /**
   * Open pages hold a socket here that only ever says "changed"; they read the
   * index back through the API, so what each caller may see is decided in one
   * place. Hibernation means an idle org's sockets cost nothing.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ scope: request.headers.get(SCOPE_HEADER) } satisfies Listener)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketClose(ws: WebSocket) {
    try {
      ws.close(1000)
    } catch {
      // already closed
    }
  }

  /** `artifactId` is what changed; null means how the org files things, which share-link guests never see. */
  private notify(artifactId: string | null) {
    for (const ws of this.ctx.getWebSockets()) {
      const { scope } = ws.deserializeAttachment() as Listener
      if (scope && scope !== artifactId) continue
      try {
        ws.send("changed")
      } catch {
        // closing: its page reads the index again when it reconnects
      }
    }
  }

  /** An artifact's content changed (its own cell reports this, throttled). */
  contentChanged(id: string) {
    const rows = this.sql.exec("UPDATE artifacts SET updated_at = ? WHERE id = ? AND archived_at IS NULL RETURNING id", new Date().toISOString(), id).toArray()
    if (rows.length) this.notify(id)
  }

  // --- @-mention inbox ---------------------------------------------------------------

  private inbox() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mentions (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, kind TEXT NOT NULL, target_key TEXT NOT NULL, target TEXT NOT NULL,
      text TEXT NOT NULL, requested_by TEXT NOT NULL, requested_by_name TEXT NOT NULL, status TEXT NOT NULL,
      not_before INTEGER NOT NULL, lease_until INTEGER, claimed_by TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    // Added after the first version: migrate inboxes created before these columns existed.
    const columns = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(mentions)").toArray().map((c) => c.name))
    if (!columns.has("mode")) this.sql.exec("ALTER TABLE mentions ADD COLUMN mode TEXT NOT NULL DEFAULT 'reply'")
    if (!columns.has("blocks")) this.sql.exec("ALTER TABLE mentions ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]'")
    if (!columns.has("resolved")) this.sql.exec("ALTER TABLE mentions ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0")
    if (!columns.has("dispatched_at")) this.sql.exec("ALTER TABLE mentions ADD COLUMN dispatched_at INTEGER")
    if (!columns.has("dispatches")) this.sql.exec("ALTER TABLE mentions ADD COLUMN dispatches INTEGER NOT NULL DEFAULT 0")
  }

  /** An explicit request from the Ask bar: filed by a person, claimable right away. */
  createMention(input: CreateMention, p: Principal): CellResult<Mention> {
    if (!canEdit(p)) return denied()
    if (!this.get(input.artifactId)) return notFound()
    this.inbox()
    const now = new Date().toISOString()
    const actor = p.actor
    const name = actor.type === "user" ? actor.name : actor.type === "guest" ? "Guest" : "Agent"
    const key = actor.type === "agent" ? `${actor.id}:${actor.onBehalfOf}` : actor.id
    const row = this.sql
      .exec<MentionRow>(
        "INSERT INTO mentions (id, artifact_id, kind, target_key, target, text, requested_by, requested_by_name, status, mode, blocks, not_before, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING *",
        `m_${randomId()}`, input.artifactId, this.get(input.artifactId)?.kind ?? "doc", targetKey(input.target), JSON.stringify(input.target), input.text,
        key, name, input.mode ?? "reply", JSON.stringify(input.blocks ?? []), Date.now(), now, now,
      )
      .toArray()[0]
    this.rememberOrg(p)
    this.ctx.waitUntil(this.scheduleDispatch())
    return row ? { ok: true, value: toMention(row) } : notFound()
  }

  /** Stop a request: a queued one never runs; a running one is told to stop (the runner polls). */
  cancelMention(id: string, p: Principal): CellResult<Mention> {
    if (!canEdit(p)) return denied()
    this.inbox()
    const row = this.sql
      .exec<MentionRow>(
        "UPDATE mentions SET status = 'cancelled', lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'running') RETURNING *",
        new Date().toISOString(), id,
      )
      .toArray()[0]
    if (row) return { ok: true, value: toMention(row) }
    const existing = this.sql.exec<MentionRow>("SELECT * FROM mentions WHERE id = ?", id).toArray()[0]
    return existing ? { ok: true, value: toMention(existing) } : notFound()
  }

  mention(id: string): Mention | null {
    this.inbox()
    const row = this.sql.exec<MentionRow>("SELECT * FROM mentions WHERE id = ?", id).toArray()[0]
    return row ? toMention(row) : null
  }

  /**
   * File (or refresh) a mention. It only becomes claimable once the text has
   * been still for SETTLE_MS, so "@claude research…" isn't picked up at "@claude".
   */
  fileMention(m: { artifactId: string; kind: Artifact["kind"]; target: MentionTarget; text: string; requestedBy: string; requestedByName: string; isNew: boolean }) {
    this.inbox()
    const now = new Date().toISOString()
    const key = targetKey(m.target)
    const queued = this.sql
      .exec<{ id: string }>("SELECT id FROM mentions WHERE artifact_id = ? AND target_key = ? AND status = 'queued'", m.artifactId, key)
      .toArray()[0]
    if (queued) {
      // A run that already started would find nothing claimable and exit, so this needs a new one.
      this.sql.exec("UPDATE mentions SET text = ?, not_before = ?, dispatched_at = NULL, dispatches = 0, updated_at = ? WHERE id = ?", m.text, Date.now() + SETTLE_MS, now, queued.id)
      this.ctx.waitUntil(this.scheduleDispatch())
      return
    }
    if (!m.isNew) return
    this.sql.exec(
      "INSERT INTO mentions (id, artifact_id, kind, target_key, target, text, requested_by, requested_by_name, status, not_before, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
      `m_${randomId()}`, m.artifactId, m.kind, key, JSON.stringify(m.target), m.text, m.requestedBy, m.requestedByName, Date.now() + SETTLE_MS, now, now,
    )
    this.ctx.waitUntil(this.scheduleDispatch())
  }

  mentions(artifactId?: string): Mention[] {
    this.inbox()
    if (artifactId) {
      // Open threads are what the canvas shows, however old; plus recent history.
      return this.sql
        .exec<MentionRow>("SELECT * FROM mentions WHERE artifact_id = ? AND (resolved = 0 OR created_at > ?) ORDER BY created_at DESC LIMIT 200", artifactId, new Date(Date.now() - 864e5).toISOString())
        .toArray()
        .map(toMention)
    }
    return this.sql.exec<MentionRow>("SELECT * FROM mentions ORDER BY created_at DESC LIMIT 50").toArray().map(toMention)
  }

  /** Resolve a thread: every request on the same target. Queued or running ones are cancelled first. */
  resolveMention(id: string, p: Principal): CellResult<Mention[]> {
    if (!canEdit(p)) return denied()
    this.inbox()
    const m = this.sql.exec<MentionRow>("SELECT * FROM mentions WHERE id = ?", id).toArray()[0]
    if (!m) return notFound()
    const now = new Date().toISOString()
    this.sql.exec(
      "UPDATE mentions SET status = 'cancelled', lease_until = NULL, updated_at = ? WHERE artifact_id = ? AND target_key = ? AND status IN ('queued', 'running')",
      now, m.artifact_id, m.target_key,
    )
    const rows = this.sql
      .exec<MentionRow>("UPDATE mentions SET resolved = 1, updated_at = ? WHERE artifact_id = ? AND target_key = ? AND resolved = 0 RETURNING *", now, m.artifact_id, m.target_key)
      .toArray()
    return { ok: true, value: rows.map(toMention) }
  }

  /** Mentions that can never be answered: out of attempts, or their artifact was deleted. */
  private closeHopelessMentions(now: number) {
    this.sql.exec("UPDATE mentions SET status = 'error', result = 'Gave up after 3 attempts', updated_at = ? WHERE status = 'running' AND lease_until < ? AND attempts >= 3", new Date().toISOString(), now)
    this.sql.exec(
      "UPDATE mentions SET status = 'error', result = 'The artifact was deleted', updated_at = ? WHERE status IN ('queued', 'running') AND artifact_id NOT IN (SELECT id FROM artifacts)",
      new Date().toISOString(),
    )
  }

  // --- Hosted agent runs --------------------------------------------------------------
  // With no runner configured, none of this does anything and mentions wait for `stdartifacts agent serve`.

  /** A run needs a ticket naming the org, and a cell doesn't otherwise know its own org. */
  private rememberOrg(p: Principal) {
    this.sql.exec("CREATE TABLE IF NOT EXISTS org_meta (id INTEGER PRIMARY KEY CHECK (id = 1), org_id TEXT NOT NULL, org_name TEXT NOT NULL, plan TEXT NOT NULL)")
    this.sql.exec(
      "INSERT INTO org_meta (id, org_id, org_name, plan) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, org_name = excluded.org_name, plan = excluded.plan",
      p.orgId, p.orgName, p.plan,
    )
  }

  /** Wake for the next mention that will need a run: when it settles, or when the last attempt's lease runs out. */
  private async scheduleDispatch() {
    if (!runnerEnabled(this.env)) return
    this.inbox()
    const next = this.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(MAX(CASE status WHEN 'queued' THEN not_before ELSE COALESCE(lease_until, 0) END, COALESCE(dispatched_at, 0) + ?)) AS at
         FROM mentions WHERE status IN ('queued', 'running') AND artifact_id NOT IN (SELECT id FROM artifacts WHERE archived_at IS NOT NULL)`,
        LEASE_MS,
      )
      .one().at
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 500))
  }

  override async alarm() {
    if (!runnerEnabled(this.env)) return
    this.inbox()
    const retryAt = await this.dispatch()
    if (retryAt !== null) await this.ctx.storage.setAlarm(retryAt)
    else await this.scheduleDispatch()
  }

  /** Start a run for each mention that's ready, up to the limits. Returns when to look again if some had to wait. */
  private async dispatch(): Promise<number | null> {
    const now = Date.now()
    this.closeHopelessMentions(now)
    this.sql.exec(
      "UPDATE mentions SET status = 'error', result = 'The agent could not be started', updated_at = ? WHERE status = 'queued' AND dispatches >= 3 AND dispatched_at + ? <= ?",
      new Date().toISOString(), LEASE_MS, now,
    )
    const ready = this.sql
      .exec<MentionRow>(
        `SELECT * FROM mentions WHERE ((status = 'queued' AND not_before <= ?) OR (status = 'running' AND lease_until < ?))
         AND COALESCE(dispatched_at, 0) + ? <= ? AND artifact_id NOT IN (SELECT id FROM artifacts WHERE archived_at IS NOT NULL) ORDER BY created_at`,
        now, now, LEASE_MS, now,
      )
      .toArray()
    if (!ready.length) return null
    const org = this.org()
    if (!org) {
      console.error("A mention is ready but this org's details aren't known yet; it waits for the next visit")
      return null
    }

    const usedToday = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mentions WHERE dispatched_at > ?", now - DAY_MS).one().n
    const dailyLimit = Number(this.env.RUNNER_DAILY_RUNS ?? DEFAULT_DAILY_RUNS)
    const active = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM mentions WHERE (status = 'running' AND lease_until >= ?) OR (status = 'queued' AND dispatched_at + ? > ?)",
        now, LEASE_MS, now,
      )
      .one().n
    const slots = Math.max(0, MAX_ACTIVE_RUNS - active)

    const inDailyLimit = Math.max(0, dailyLimit - usedToday)
    for (const m of ready.slice(inDailyLimit)) {
      this.sql.exec(
        "UPDATE mentions SET status = 'error', result = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
        `This workspace reached its limit of ${dailyLimit} agent runs in 24 hours. Try again later.`, new Date().toISOString(), m.id,
      )
    }
    const allowed = ready.slice(0, inDailyLimit)
    const starting = allowed.slice(0, slots)
    await Promise.all(starting.map((m) => this.startRun(m, org, now)))
    return allowed.length > starting.length ? now + RETRY_MS : null
  }

  private async startRun(m: MentionRow, org: { orgId: string; orgName: string; plan: Principal["plan"] }, now: number) {
    const runner = this.env.RUNNER
    if (!runner) return
    // Recorded first, so a crash here can't turn into a burst of containers.
    this.sql.exec("UPDATE mentions SET dispatched_at = ?, dispatches = dispatches + 1 WHERE id = ?", now, m.id)
    try {
      const cell = runner.get(runner.idFromName(`${org.orgId}:${m.id}`))
      await cell.run({ ...org, requestedBy: m.requested_by, mentionId: m.id })
    } catch (e) {
      console.error(`Couldn't start a run for ${m.id}:`, e)
      // Try sooner than a whole lease from now: capacity and rate limits usually pass quickly.
      this.sql.exec("UPDATE mentions SET dispatched_at = ? WHERE id = ?", now + RETRY_MS - LEASE_MS, m.id)
    }
  }

  private org(): { orgId: string; orgName: string; plan: Principal["plan"] } | null {
    const exists = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'org_meta'").toArray().length > 0
    if (!exists) return null
    const row = this.sql.exec<{ org_id: string; org_name: string; plan: Principal["plan"] }>("SELECT org_id, org_name, plan FROM org_meta").toArray()[0]
    return row ? { orgId: row.org_id, orgName: row.org_name, plan: row.plan } : null
  }

  /** Lease the oldest ready mention to a runner. Expired leases are reclaimed; three attempts, then it fails. */
  claimMention(runner: string, p: Principal, artifactId?: string): CellResult<Mention | null> {
    if (!canEdit(p)) return denied()
    this.inbox()
    const now = Date.now()
    this.closeHopelessMentions(now)
    const row = this.sql
      .exec<MentionRow>(
        // Mentions on an archived artifact wait: they can be claimed again if it's restored.
        "SELECT * FROM mentions WHERE ((status = 'queued' AND not_before <= ?) OR (status = 'running' AND lease_until < ?)) AND (? IS NULL OR artifact_id = ?) AND artifact_id NOT IN (SELECT id FROM artifacts WHERE archived_at IS NOT NULL) ORDER BY created_at LIMIT 1",
        now, now, artifactId ?? null, artifactId ?? null,
      )
      .toArray()[0]
    if (!row) return { ok: true, value: null }
    const updated = this.sql
      .exec<MentionRow>(
        "UPDATE mentions SET status = 'running', claimed_by = ?, lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? RETURNING *",
        runner, now + LEASE_MS, new Date().toISOString(), row.id,
      )
      .toArray()[0]
    return { ok: true, value: updated ? toMention(updated) : null }
  }

  completeMention(id: string, status: "done" | "error", result: string, p: Principal): CellResult<Mention> {
    if (!canEdit(p)) return denied()
    this.inbox()
    // A cancelled request stays cancelled; the runner's late result is kept for reference.
    const row = this.sql
      .exec<MentionRow>(
        "UPDATE mentions SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE ? END, result = ?, lease_until = NULL, updated_at = ? WHERE id = ? RETURNING *",
        status, result, new Date().toISOString(), id,
      )
      .toArray()[0]
    return row ? { ok: true, value: toMention(row) } : notFound()
  }

  list(): Artifact[] {
    return this.sql
      .exec<Row>("SELECT * FROM artifacts WHERE archived_at IS NULL ORDER BY updated_at DESC")
      .toArray()
      .map(toArtifact)
  }

  /** Archived artifacts read as not found: every route to content (rooms, share links, mentions) comes through here. */
  get(id: string): Artifact | null {
    const row = this.sql.exec<Row>("SELECT * FROM artifacts WHERE id = ? AND archived_at IS NULL", id).toArray()[0]
    return row ? toArtifact(row) : null
  }

  create(input: CreateArtifact, p: Principal): CellResult<Artifact> {
    if (!canEdit(p)) return denied()
    if (input.folderId && !this.folders().some((f) => f.id === input.folderId)) return noFolder()
    const now = new Date().toISOString()
    const row: Row = {
      id: `${kinds[input.kind].prefix}_${randomId()}`,
      kind: input.kind,
      title: input.title ?? `Untitled ${kinds[input.kind].singular.toLowerCase()}`,
      created_by: actorId(p),
      created_by_name: p.actor.type === "user" ? p.actor.name : p.actor.type === "agent" ? (p.actor.name ?? null) : null,
      client: input.client ?? null,
      created_at: now,
      updated_at: now,
      archived_at: null,
      folder_id: input.folderId ?? null,
    }
    this.sql.exec(
      "INSERT INTO artifacts (id, kind, title, created_by, created_by_name, client, created_at, updated_at, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id, row.kind, row.title, row.created_by, row.created_by_name, row.client, row.created_at, row.updated_at, row.folder_id,
    )
    this.notify(row.id)
    return { ok: true, value: toArtifact(row) }
  }

  update(id: string, input: UpdateArtifact, p: Principal): CellResult<Artifact> {
    if (!canEdit(p)) return denied()
    const rows = this.sql
      .exec<Row>(
        "UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL RETURNING *",
        input.title, new Date().toISOString(), id,
      )
      .toArray()
    if (rows[0]) this.notify(id)
    return rows[0] ? { ok: true, value: toArtifact(rows[0]) } : notFound()
  }

  remove(id: string, p: Principal): CellResult<Artifact> {
    if (!canEdit(p)) return denied()
    const deleted = this.sql.exec<Row>("DELETE FROM artifacts WHERE id = ? RETURNING *", id).toArray()[0]
    if (deleted) {
      this.inbox()
      this.sql.exec("DELETE FROM mentions WHERE artifact_id = ?", id)
      this.sharing()
      this.sql.exec("DELETE FROM share_links WHERE artifact_id = ?", id)
      this.notify(id)
    }
    return deleted ? { ok: true, value: toArtifact(deleted) } : notFound()
  }

  archived(p: Principal): CellResult<Artifact[]> {
    if (!canEdit(p)) return denied()
    const rows = this.sql.exec<Row>("SELECT * FROM artifacts WHERE archived_at IS NOT NULL ORDER BY archived_at DESC").toArray()
    return { ok: true, value: rows.map(toArtifact) }
  }

  /** Hide an artifact without touching its content. Its cell, share links and mentions stay, ready for restore. */
  archive(id: string, p: Principal): CellResult<Artifact> {
    if (!canEdit(p)) return denied()
    const row = this.sql
      .exec<Row>("UPDATE artifacts SET archived_at = ? WHERE id = ? AND archived_at IS NULL RETURNING *", new Date().toISOString(), id)
      .toArray()[0]
    if (row) this.notify(id)
    return row ? { ok: true, value: toArtifact(row) } : notFound()
  }

  restore(id: string, p: Principal): CellResult<Artifact> {
    if (!canEdit(p)) return denied()
    const row = this.sql.exec<Row>("UPDATE artifacts SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL RETURNING *", id).toArray()[0]
    // Mentions on an archived artifact wait; restoring it lets them run.
    this.ctx.waitUntil(this.scheduleDispatch())
    if (row) this.notify(id)
    return row ? { ok: true, value: toArtifact(row) } : notFound()
  }

  // --- Folders --------------------------------------------------------------------------

  folders(): Folder[] {
    return this.sql.exec<FolderRow>("SELECT * FROM folders ORDER BY name COLLATE NOCASE").toArray().map(toFolder)
  }

  createFolder(input: CreateFolder, p: Principal): FolderResult<Folder> {
    if (!canEdit(p)) return denied()
    const folders = this.folders()
    const parentId = input.parentId ?? null
    if (parentId && !folders.some((f) => f.id === parentId)) return noFolder()
    const problem = folderProblem(folders, { name: input.name, parentId })
    if (problem) return { ok: false, reason: "invalid", error: problem }
    const now = new Date().toISOString()
    const row: FolderRow = { id: `f_${randomId()}`, name: input.name, parent_id: parentId, created_by: actorId(p), created_at: now, updated_at: now }
    this.sql.exec(
      "INSERT INTO folders (id, name, parent_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      row.id, row.name, row.parent_id, row.created_by, row.created_at, row.updated_at,
    )
    this.notify(null)
    return { ok: true, value: toFolder(row) }
  }

  updateFolder(id: string, input: UpdateFolder, p: Principal): FolderResult<Folder> {
    if (!canEdit(p)) return denied()
    const folders = this.folders()
    const current = folders.find((f) => f.id === id)
    if (!current) return noFolder()
    const name = input.name ?? current.name
    const parentId = input.parentId === undefined ? current.parentId : input.parentId
    if (parentId && !folders.some((f) => f.id === parentId)) return noFolder()
    const problem = folderProblem(folders, { id, name, parentId })
    if (problem) return { ok: false, reason: "invalid", error: problem }
    const row = this.sql
      .exec<FolderRow>("UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ? RETURNING *", name, parentId, new Date().toISOString(), id)
      .toArray()[0]
    if (row) this.notify(null)
    return row ? { ok: true, value: toFolder(row) } : noFolder()
  }

  /**
   * Delete only the folder: its subfolders and artifacts (archived ones too, so
   * a restore has somewhere to land) move up to its parent. A subfolder whose
   * name is taken up there gets a number, since names are unique among siblings.
   */
  deleteFolder(id: string, p: Principal): FolderResult<Folder> {
    if (!canEdit(p)) return denied()
    const folders = this.folders()
    const current = folders.find((f) => f.id === id)
    if (!current) return noFolder()
    let others = folders.filter((f) => f.id !== id)
    const now = new Date().toISOString()
    for (const child of others.filter((f) => f.parentId === id)) {
      const name = uniqueFolderName(others.filter((f) => f.id !== child.id), child.name, current.parentId)
      this.sql.exec("UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?", name, current.parentId, now, child.id)
      others = others.map((f) => (f.id === child.id ? { ...f, name, parentId: current.parentId } : f))
    }
    this.sql.exec("UPDATE artifacts SET folder_id = ? WHERE folder_id = ?", current.parentId, id)
    this.sql.exec("DELETE FROM folders WHERE id = ?", id)
    this.notify(null)
    return { ok: true, value: current }
  }

  /** Leaves updated_at alone: moving an artifact isn't an edit to it, so "Recent" doesn't reshuffle. */
  moveArtifact(id: string, folderId: string | null, p: Principal): FolderResult<Artifact> {
    if (!canEdit(p)) return denied()
    if (folderId && !this.folders().some((f) => f.id === folderId)) return noFolder()
    const row = this.sql.exec<Row>("UPDATE artifacts SET folder_id = ? WHERE id = ? AND archived_at IS NULL RETURNING *", folderId, id).toArray()[0]
    if (row) this.notify(null)
    return row ? { ok: true, value: toArtifact(row) } : notFound()
  }

  // --- Sharing --------------------------------------------------------------------------

  /**
   * `principals` remembers the org's people and agents as they show up (roles
   * live in tickets, so this is a directory, not the source of truth).
   * `share_links` holds each artifact's read-only link.
   */
  private sharing() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS principals (
      key TEXT PRIMARY KEY, type TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, on_behalf_of TEXT,
      role TEXT NOT NULL, last_seen TEXT NOT NULL)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS share_links (
      token TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT NOT NULL,
      org_name TEXT NOT NULL, plan TEXT NOT NULL, created_at TEXT NOT NULL)`)
  }

  /** Note that a person or agent is active in the org. Guests aren't members, so they aren't kept. */
  touch(p: Principal) {
    if (p.actor.type === "guest") return
    this.sharing()
    this.rememberOrg(p)
    const a = p.actor
    const name = a.type === "user" ? a.name : (a.name ?? "Agent")
    this.sql.exec(
      "INSERT INTO principals (key, type, id, name, on_behalf_of, role, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, role = excluded.role, last_seen = excluded.last_seen",
      actorId(p), a.type, a.id, name, a.type === "agent" ? a.onBehalfOf : null, p.role, new Date().toISOString(),
    )
  }

  access(artifactId: string, p: Principal): CellResult<ArtifactAccess> {
    if (p.actor.type === "guest") return { ok: false, reason: "forbidden", error: "Guests can't see who has access" }
    const artifact = this.get(artifactId)
    if (!artifact) return notFound()
    return {
      ok: true,
      value: {
        artifactId,
        orgName: p.orgName,
        plan: p.plan,
        createdBy: artifact.createdBy,
        ...this.principals(),
        link: this.linkFor(artifactId),
        canManage: canEdit(p),
      },
    }
  }

  directory(p: Principal): CellResult<OrgDirectory> {
    if (p.actor.type === "guest") return { ok: false, reason: "forbidden", error: "Guests can't see the workspace's members" }
    return { ok: true, value: this.principals() }
  }

  private principals(): OrgDirectory {
    this.sharing()
    const rows = this.sql.exec<PrincipalRow>("SELECT * FROM principals ORDER BY last_seen DESC").toArray()
    const names = new Map(rows.filter((r) => r.type === "user").map((r) => [r.id, r.name]))
    return {
      people: rows.filter((r) => r.type === "user").map((r) => ({ id: r.id, name: r.name, role: r.role, lastSeenAt: r.last_seen })),
      agents: rows
        .filter((r) => r.type === "agent")
        .map((r) => ({
          key: r.key,
          id: r.id,
          name: r.name,
          onBehalfOf: r.on_behalf_of ?? "",
          onBehalfOfName: names.get(r.on_behalf_of ?? "") ?? null,
          role: r.role,
          lastSeenAt: r.last_seen,
        })),
    }
  }

  private linkFor(artifactId: string): ShareLink | null {
    this.sharing()
    const row = this.sql.exec<LinkRow>("SELECT * FROM share_links WHERE artifact_id = ? ORDER BY created_at DESC LIMIT 1", artifactId).toArray()[0]
    return row ? toLink(row) : null
  }

  /** Turn on the artifact's read-only link (returns the existing one if it's already on). */
  createLink(artifactId: string, p: Principal): CellResult<ShareLink> {
    if (!canEdit(p)) return denied()
    if (!this.get(artifactId)) return notFound()
    const existing = this.linkFor(artifactId)
    if (existing) return { ok: true, value: existing }
    // The org id rides in the token so the Worker can find this cell; the random part is the secret.
    const token = `sh.${b64url(p.orgId)}.${randomId()}${randomId()}`
    const row: LinkRow = { token, artifact_id: artifactId, role: "viewer", created_by: actorId(p), org_name: p.orgName, plan: p.plan, created_at: new Date().toISOString() }
    this.sql.exec(
      "INSERT INTO share_links (token, artifact_id, role, created_by, org_name, plan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      row.token, row.artifact_id, row.role, row.created_by, row.org_name, row.plan, row.created_at,
    )
    return { ok: true, value: toLink(row) }
  }

  /** Turn the link off: everyone holding it loses access on their next request. */
  deleteLink(artifactId: string, p: Principal): CellResult<null> {
    if (!canEdit(p)) return denied()
    if (!this.get(artifactId)) return notFound()
    this.sharing()
    this.sql.exec("DELETE FROM share_links WHERE artifact_id = ?", artifactId)
    return { ok: true, value: null }
  }

  // --- Member changes, one at a time ----------------------------------------------------------

  /**
   * A lock the Worker holds while it changes this org's members (roles,
   * removals), so the last-owner check and the write can't interleave with
   * another owner's: two owners demoting each other at once would otherwise
   * both see two owners and leave none. It's a row, not memory, so it survives
   * the cell being evicted mid-change, and it expires on its own if the Worker
   * holding it dies. Synchronous, so taking it is atomic.
   */
  private memberLockTable() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS member_lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, until INTEGER NOT NULL)")
  }

  /** Take the member lock for `ttlMs`. False while someone else holds it. */
  lockMembers(holder: string, ttlMs: number): boolean {
    this.memberLockTable()
    const now = Date.now()
    const held = this.sql.exec<{ holder: string; until: number }>("SELECT holder, until FROM member_lock WHERE id = 1").toArray()[0]
    if (held && held.until > now && held.holder !== holder) return false
    this.sql.exec("INSERT OR REPLACE INTO member_lock (id, holder, until) VALUES (1, ?, ?)", holder, now + ttlMs)
    return true
  }

  unlockMembers(holder: string): void {
    this.memberLockTable()
    this.sql.exec("DELETE FROM member_lock WHERE id = 1 AND holder = ?", holder)
  }

  // --- Personal access tokens ---------------------------------------------------------------

  /**
   * `api_tokens` holds a hash of each token, never the token. A token acts as the
   * person who made it, with their role in the org, which the Worker checks with
   * the account service every few minutes (`checked_at`).
   */
  private apiTokens() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, user_name TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL, checked_at INTEGER NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)`)
  }

  /** The caller's own tokens. Only people have them: not agents or guests. */
  listTokens(p: Principal): CellResult<Array<ApiToken>> {
    if (p.actor.type !== "user") return { ok: false, reason: "forbidden", error: "Only people have access tokens" }
    this.apiTokens()
    const rows = this.sql.exec<TokenRow>("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC", p.actor.id).toArray()
    return { ok: true, value: rows.map(toToken) }
  }

  /** Store a new token's hash (the Worker makes the token, since it knows the org). */
  createToken(p: Principal, input: { id: string; hash: string; name: string }): CellResult<ApiToken> {
    if (p.actor.type !== "user") return { ok: false, reason: "forbidden", error: "Only people can create access tokens" }
    this.apiTokens()
    this.rememberOrg(p)
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?", p.actor.id).one().n
    if (count >= MAX_TOKENS_PER_PERSON) return { ok: false, reason: "forbidden", error: `You have ${MAX_TOKENS_PER_PERSON} tokens. Revoke one first.` }
    const row = this.sql
      .exec<TokenRow>(
        "INSERT INTO api_tokens (id, hash, user_id, user_name, name, role, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
        input.id, input.hash, p.actor.id, p.actor.name, input.name, p.role, Date.now(), new Date().toISOString(),
      )
      .toArray()[0]
    return row ? { ok: true, value: toToken(row) } : notFound()
  }

  /** Revoke one of the caller's tokens. It stops working on its next request. */
  revokeToken(p: Principal, id: string): CellResult<null> {
    if (p.actor.type !== "user") return { ok: false, reason: "forbidden", error: "Only people have access tokens" }
    this.apiTokens()
    const gone = this.sql.exec("DELETE FROM api_tokens WHERE id = ? AND user_id = ? RETURNING id", id, p.actor.id).toArray()
    return gone.length ? { ok: true, value: null } : notFound()
  }

  /** Someone left the org (or was removed): every token of theirs stops working. */
  revokeUserTokens(userId: string): number {
    this.apiTokens()
    return this.sql.exec("DELETE FROM api_tokens WHERE user_id = ? RETURNING id", userId).toArray().length
  }

  /** Look a token up by its hash, for the Worker's auth. Null when it was revoked. */
  resolveToken(hash: string): ResolvedToken | null {
    this.apiTokens()
    const row = this.sql.exec<TokenRow>("SELECT * FROM api_tokens WHERE hash = ?", hash).toArray()[0]
    const org = this.org()
    if (!row || !org) return null
    // Last used, to the minute: enough to spot a token nobody uses, without a write per request.
    const now = new Date()
    if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > 60_000) {
      this.sql.exec("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now.toISOString(), row.id)
    }
    return { id: row.id, name: row.name, userId: row.user_id, userName: row.user_name, role: row.role, checkedAt: row.checked_at, ...org }
  }

  /** The account service confirmed a person's role: their tokens act with it until the next check. */
  tokenRoleChecked(userId: string, role: Principal["role"]) {
    this.apiTokens()
    this.sql.exec("UPDATE api_tokens SET role = ?, checked_at = ? WHERE user_id = ?", role, Date.now(), userId)
  }

  /** Resolve a share token (for the Worker's auth). Null when it was turned off or its artifact is gone. */
  link(token: string): { artifactId: string; kind: Artifact["kind"]; orgName: string; plan: Principal["plan"] } | null {
    this.sharing()
    const row = this.sql.exec<LinkRow>("SELECT * FROM share_links WHERE token = ?", token).toArray()[0]
    const artifact = row && this.get(row.artifact_id)
    return row && artifact ? { artifactId: artifact.id, kind: artifact.kind, orgName: row.org_name, plan: row.plan } : null
  }
}

type TokenRow = {
  id: string; hash: string; user_id: string; user_name: string; name: string; role: Principal["role"]; checked_at: number; created_at: string; last_used_at: string | null
}

/** What a token resolves to: the person, their last-checked role, and the org. */
export type ResolvedToken = {
  id: string; name: string; userId: string; userName: string; role: Principal["role"]; checkedAt: number
  orgId: string; orgName: string; plan: Principal["plan"]
}

const toToken = (r: TokenRow): ApiToken => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })

const MAX_TOKENS_PER_PERSON = 50

type PrincipalRow = { key: string; type: "user" | "agent"; id: string; name: string; on_behalf_of: string | null; role: Principal["role"]; last_seen: string }
type LinkRow = { token: string; artifact_id: string; role: "viewer"; created_by: string; org_name: string; plan: Principal["plan"]; created_at: string }

const toLink = (r: LinkRow): ShareLink => ({ token: r.token, path: sharePath(r.token), role: r.role, createdBy: r.created_by, createdAt: r.created_at })

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const SETTLE_MS = 3000
const LEASE_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 30_000
/** Runs at once per org. The rest wait their turn. */
const MAX_ACTIVE_RUNS = 3
const DEFAULT_DAILY_RUNS = 50

type MentionRow = {
  id: string; artifact_id: string; kind: Artifact["kind"]; target_key: string; target: string; text: string; requested_by: string
  requested_by_name: string; status: Mention["status"]; mode: Mention["mode"] | null; blocks: string | null; attempts: number
  result: string | null; created_at: string; updated_at: string; resolved: number | null; dispatched_at: number | null
}

const toMention = (r: MentionRow): Mention => ({
  id: r.id,
  artifactId: r.artifact_id,
  kind: r.kind,
  target: JSON.parse(r.target) as MentionTarget,
  text: r.text,
  requestedBy: r.requested_by,
  requestedByName: r.requested_by_name,
  status: r.status,
  mode: r.mode ?? "reply",
  blocks: r.blocks ? (JSON.parse(r.blocks) as Array<string>) : [],
  resolved: !!r.resolved,
  attempts: r.attempts,
  result: r.result,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toArtifact = (r: Row): Artifact => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  createdBy: r.created_by,
  ...(r.created_by_name ? { createdByName: r.created_by_name } : {}),
  ...(r.client ? { client: r.client } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.archived_at ? { archivedAt: r.archived_at } : {}),
  ...(r.folder_id ? { folderId: r.folder_id } : {}),
})

const toFolder = (r: FolderRow): Folder => ({
  id: r.id,
  name: r.name,
  parentId: r.parent_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const actorId = (p: Principal) => (p.actor.type === "agent" ? `${p.actor.id}:${p.actor.onBehalfOf}` : p.actor.id)
const denied = () => ({ ok: false, reason: "forbidden", error: "Read-only: sign in to an account with edit access" }) as const
const notFound = () => ({ ok: false, reason: "not-found", error: "Not found" }) as const
const noFolder = () => ({ ok: false, reason: "not-found", error: "Folder not found" }) as const

function randomId() {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  return Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => alphabet[b % 62]).join("")
}
