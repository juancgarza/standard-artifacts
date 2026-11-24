import { Schema } from "effect"
import { ArtifactRef, Id } from "./core.ts"
import { applyListOp, listOpSchema, mergePatch, type ListOp, type ListResult, type ListState } from "./list.ts"

/**
 * Tracker surface: issues worked by people and agents (Linear-style).
 *
 * One ordered list holds three kinds of record, so the tracker syncs, persists
 * and replays like boards and docs:
 *   issue    the work: title, status, priority, an owner (always a person) and
 *            a delegate (a person or an agent), plus where it came from
 *   run      one attempt by an agent on an issue: who started it, through which
 *            client (ChatGPT, Claude, Codex…), its state and the steps it took
 *   comment  discussion on an issue
 *
 * Attribution can't be forged: the reducer stamps `createdBy`, `startedBy` and
 * `by` from the op's actor. Times are the writer's own (the op log keeps the
 * server's).
 */

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const Name = Text(80)
/** ISO 8601 timestamp, as written by the client. */
const Time = Text(40)
/** A calendar date, YYYY-MM-DD. */
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))

export const IssueStatus = Schema.Literals(["backlog", "todo", "in_progress", "in_review", "done", "canceled"])
export type IssueStatus = typeof IssueStatus.Type
/** Display order and labels; `open` statuses are the ones still being worked. */
export const issueStatuses: ReadonlyArray<{ id: IssueStatus; label: string; open: boolean }> = [
  { id: "in_progress", label: "In progress", open: true },
  { id: "in_review", label: "In review", open: true },
  { id: "todo", label: "Todo", open: true },
  { id: "backlog", label: "Backlog", open: true },
  { id: "done", label: "Done", open: false },
  { id: "canceled", label: "Canceled", open: false },
]
export const statusLabel = (s: IssueStatus) => issueStatuses.find((x) => x.id === s)?.label ?? s

export const IssuePriority = Schema.Literals(["none", "urgent", "high", "medium", "low"])
export type IssuePriority = typeof IssuePriority.Type
export const issuePriorities: ReadonlyArray<{ id: IssuePriority; label: string }> = [
  { id: "none", label: "No priority" },
  { id: "urgent", label: "Urgent" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
]
export const priorityLabel = (p: IssuePriority) => issuePriorities.find((x) => x.id === p)?.label ?? p

/** A person, by user id. */
export const IssuePerson = Schema.Struct({ id: Text(64), name: Name })
export interface IssuePerson extends Schema.Schema.Type<typeof IssuePerson> {}

/** Who works an issue: a person, or an agent ("claude", "chatgpt", "codex", …). */
export const Assignee = Schema.Union([
  Schema.Struct({ type: Schema.tag("user"), id: Text(64), name: Name }),
  Schema.Struct({ type: Schema.tag("agent"), id: Text(64), name: Name }),
])
export type Assignee = typeof Assignee.Type

/** Agents an issue can be delegated to out of the box. `claude` is the runner (`stdartifacts agent serve`); the others pick up work over MCP. */
export const knownAgents: ReadonlyArray<{ id: string; name: string }> = [
  { id: "claude", name: "Claude" },
  { id: "chatgpt", name: "ChatGPT" },
  { id: "codex", name: "Codex" },
]

/**
 * Where an issue came from, recorded once when it's created: the interface
 * (`via`), the app on the other end when there is one (`client`: "ChatGPT",
 * "Claude", "Codex"…), and the artifact item it was made from.
 */
export const IssueSource = Schema.Struct({
  via: Schema.Literals(["web", "cli", "mcp", "api", "agent"]),
  client: Schema.optionalKey(Name),
  from: Schema.optionalKey(
    Schema.Struct({
      artifactId: Id,
      item: Schema.optionalKey(Text(64)),
      title: Schema.optionalKey(Text(200)),
    }),
  ),
})
export interface IssueSource extends Schema.Schema.Type<typeof IssueSource> {}

export const maxLinks = 30

export const Issue = Schema.Struct({
  type: Schema.tag("issue"),
  id: Id,
  /** Per tracker, from 1. The reducer assigns it, so concurrent creates never collide. */
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  title: Text(300),
  description: Schema.optionalKey(Text(20_000)),
  status: IssueStatus,
  priority: IssuePriority,
  labels: Schema.optionalKey(Schema.Array(Text(40)).check(Schema.isMaxLength(12))),
  /** Accountable person. */
  owner: Schema.optionalKey(Schema.NullOr(IssuePerson)),
  /** Who's doing it: the owner, someone else, or an agent. */
  delegate: Schema.optionalKey(Schema.NullOr(Assignee)),
  due: Schema.optionalKey(Schema.NullOr(Day)),
  /** What this issue is about: boards, tables, docs, trackers, or items in them (other issues included). */
  links: Schema.optionalKey(Schema.Array(ArtifactRef).check(Schema.isMaxLength(maxLinks))),
  source: IssueSource,
  /** actorKey of the creator (stamped). */
  createdBy: Schema.optionalKey(Text(200)),
  createdByName: Schema.optionalKey(Name),
  createdAt: Time,
})
export interface Issue extends Schema.Schema.Type<typeof Issue> {}

export const RunState = Schema.Literals(["running", "needs_review", "done", "failed", "canceled"])
export type RunState = typeof RunState.Type
export const runStateLabel: Record<RunState, string> = {
  running: "Running",
  needs_review: "Needs review",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
}

/** One thing an agent did during a run. `artifactId`/`items` point at what it touched. */
export const RunStep = Schema.Struct({
  at: Time,
  text: Text(500),
  /** The MCP tool, when the step was a tool call. */
  tool: Schema.optionalKey(Text(80)),
  artifactId: Schema.optionalKey(Id),
  items: Schema.optionalKey(Schema.Array(Text(64)).check(Schema.isMaxLength(50))),
  ok: Schema.optionalKey(Schema.Boolean),
})
export interface RunStep extends Schema.Schema.Type<typeof RunStep> {}
export const maxRunSteps = 300

export const Run = Schema.Struct({
  type: Schema.tag("run"),
  id: Id,
  issueId: Id,
  /** The agent, as it shows up in attribution (actorKey and name). */
  agent: Schema.Struct({ id: Text(200), name: Name }),
  /** The app it ran in: "ChatGPT", "Claude", "Codex", "stdartifacts agent serve"… */
  client: Schema.optionalKey(Name),
  model: Schema.optionalKey(Name),
  state: RunState,
  /** actorKey of whoever started the run (stamped). */
  startedBy: Schema.optionalKey(Text(200)),
  startedAt: Time,
  endedAt: Schema.optionalKey(Schema.NullOr(Time)),
  summary: Schema.optionalKey(Schema.NullOr(Text(8_000))),
  steps: Schema.Array(RunStep).check(Schema.isMaxLength(maxRunSteps)),
})
export interface Run extends Schema.Schema.Type<typeof Run> {}

export const IssueComment = Schema.Struct({
  type: Schema.tag("comment"),
  id: Id,
  issueId: Id,
  text: Text(10_000),
  /** actorKey of the author (stamped). */
  by: Schema.optionalKey(Text(200)),
  name: Schema.optionalKey(Name),
  at: Time,
})
export interface IssueComment extends Schema.Schema.Type<typeof IssueComment> {}

export const TrackerItem = Schema.Union([Issue, Run, IssueComment])
export type TrackerItem = typeof TrackerItem.Type

/** One patch shape for every record; the reducer rejects fields that don't belong to the record's type. */
export const TrackerPatch = Schema.Struct({
  // issue
  title: Schema.optionalKey(Text(300)),
  description: Schema.optionalKey(Text(20_000)),
  status: Schema.optionalKey(IssueStatus),
  priority: Schema.optionalKey(IssuePriority),
  labels: Schema.optionalKey(Schema.Array(Text(40)).check(Schema.isMaxLength(12))),
  owner: Schema.optionalKey(Schema.NullOr(IssuePerson)),
  delegate: Schema.optionalKey(Schema.NullOr(Assignee)),
  due: Schema.optionalKey(Schema.NullOr(Day)),
  links: Schema.optionalKey(Schema.Array(ArtifactRef).check(Schema.isMaxLength(maxLinks))),
  // run
  state: Schema.optionalKey(RunState),
  summary: Schema.optionalKey(Schema.NullOr(Text(8_000))),
  endedAt: Schema.optionalKey(Schema.NullOr(Time)),
  // comment
  text: Schema.optionalKey(Text(10_000)),
})
export interface TrackerPatch extends Schema.Schema.Type<typeof TrackerPatch> {}

const patchFields: Record<TrackerItem["type"], ReadonlySet<string>> = {
  issue: new Set(["title", "description", "status", "priority", "labels", "owner", "delegate", "due", "links"]),
  run: new Set(["state", "summary", "endedAt"]),
  comment: new Set(["text"]),
}

/** Append a step to a run. Its own op, so steps logged at the same time never overwrite each other. */
export const RunStepOp = Schema.Struct({ type: Schema.tag("runStep"), run: Id, step: RunStep })
export interface RunStepOp extends Schema.Schema.Type<typeof RunStepOp> {}

export const TrackerOp = Schema.Union([listOpSchema(TrackerItem, TrackerPatch), RunStepOp])
export type TrackerOp = ListOp<TrackerItem, TrackerPatch> | RunStepOp
export const decodeTrackerOp = Schema.decodeUnknownResult(TrackerOp)

export const TrackerState = Schema.Struct({ items: Schema.Array(TrackerItem) })
export interface TrackerState extends ListState<TrackerItem> {}

export type TrackerPresence = {
  /** The issue this member has open. */
  issueId?: string | null
  thinking?: boolean
  status?: string
}

export const isIssue = (i: TrackerItem): i is Issue => i.type === "issue"
export const isRun = (i: TrackerItem): i is Run => i.type === "run"
export const isComment = (i: TrackerItem): i is IssueComment => i.type === "comment"
export const issuesOf = (s: TrackerState) => s.items.filter(isIssue)
export const runsOf = (s: TrackerState, issueId: string) => s.items.filter((i): i is Run => isRun(i) && i.issueId === issueId)
export const commentsOf = (s: TrackerState, issueId: string) => s.items.filter((i): i is IssueComment => isComment(i) && i.issueId === issueId)
/** An issue by id, or by number ("12", "#12"). */
export const findIssue = (s: TrackerState, ref: string): Issue | undefined => {
  const n = /^#?(\d+)$/.exec(ref.trim())?.[1]
  return issuesOf(s).find((i) => i.id === ref || (n !== undefined && i.number === Number(n)))
}

const fail = (error: string): ListResult<TrackerItem> => ({ ok: false, error })

/**
 * The tracker's reducer, shared by the cell (authoritative) and browsers
 * (optimistic). Beyond list semantics it numbers new issues, stamps who did
 * what, keeps runs and comments attached to a real issue (removing an issue
 * removes them), only lets authors edit their comments, and appends run steps.
 */
export function applyTrackerOp(state: TrackerState, op: TrackerOp, by: string): ListResult<TrackerItem> {
  const byId = (id: string) => state.items.find((i) => i.id === id)
  const issueExists = (id: string) => byId(id)?.type === "issue"

  switch (op.type) {
    case "runStep": {
      const run = byId(op.run)
      if (!run || run.type !== "run") return fail("Unknown run")
      if (run.steps.length >= maxRunSteps) return fail(`A run keeps at most ${maxRunSteps} steps`)
      return applyListOp(state, { type: "update", id: run.id, patch: {} }, () => ({ ...run, steps: [...run.steps, op.step] }))
    }
    case "insert": {
      const item = op.item
      if (item.type === "issue") {
        const number = issuesOf(state).reduce((n, i) => Math.max(n, i.number), 0) + 1
        return applyListOp(state, { ...op, item: { ...item, number, createdBy: by } }, merge)
      }
      if (!issueExists(item.issueId)) return fail("Unknown issue")
      if (item.type === "run") return applyListOp(state, { ...op, item: { ...item, startedBy: by } }, merge)
      return applyListOp(state, { ...op, item: { ...item, by } }, merge)
    }
    case "update": {
      const item = byId(op.id)
      if (!item) return fail("Unknown item")
      const allowed = patchFields[item.type]
      const extra = Object.keys(op.patch).find((k) => op.patch[k as keyof TrackerPatch] !== undefined && !allowed.has(k))
      if (extra) return fail(`Can't set ${extra} on ${item.type === "issue" ? "an issue" : `a ${item.type}`}`)
      if (item.type === "comment" && item.by !== undefined && item.by !== by) return fail("Only the author can edit a comment")
      return applyListOp(state, op, merge)
    }
    case "remove": {
      const drop = new Set(op.ids)
      // Runs and comments go with their issue.
      for (const i of state.items) if (i.type !== "issue" && drop.has(i.issueId)) drop.add(i.id)
      return applyListOp(state, { ...op, ids: [...drop] }, merge)
    }
    case "move": {
      const item = byId(op.id)
      if (item && item.type !== "issue") return fail("Only issues can be reordered")
      return applyListOp(state, op, merge)
    }
  }
}

const merge = (item: TrackerItem, patch: TrackerPatch): TrackerItem => mergePatch(item as Issue & Run & IssueComment, patch as Partial<Issue & Run & IssueComment>)

const ago = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "")

/** Compact text for agents (MCP `read_artifact`, the content API): open issues by status, then closed ones, with their runs. */
export function trackerToText(state: TrackerState): string {
  const issues = issuesOf(state)
  if (!issues.length) return "No issues yet."
  const line = (i: Issue) => {
    const bits = [
      `#${i.number} ${i.title}`,
      `[${statusLabel(i.status)}]`,
      i.priority !== "none" ? `[${priorityLabel(i.priority)}]` : "",
      i.owner ? `owner ${i.owner.name}` : "",
      i.delegate ? `delegate ${i.delegate.name}${i.delegate.type === "agent" ? " (agent)" : ""}` : "",
      i.labels?.length ? `labels ${i.labels.join(", ")}` : "",
      i.due ? `due ${i.due}` : "",
      `id ${i.id}`,
    ].filter(Boolean)
    const out = [bits.join(" · ")]
    if (i.description) out.push(`  ${i.description.replace(/\s+/g, " ").slice(0, 280)}${i.description.length > 280 ? "…" : ""}`)
    for (const r of runsOf(state, i.id)) {
      out.push(`  run ${r.id}: ${r.agent.name}${r.client ? ` via ${r.client}` : ""} · ${runStateLabel[r.state]} · ${r.steps.length} steps · started ${ago(r.startedAt)}${r.summary ? ` · ${r.summary.replace(/\s+/g, " ").slice(0, 160)}` : ""}`)
    }
    if (i.links?.length) out.push(`  links ${i.links.map((l) => (l.item ? `${l.artifactId}/${l.item}` : l.artifactId)).join(", ")}`)
    const comments = commentsOf(state, i.id).length
    if (comments) out.push(`  ${comments} comment${comments === 1 ? "" : "s"}`)
    return out.join("\n")
  }
  return issueStatuses
    .flatMap((s) => {
      const group = issues.filter((i) => i.status === s.id)
      return group.length ? [`## ${s.label} (${group.length})`, ...group.map(line), ""] : []
    })
    .join("\n")
    .trim()
}

/** Artifacts an issue's runs touched (from their steps), most recent first, without repeats. `except`: the tracker itself. */
export function touchedByRuns(state: TrackerState, issueId: string, except?: string): Array<string> {
  const seen = new Set<string>(except ? [except] : [])
  const out: Array<string> = []
  for (const r of [...runsOf(state, issueId)].reverse()) {
    for (const s of [...r.steps].reverse()) {
      if (s.artifactId && !seen.has(s.artifactId)) {
        seen.add(s.artifactId)
        out.push(s.artifactId)
      }
    }
  }
  return out
}
