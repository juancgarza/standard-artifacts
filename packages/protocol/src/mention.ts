import { Schema } from "effect"
import { ArtifactKind, Id, kindOrder, kinds } from "./core.ts"

/**
 * @-mentions wake agents. When a person's edit adds "@claude" to a doc block,
 * board shape or table cell, the cell files a mention in the org's inbox; a
 * runner claims it, works in place (with presence), and completes it.
 *
 * Only an *increase* in mentions inside an item files a job, so editing a block
 * that already mentioned an agent doesn't re-run it. Agent edits never file
 * mentions, so agents can't wake each other into loops.
 */

/** Names that wake the agent runner. */
export const mentionAgents = ["claude", "agent"] as const

const mentionPattern = new RegExp(`(^|[^\\w@])@(${mentionAgents.join("|")})(?![\\w-])`, "gi")

export const countMentions = (text: string) => [...text.matchAll(mentionPattern)].length

/**
 * Where a mention sits: a doc block, a board shape, a table cell, or a spot on
 * a board (a request about an area or the view, pinned where it was asked).
 */
export const MentionTarget = Schema.Union([
  Schema.Struct({ type: Schema.tag("block"), id: Id }),
  Schema.Struct({ type: Schema.tag("shape"), id: Id }),
  Schema.Struct({ type: Schema.tag("cell"), rowId: Id, colId: Id }),
  Schema.Struct({ type: Schema.tag("point"), x: Schema.Finite, y: Schema.Finite }),
])
export type MentionTarget = typeof MentionTarget.Type

/** Requests on the same target form one thread (follow-ups, then Resolve). */
export const targetKey = (t: MentionTarget) =>
  t.type === "cell" ? `cell:${t.rowId}:${t.colId}` : t.type === "point" ? `point:${Math.round(t.x)}:${Math.round(t.y)}` : `${t.type}:${t.id}`

export const MentionStatus = Schema.Literals(["queued", "running", "done", "error", "cancelled"])

/**
 * reply: answer next to the request (new blocks/notes/cells).
 * edit: rewrite the given doc blocks in place (as reviewable suggestions).
 */
export const MentionMode = Schema.Literals(["reply", "edit"])
export type MentionMode = typeof MentionMode.Type
export type MentionStatus = typeof MentionStatus.Type

export const Mention = Schema.Struct({
  id: Schema.String,
  artifactId: Id,
  kind: ArtifactKind,
  target: MentionTarget,
  /** The item's text when the mention settled: the request. */
  text: Schema.String,
  requestedBy: Schema.String,
  requestedByName: Schema.String,
  status: MentionStatus,
  mode: MentionMode,
  /** The items a request is about, in order: doc blocks an edit covers, or the board shapes selected when asking. */
  blocks: Schema.Array(Id),
  /** Resolved threads are done with: their pins leave the canvas. */
  resolved: Schema.Boolean,
  attempts: Schema.Int,
  result: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /**
   * Set on a queued request the hosted runner won't take, because hosted runs
   * are for paying workspaces (`plan`) or the trial's allowance is used up
   * (`trial-limit`). The request stays filed for the person's own agent
   * (`stdartifacts agent serve`, or MCP); `message` says so, for the app to show.
   */
  unhosted: Schema.optionalKey(Schema.Struct({ reason: Schema.Literals(["plan", "trial-limit"]), message: Schema.String })),
})
export interface Mention extends Schema.Schema.Type<typeof Mention> {}

export const ClaimMention = Schema.Struct({
  runner: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  /** Only claim mentions in this artifact (a runner dedicated to one board, say). */
  artifactId: Schema.optionalKey(Id),
})
/** An explicit request (the "Ask Claude" bar): no "@" needed, claimable immediately. */
export const CreateMention = Schema.Struct({
  artifactId: Id,
  target: MentionTarget,
  text: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  mode: Schema.optionalKey(MentionMode),
  blocks: Schema.optionalKey(Schema.Array(Id).check(Schema.isMaxLength(200))),
})
export interface CreateMention extends Schema.Schema.Type<typeof CreateMention> {}

export const CompleteMention = Schema.Struct({
  status: Schema.Literals(["done", "error"]),
  result: Schema.String.check(Schema.isMaxLength(4000)),
})

/** A new or grown mention inside one item, found by diffing states. */
export type MentionHit = { readonly target: MentionTarget; readonly text: string }

type Item = { readonly id: string; readonly text?: string | undefined }
type ListLike = { readonly items: ReadonlyArray<Item> }
type TableLike = { readonly cells: Readonly<Record<string, { readonly v: unknown }>> }

const isList = (s: unknown): s is ListLike => typeof s === "object" && s !== null && Array.isArray((s as { items?: unknown }).items)
const isTable = (s: unknown): s is TableLike => typeof s === "object" && s !== null && typeof (s as { cells?: unknown }).cells === "object"

/** item key → (target, text) for every item whose text could hold a mention. */
function texts(kind: ArtifactKind, state: unknown): Map<string, MentionHit> {
  const out = new Map<string, MentionHit>()
  if (kind === "table" && isTable(state)) {
    for (const [key, cell] of Object.entries(state.cells)) {
      if (typeof cell.v !== "string") continue
      const [rowId, colId] = key.split(":")
      if (rowId && colId) out.set(key, { target: { type: "cell", rowId, colId }, text: cell.v })
    }
  } else if ((kind === "board" || kind === "doc") && isList(state)) {
    for (const item of state.items) {
      if (typeof item.text === "string") out.set(item.id, { target: { type: kind === "doc" ? "block" : "shape", id: item.id }, text: item.text })
    }
  }
  return out
}

/** Items whose mention count grew between two states (e.g. "@claude" was just typed). */
export function mentionsAdded(kind: ArtifactKind, before: unknown, after: unknown): Array<MentionHit> {
  const prev = texts(kind, before)
  const hits: Array<MentionHit> = []
  for (const [key, hit] of texts(kind, after)) {
    const n = countMentions(hit.text)
    if (n > 0 && n > countMentions(prev.get(key)?.text ?? "")) hits.push(hit)
  }
  return hits
}

/** Items whose text changed while still mentioning an agent: keeps a queued request's text current. */
export function mentionsEdited(kind: ArtifactKind, before: unknown, after: unknown): Array<MentionHit> {
  const prev = texts(kind, before)
  return [...texts(kind, after)].flatMap(([key, hit]) =>
    countMentions(hit.text) > 0 && prev.get(key)?.text !== hit.text ? [hit] : [],
  )
}

/** Artifact ids carry their kind as a prefix: b_…, t_…, d_…, i_…. */
export const kindOfId = (id: string): ArtifactKind | undefined => kindOrder.find((k) => id.startsWith(`${kinds[k].prefix}_`))
