import { Schema } from "effect"
import { Actor, Id } from "./core.ts"

/**
 * The room wire protocol, shared by every surface (table, board, doc).
 * A room is one cell. It holds the authoritative state, applies ops in order,
 * and fans them out. Surfaces only define their own op and presence shapes.
 */

export const Presence = Schema.Record(Schema.String, Schema.Json)
export type Presence = typeof Presence.Type

export const Member = Schema.Struct({
  /** Unique per connection (people) or per agent run (agents). */
  connectionId: Schema.String,
  actor: Actor,
  name: Schema.String,
  color: Schema.String,
  readOnly: Schema.Boolean,
  presence: Presence,
})
export interface Member extends Schema.Schema.Type<typeof Member> {}

export const PresenceMessage = Schema.Struct({ type: Schema.tag("presence"), presence: Presence })
export const OpMessage = Schema.Struct({ type: Schema.tag("op"), id: Schema.String, op: Schema.Unknown })
export const ClientMessage = Schema.Union([PresenceMessage, OpMessage])
export type ClientMessage = typeof ClientMessage.Type

export type ServerMessage<State = unknown, Op = unknown> =
  | { type: "init"; self: Member; members: ReadonlyArray<Member>; state: State; seq: number }
  | { type: "join"; member: Member }
  | { type: "leave"; connectionId: string }
  | { type: "presence"; connectionId: string; presence: Presence }
  | { type: "op"; seq: number; op: Op; actorId: string; origin?: string; clientOpId?: string }
  | { type: "reject"; id: string; error: string }

/** Body for agents (and scripts) posting ops over HTTP. */
export const OpsBatch = Schema.Struct({
  ops: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
})
export interface OpsBatch extends Schema.Schema.Type<typeof OpsBatch> {}

export const OpsApplied = Schema.Struct({ applied: Schema.Int, seq: Schema.Int })
export interface OpsApplied extends Schema.Schema.Type<typeof OpsApplied> {}

/** Body for agents announcing themselves; ttl 0 removes the agent. */
export const AgentPresence = Schema.Struct({
  runId: Id,
  presence: Presence,
  ttl: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 600 })),
})
export interface AgentPresence extends Schema.Schema.Type<typeof AgentPresence> {}

const palette = ["#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#8e4ec6", "#d6409f"] as const

export function colorFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0
  return palette[Math.abs(h) % palette.length] ?? palette[0]
}

export function actorName(actor: Actor): string {
  switch (actor.type) {
    case "user":
      return actor.name
    case "guest":
      return "Guest"
    case "agent":
      return actor.name ?? "Agent"
  }
}

export const actorKey = (actor: Actor) => (actor.type === "agent" ? `${actor.id}:${actor.onBehalfOf}` : actor.id)
