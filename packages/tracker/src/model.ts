import {
  issuesOf,
  kindOfId,
  kinds,
  knownAgents,
  type Assignee,
  type Issue,
  type IssuePerson,
  type Member,
  type Run,
  type TrackerState,
} from "@standard-artifacts/protocol"

/** Everyone who can own or be delegated an issue: you, people in the room, and people already on issues. */
export function peopleOf(state: TrackerState | null, self: Member | null, others: ReadonlyArray<Member>): Array<IssuePerson> {
  const out = new Map<string, IssuePerson>()
  const add = (p: IssuePerson | null | undefined) => p && !out.has(p.id) && out.set(p.id, { id: p.id, name: p.name })
  const member = (m: Member | null) => (m && m.actor.type === "user" ? add({ id: m.actor.id, name: m.actor.name }) : undefined)
  member(self)
  others.forEach(member)
  for (const i of state ? issuesOf(state) : []) {
    add(i.owner)
    if (i.delegate?.type === "user") add(i.delegate)
  }
  return [...out.values()]
}

/** People and agents an issue can be delegated to. */
export function assigneesOf(people: ReadonlyArray<IssuePerson>): Array<Assignee> {
  return [...people.map((p): Assignee => ({ type: "user", ...p })), ...knownAgents.map((a): Assignee => ({ type: "agent", ...a }))]
}

/** The signed-in person as an owner, when they're a person (agents and guests don't own work). */
export function selfPerson(self: Member | null): IssuePerson | null {
  return self && self.actor.type === "user" ? { id: self.actor.id, name: self.actor.name } : null
}

export const sameAssignee = (a: Assignee | IssuePerson | null | undefined, b: Assignee | IssuePerson | null | undefined) =>
  (a?.id ?? null) === (b?.id ?? null) && ("type" in (a ?? {}) ? (a as Assignee).type : "user") === ("type" in (b ?? {}) ? (b as Assignee).type : "user")

export const nowIso = () => new Date().toISOString()

/** "2m 13s", "45s", "1h 5m". */
export function duration(fromIso: string, toIso: string | null | undefined, now = Date.now()) {
  const ms = Math.max(0, (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso))
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "just now", "5m ago", "3h ago", "Nov 2". */
export function ago(iso: string, now = Date.now()) {
  const s = Math.round((now - Date.parse(iso)) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** App path of an artifact (and item), for links from runs and sources. */
export function artifactHref(artifactId: string) {
  const kind = kindOfId(artifactId)
  return kind ? `/${kinds[kind].slug}/${artifactId}` : null
}

/** The run currently in flight on an issue, if any. */
export const activeRun = (runs: ReadonlyArray<Run>) => runs.find((r) => r.state === "running")

/** Members with this issue open (people) or working on it (agents, via presence). */
export const membersOn = (issue: Issue, members: ReadonlyArray<Member>) => members.filter((m) => m.presence.issueId === issue.id)

/** An agent's live status line on an issue ("Researching Ramp"), from its presence. */
export function agentStatusOn(issue: Issue, members: ReadonlyArray<Member>) {
  const m = members.find((x) => x.actor.type === "agent" && x.presence.issueId === issue.id)
  return m ? { name: m.name, status: typeof m.presence.status === "string" ? m.presence.status : "Working" } : null
}
