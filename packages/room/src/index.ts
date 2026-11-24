import type { Member, Presence, ServerMessage } from "@standard-artifacts/protocol"

/**
 * Browser side of a room: one WebSocket into one cell.
 *
 * State model (the classic server-authoritative pattern):
 *   confirmed  last state the cell acknowledged, advanced only by server ops
 *   pending    local ops sent but not yet echoed back
 *   view       confirmed with pending re-applied on top, which is what the UI renders
 *
 * When the server echoes one of our ops it drops out of `pending`. If the cell
 * rejects one, it is dropped and `error` is set. On reconnect the cell sends a
 * fresh snapshot and unacknowledged ops are re-sent.
 */

export type Apply<S, O> = (state: S, op: O, by: string) => { ok: true; state: S } | { ok: false; error: string }

export type RoomStatus = "connecting" | "open" | "reconnecting" | "closed"

export interface RoomSnapshot<S> {
  readonly status: RoomStatus
  readonly state: S | null
  readonly self: Member | null
  readonly others: ReadonlyArray<Member>
  readonly error: string | null
}

export interface RoomOptions<S, O> {
  /** ws:// or wss:// URL of the room. */
  readonly url: string
  readonly apply: Apply<S, O>
  /** The actor key the cell will attribute our ops to (used for optimistic attribution). */
  readonly actorKey: string
}

type Pending<O> = { id: string; op: O }

export class RoomClient<S, O> {
  private ws: WebSocket | null = null
  private confirmed: S | null = null
  private pending: Array<Pending<O>> = []
  private members = new Map<string, Member>()
  private listeners = new Set<() => void>()
  private attempts = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false
  private presence: Presence = {}
  private snapshot: RoomSnapshot<S> = { status: "connecting", state: null, self: null, others: [], error: null }
  private selfMember: Member | null = null

  constructor(private readonly options: RoomOptions<S, O>) {}

  // --- External store contract (works with React's useSyncExternalStore) -------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  // --- Lifecycle ------------------------------------------------------------------

  /** Safe to call again after close(): what the client holds stays on screen until the cell's fresh snapshot arrives. */
  connect() {
    this.closedByUser = false
    if (this.ws) return
    if (this.snapshot.status === "closed") this.emit({ status: "connecting" })
    const ws = new WebSocket(this.options.url)
    this.ws = ws
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMessage<S, O>)
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.ws = null
      // 4004: the artifact was deleted; 1008/4001-4003: auth problems. Don't retry those.
      if (this.closedByUser || e.code === 4004 || (e.code >= 4001 && e.code <= 4003) || e.code === 1008) {
        return this.emit({ status: "closed" })
      }
      this.scheduleReconnect()
    }
  }

  close() {
    this.closedByUser = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close(1000)
    this.ws = null
    // Who's here is only known while connected; the next init reports it again.
    this.members.clear()
    this.emit({ status: "closed", others: [] })
  }

  /** Ops sent (or queued) that the cell hasn't echoed back yet. */
  get unacknowledged() {
    return this.pending.length
  }

  private scheduleReconnect() {
    this.emit({ status: "reconnecting" })
    const delay = Math.min(10_000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5)
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  // --- Writes ------------------------------------------------------------------------

  /** Apply locally right away, then send. Returns false if the op is invalid locally. */
  send(op: O): boolean {
    const view = this.snapshot.state
    if (!view || this.selfMember?.readOnly) return false
    const local = this.options.apply(view, op, this.options.actorKey)
    if (!local.ok) {
      this.emit({ error: local.error })
      return false
    }
    const item = { id: crypto.randomUUID(), op }
    this.pending.push(item)
    this.emit({ state: local.state, error: null })
    this.transmit(item)
    return true
  }

  setPresence(presence: Presence) {
    this.presence = presence
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "presence", presence }))
  }

  private transmit(item: Pending<O>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "op", id: item.id, op: item.op }))
  }

  // --- Server messages ------------------------------------------------------------

  private onMessage(msg: ServerMessage<S, O>) {
    switch (msg.type) {
      case "init": {
        this.attempts = 0
        this.confirmed = msg.state
        this.selfMember = msg.self
        this.members = new Map(msg.members.map((m) => [m.connectionId, m]))
        if (Object.keys(this.presence).length) this.setPresence(this.presence)
        // Rebase first: an op the snapshot already includes (an add whose echo was lost) no longer applies, and is dropped rather than re-sent.
        const state = this.rebase()
        for (const item of this.pending) this.transmit(item)
        return this.emit({ status: "open", self: msg.self, state, others: this.othersList() })
      }
      case "op": {
        if (!this.confirmed) return
        const next = this.options.apply(this.confirmed, msg.op, msg.actorId)
        if (next.ok) this.confirmed = next.state
        if (msg.origin === this.selfMember?.connectionId && msg.clientOpId) {
          this.pending = this.pending.filter((p) => p.id !== msg.clientOpId)
        }
        return this.emit({ state: this.rebase() })
      }
      case "reject": {
        this.pending = this.pending.filter((p) => p.id !== msg.id)
        return this.emit({ state: this.rebase(), error: msg.error })
      }
      case "join":
        this.members.set(msg.member.connectionId, msg.member)
        return this.emit({ others: this.othersList() })
      case "leave":
        this.members.delete(msg.connectionId)
        return this.emit({ others: this.othersList() })
      case "presence": {
        const m = this.members.get(msg.connectionId)
        if (m) this.members.set(msg.connectionId, { ...m, presence: msg.presence })
        return this.emit({ others: this.othersList() })
      }
    }
  }

  /** confirmed + pending, dropping pending ops that no longer apply. */
  private rebase(): S | null {
    if (this.confirmed === null) return null
    let state: S = this.confirmed
    this.pending = this.pending.filter((p) => {
      const r = this.options.apply(state, p.op, this.options.actorKey)
      if (r.ok) state = r.state
      return r.ok
    })
    return state
  }

  private othersList() {
    return [...this.members.values()]
  }

  private emit(patch: Partial<RoomSnapshot<S>>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const l of this.listeners) l()
  }
}
