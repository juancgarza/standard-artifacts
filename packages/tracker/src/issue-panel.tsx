import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowSquareOutIcon, ArrowsOutSimpleIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react"
import {
  commentsOf,
  issuePriorities,
  issueStatuses,
  newId,
  runsOf,
  runStateLabel,
  type Issue,
  type IssueComment,
  type Member,
  type Run,
  type RunState,
  type TrackerOp,
  type TrackerPatch,
  type TrackerState,
} from "@standard-artifacts/protocol"
import { BrandMark, brandOf } from "@standard-artifacts/room/brands"
import { AssigneeAvatar, PriorityIcon, StatusIcon } from "./icons"
import { LinkedSection, type Workspace } from "./links"
import { Markdown, MarkdownLinksContext, type MarkdownLinks } from "./markdown"
import { PropertyMenu } from "./menu"
import { agentStatusOn, ago, artifactHref, assigneesOf, duration, nowIso, peopleOf, sameAssignee } from "./model"

/**
 * One issue, on the right of the list: title and description edited in place,
 * properties, where it came from, and its activity: agent runs (with every
 * step they took) and comments, oldest first.
 */
export function IssuePanel({
  issue,
  state,
  self,
  others,
  readOnly,
  trackerId,
  workspace,
  send,
  onClose,
  onOpenIssue,
  layout = "panel",
  onExpand,
}: {
  issue: Issue
  state: TrackerState
  self: Member | null
  others: ReadonlyArray<Member>
  readOnly: boolean
  trackerId: string | undefined
  workspace: Workspace | undefined
  send: (op: TrackerOp) => boolean
  onClose: () => void
  onOpenIssue: (issueId: string) => void
  /** "panel": beside the list (a peek). "page": the issue's own page, properties in a sidebar. */
  layout?: "panel" | "page"
  /** Panel only: open this issue as a page. */
  onExpand?: () => void
}) {
  const update = (patch: TrackerPatch) => send({ type: "update", id: issue.id, patch })
  const people = useMemo(() => peopleOf(state, self, others), [state, self, others])
  const runs = runsOf(state, issue.id)
  const comments = commentsOf(state, issue.id)
  const live = agentStatusOn(issue, others)
  const activity = useMemo(
    () =>
      [
        ...runs.map((r) => ({ at: r.startedAt, run: r as Run | undefined, comment: undefined as IssueComment | undefined })),
        ...comments.map((c) => ({ at: c.at, run: undefined as Run | undefined, comment: c as IssueComment | undefined })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [runs, comments],
  )

  const page = layout === "page"
  const mdLinks = useMemo<MarkdownLinks>(
    () => ({
      ...(workspace && { openArtifact: workspace.open }),
      openIssue: (n) => {
        const target = state.items.find((i) => i.type === "issue" && i.number === n)
        if (target) onOpenIssue(target.id)
      },
      hasIssue: (n) => state.items.some((i) => i.type === "issue" && i.number === n),
      ...(trackerId && { trackerId }),
    }),
    [workspace, state, onOpenIssue, trackerId],
  )
  const titleBlock = (
    <div className={page ? "" : "px-5 pt-4"}>
      <EditableText
        value={issue.title}
        readOnly={readOnly}
        label="Title"
        singleLine
        onCommit={(title) => title.trim() && update({ title: title.trim() })}
        className={page ? "text-[26px] leading-9 font-semibold tracking-tight" : "text-[19px] leading-7 font-semibold"}
      />
      <EditableText
        value={issue.description ?? ""}
        readOnly={readOnly}
        label="Description"
        placeholder="Add a description…"
        onCommit={(description) => update({ description })}
        className={page ? "mt-3 text-[15px] leading-7" : "mt-2 text-[14px] leading-6"}
        render={(text) => (text ? <Markdown text={text} className="text-[14px] leading-6" /> : null)}
      />
    </div>
  )
  const properties = (
    <dl aria-label="Properties" className={page ? "grid grid-cols-[80px_1fr] items-center gap-x-2 gap-y-1 text-[13px]" : "mt-4 grid grid-cols-[96px_1fr] items-center gap-x-2 gap-y-1 border-y border-border px-5 py-3 text-[13px]"}>
      <dt className="text-muted">Status</dt>
      <dd>
        <PropertyMenu
          label="Status"
          value={issue.status}
          disabled={readOnly}
          onChange={(status) => update({ status })}
          options={issueStatuses.map((s) => ({ value: s.id, label: s.label, icon: <StatusIcon status={s.id} /> }))}
          className="h-7 px-1.5"
        >
          <StatusIcon status={issue.status} /> {issueStatuses.find((s) => s.id === issue.status)?.label}
        </PropertyMenu>
      </dd>
      <dt className="text-muted">Priority</dt>
      <dd>
        <PropertyMenu
          label="Priority"
          value={issue.priority}
          disabled={readOnly}
          onChange={(priority) => update({ priority })}
          options={issuePriorities.map((p) => ({ value: p.id, label: p.label, icon: <PriorityIcon priority={p.id} /> }))}
          className="h-7 px-1.5"
        >
          <PriorityIcon priority={issue.priority} /> {issuePriorities.find((p) => p.id === issue.priority)?.label}
        </PropertyMenu>
      </dd>
      <dt className="text-muted">Owner</dt>
      <dd>
        <PropertyMenu
          label="Owner"
          value={issue.owner ?? null}
          disabled={readOnly}
          equals={sameAssignee}
          onChange={(owner) => update({ owner })}
          options={[{ value: null, label: "No owner" }, ...people.map((p) => ({ value: p, label: p.name, icon: <AssigneeAvatar who={p} size={16} /> }))]}
          className="h-7 px-1.5"
        >
          <AssigneeAvatar who={issue.owner ?? null} size={18} /> {issue.owner?.name ?? <span className="text-faint">No owner</span>}
        </PropertyMenu>
      </dd>
      <dt className="text-muted">Delegate</dt>
      <dd>
        <PropertyMenu
          label="Delegate"
          value={issue.delegate ?? null}
          disabled={readOnly}
          equals={sameAssignee}
          onChange={(delegate) => update({ delegate })}
          options={[
            { value: null, label: "Not delegated" },
            ...assigneesOf(people).map((a) => ({ value: a, label: a.name, icon: <AssigneeAvatar who={a} size={16} />, section: a.type === "agent" ? "Agents" : "People" })),
          ]}
          className="h-7 px-1.5"
        >
          <AssigneeAvatar who={issue.delegate ?? null} size={18} />
          {issue.delegate ? (
            <>
              {issue.delegate.name}
              {issue.delegate.type === "agent" && <span className="rounded bg-hover px-1 text-[11px] text-muted">Agent</span>}
            </>
          ) : (
            <span className="text-faint">Not delegated</span>
          )}
        </PropertyMenu>
      </dd>
      <dt className="text-muted">Labels</dt>
      <dd>
        <LabelsField labels={issue.labels ?? []} readOnly={readOnly} onChange={(labels) => update({ labels })} />
      </dd>
      <dt className="text-muted">Due</dt>
      <dd>
        <input
          type="date"
          aria-label="Due date"
          value={issue.due ?? ""}
          disabled={readOnly}
          onChange={(e) => update({ due: e.target.value || null })}
          className="h-7 rounded-md bg-transparent px-1.5 text-[13px] text-text outline-none enabled:hover:bg-hover"
        />
      </dd>
    </dl>
  )
  const agentNote = (
    <>
      {issue.delegate?.type === "agent" && (
        <p className={`${page ? "mt-6" : "mx-5 mt-3"} rounded-lg bg-surface px-3 py-2 text-[12.5px] text-muted`}>
          {issue.delegate.name} is working this issue; {issue.owner ? `${issue.owner.name} stays accountable` : "it has no owner yet"}. Each run {issue.delegate.name} makes, and every step in it, is recorded below.
        </p>
      )}
    </>
  )
  const linked = (
    <LinkedSection
      issue={issue}
      trackerId={trackerId}
      state={state}
      workspace={workspace}
      readOnly={readOnly}
      onChange={(links) => update({ links })}
      onOpenIssue={onOpenIssue}
      page={page}
    />
  )
  const activityBlock = (
    <section aria-label="Activity" className={page ? "mt-8 border-t border-border pt-6" : "px-5 pt-4 pb-6"}>
      <h2 className="mb-3 text-[13px] font-medium">Activity</h2>
      <ol className="space-y-3">
        <li className="flex items-start gap-2.5 text-[12.5px] text-muted" data-issue-source>
          <span className="mt-0.5 size-1.5 shrink-0 translate-y-1 rounded-full bg-faint" />
          <span>
            <span className="text-text">{issue.createdByName ?? "Someone"}</span> created this{" "}
            {issue.source.client ? (
              <>
                via <SourceMark issue={issue} />
                {issue.source.client}
                {issue.source.via === "mcp" ? " (MCP)" : ""}
              </>
            ) : (
              sourceText(issue)
            )}
            {issue.source.from && <SourceLink from={issue.source.from} open={workspace?.open} />} · {ago(issue.createdAt)}
          </span>
        </li>
        {activity.map((a) =>
          a.run ? (
            <li key={a.run.id}>
              <RunCard run={a.run} live={a.run.state === "running" ? live : null} readOnly={readOnly} open={workspace?.open} onState={(s) => send({ type: "update", id: a.run!.id, patch: { state: s, ...(s !== "running" && !a.run!.endedAt && { endedAt: nowIso() }) } })} />
            </li>
          ) : (
            <li key={a.comment!.id}>
              <CommentItem comment={a.comment!} />
            </li>
          ),
        )}
      </ol>
      {!readOnly && <CommentBox onSubmit={(text) => send({ type: "insert", item: { type: "comment", id: newId("c_"), issueId: issue.id, text, at: nowIso(), ...(self && { name: self.name }) } })} />}
    </section>
  )

  if (page)
    return (
      <MarkdownLinksContext.Provider value={mdLinks}>
      <div data-issue-page={issue.id} className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <article aria-label={`Issue #${issue.number}`} className="mx-auto max-w-[780px] px-5 pt-8 pb-20 md:px-10">
            {titleBlock}
            {/* Narrow screens: properties sit under the title instead of in a sidebar. */}
            <div className="mt-6 rounded-lg border border-border p-3 lg:hidden">{properties}</div>
            {agentNote}
            {linked}
            {activityBlock}
          </article>
        </div>
        <aside aria-label="Issue details" className="hidden w-[320px] shrink-0 space-y-3 overflow-y-auto border-l border-border bg-surface/40 p-4 lg:block">
          <div className="rounded-lg border border-border bg-bg p-3">
            <div className="mb-1.5 text-[12px] font-medium text-muted">Properties</div>
            {properties}
          </div>
          <div className="rounded-lg border border-border bg-bg p-3 text-[12.5px] text-muted" data-issue-origin>
            <div className="mb-1.5 text-[12px] font-medium">Source</div>
            <p>
              {issue.source.client ? <>Via <SourceMark issue={issue} />{issue.source.client}{issue.source.via === "mcp" ? " (MCP)" : ""}</> : sourceText(issue).replace(/^./, (c) => c.toUpperCase())}
            </p>
            {issue.source.from && (
              <p className="mt-1">
                From <SourceLink from={issue.source.from} open={workspace?.open} bare />
              </p>
            )}
            <p className="mt-1">Created {new Date(issue.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{issue.createdByName ? ` by ${issue.createdByName}` : ""}</p>
          </div>
        </aside>
      </div>
      </MarkdownLinksContext.Provider>
    )

  return (
    <MarkdownLinksContext.Provider value={mdLinks}>
    <aside
      aria-label={`Issue #${issue.number}`}
      data-issue-panel={issue.id}
      className="flex w-full max-w-[560px] min-w-0 shrink-0 flex-col border-l border-border bg-bg max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:shadow-xl"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
        <span className="font-medium text-muted">#{issue.number}</span>
        <div className="flex-1" />
        {onExpand && (
          <button type="button" aria-label="Open issue page" title="Open as a page" onClick={onExpand} className="grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text">
            <ArrowsOutSimpleIcon size={15} />
          </button>
        )}
        <button type="button" aria-label="Close issue" onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text">
          <XIcon size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {titleBlock}
        {properties}
        {agentNote}
        {linked}
        {activityBlock}
      </div>
    </aside>
    </MarkdownLinksContext.Provider>
  )
}

/** The client's mark before "via ChatGPT (MCP)". */
function SourceMark({ issue }: { issue: Issue }) {
  const brand = brandOf(issue.source.client)
  return brand ? (
    <span className="mx-0.5 inline-flex translate-y-[3px]">
      <BrandMark brand={brand} size={14} />
    </span>
  ) : null
}

/** "via ChatGPT (MCP)", "from the web", "via the CLI". */
export function sourceText(issue: Issue) {
  const s = issue.source
  if (s.client) return `via ${s.client}${s.via === "mcp" ? " (MCP)" : ""}`
  switch (s.via) {
    case "web":
      return "in the app"
    case "cli":
      return "with the CLI"
    case "mcp":
      return "over MCP"
    case "api":
      return "through the API"
    case "agent":
      return "as an agent"
  }
}

function SourceLink({ from, open, bare }: { from: NonNullable<Issue["source"]["from"]>; open: ((id: string) => void) | undefined; bare?: boolean }) {
  const href = artifactHref(from.artifactId)
  const label = from.title ?? from.artifactId
  return (
    <>
      {bare ? "" : " from "}
      {href ? (
        <a href={href} onClick={inApp(open, from.artifactId)} className="text-text underline decoration-border underline-offset-2 hover:decoration-text">
          {label}
        </a>
      ) : (
        label
      )}
    </>
  )
}

const stateTone: Record<RunState, string> = {
  running: "bg-accent/10 text-accent",
  needs_review: "bg-[#e5a400]/15 text-[#a87800] dark:text-[#f2c14e]",
  done: "bg-[#1e9e6a]/12 text-[#1e9e6a]",
  failed: "bg-danger/10 text-danger",
  canceled: "bg-hover text-muted",
}

/** Follow an artifact link inside the app (no page reload) when the host can navigate. */
const inApp = (open: ((id: string) => void) | undefined, artifactId: string) => (e: React.MouseEvent) => {
  if (!open || e.metaKey || e.ctrlKey || e.shiftKey) return
  e.preventDefault()
  open(artifactId)
}

/** One agent run: who and where, its state and time, the summary, and every step (collapsed past the last few). */
function RunCard({
  run,
  live,
  readOnly,
  open,
  onState,
}: {
  run: Run
  live: { name: string; status: string } | null
  readOnly: boolean
  open: ((artifactId: string) => void) | undefined
  onState: (s: RunState) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    if (run.state !== "running") return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [run.state])
  const steps = showAll ? run.steps : run.steps.slice(-4)
  const hidden = run.steps.length - steps.length
  return (
    <div data-run={run.id} data-run-state={run.state} className="rounded-lg border border-border">
      <div className="flex items-center gap-2 px-3 pt-2.5 text-[13px]">
        <AssigneeAvatar who={{ type: "agent", id: run.client ?? run.agent.name, name: run.agent.name }} size={18} />
        <span className="font-medium">{run.agent.name}</span>
        {run.client && run.client !== run.agent.name && <span className="text-muted">via {run.client}</span>}
        {run.model && <span className="truncate text-[12px] text-faint">{run.model}</span>}
        <div className="flex-1" />
        <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium ${stateTone[run.state]}`}>{runStateLabel[run.state]}</span>
      </div>
      <div className="px-3 pt-0.5 text-[12px] text-faint">
        {run.state === "running" ? `Working for ${duration(run.startedAt, null)}` : `Worked for ${duration(run.startedAt, run.endedAt)}`} · {ago(run.startedAt)}
        {run.state === "running" && live && <span className="text-accent"> · {live.status}</span>}
      </div>
      {run.summary && <Markdown text={run.summary} className="px-3 pt-2 text-[13px] leading-5" />}
      {run.steps.length > 0 && (
        <ol className="mx-3 mt-2 mb-1 border-l border-border pl-3 text-[12.5px]" aria-label="Steps">
          {hidden > 0 && (
            <li>
              <button type="button" onClick={() => setShowAll(true)} className="mb-1 flex items-center gap-1 text-muted hover:text-text">
                <CaretRightIcon size={10} weight="bold" /> {hidden} earlier step{hidden === 1 ? "" : "s"}
              </button>
            </li>
          )}
          {steps.map((s, i) => {
            const href = s.artifactId ? artifactHref(s.artifactId) : null
            return (
              <li key={i} className="relative py-0.5" data-step>
                <span className={`absolute top-[9px] -left-[15.5px] size-1.5 rounded-full ${s.ok === false ? "bg-danger" : "bg-faint"}`} />
                <span className={s.ok === false ? "text-danger" : "text-text"}>{s.text}</span>
                {s.tool && <code className="ml-1.5 rounded bg-surface px-1 text-[11px] text-muted">{s.tool}</code>}
                {href && (
                  <a href={href} onClick={inApp(open, s.artifactId!)} aria-label="Open what this step touched" className="ml-1 inline-flex translate-y-0.5 text-faint hover:text-text">
                    <ArrowSquareOutIcon size={12} />
                  </a>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {!readOnly && (run.state === "needs_review" || run.state === "running") && (
        <div className="flex gap-1.5 px-3 pt-1 pb-2.5">
          {run.state === "needs_review" && (
            <button type="button" onClick={() => onState("done")} className="h-7 rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-accent-text hover:opacity-90">
              Approve
            </button>
          )}
          <button type="button" onClick={() => onState(run.state === "running" ? "canceled" : "failed")} className="h-7 rounded-md border border-border px-2.5 text-[12.5px] hover:bg-hover">
            {run.state === "running" ? "Cancel run" : "Reject"}
          </button>
        </div>
      )}
      {(readOnly || (run.state !== "needs_review" && run.state !== "running")) && <div className="h-2" />}
    </div>
  )
}

function CommentItem({ comment }: { comment: IssueComment }) {
  return (
    <div className="flex items-start gap-2.5" data-comment>
      <AssigneeAvatar who={{ id: comment.by ?? "", name: comment.name ?? "?" }} size={20} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px]">
          <span className="font-medium">{comment.name ?? "Someone"}</span> <span className="text-faint">{ago(comment.at)}</span>
        </div>
        <Markdown text={comment.text} className="mt-0.5 text-[13.5px] leading-5" />
      </div>
    </div>
  )
}

function CommentBox({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState("")
  const submit = () => {
    if (!text.trim()) return
    onSubmit(text.trim())
    setText("")
  }
  return (
    <div className="mt-4 rounded-lg border border-border focus-within:border-faint">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        rows={2}
        placeholder="Leave a comment…"
        aria-label="Comment"
        className="block w-full resize-none bg-transparent px-3 pt-2 text-[13.5px] leading-5 outline-none placeholder:text-faint"
      />
      <div className="flex justify-end px-2 pb-2">
        <button type="button" onClick={submit} disabled={!text.trim()} className="h-7 rounded-md border border-border px-2.5 text-[12.5px] enabled:hover:bg-hover disabled:opacity-50">
          Comment
        </button>
      </div>
    </div>
  )
}

function LabelsField({ labels, readOnly, onChange }: { labels: ReadonlyArray<string>; readOnly: boolean; onChange: (labels: Array<string>) => void }) {
  const [draft, setDraft] = useState("")
  const add = () => {
    const next = draft
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l && !labels.includes(l))
    if (next.length) onChange([...labels, ...next].slice(0, 12))
    setDraft("")
  }
  return (
    <div className="flex flex-wrap items-center gap-1 px-1.5 py-0.5">
      {labels.map((l) => (
        <span key={l} className="flex items-center gap-1 rounded-full border border-border px-2 py-px text-[12px]">
          {l}
          {!readOnly && (
            <button type="button" aria-label={`Remove label ${l}`} onClick={() => onChange(labels.filter((x) => x !== l))} className="text-faint hover:text-text">
              <XIcon size={10} />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          onBlur={add}
          placeholder={labels.length ? "" : "Add labels…"}
          aria-label="Add label"
          className="h-6 min-w-[80px] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
        />
      )}
    </div>
  )
}

/** Text that turns into an editor on click; commits on blur (and Enter for single lines). Escape reverts. */
function EditableText({
  value,
  readOnly,
  label,
  placeholder,
  singleLine,
  className = "",
  render,
  onCommit,
}: {
  value: string
  readOnly: boolean
  label: string
  placeholder?: string
  singleLine?: boolean
  className?: string
  render?: (text: string) => React.ReactNode
  onCommit: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.height = "0px"
      el.style.height = `${el.scrollHeight}px`
    }
    fit()
    // Re-fit when the width changes (window resize, sidebar collapse), so a wrapped title never gets clipped.
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth
        fit()
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [draft, editing])

  const commit = () => {
    setEditing(false)
    if (draft !== value) onCommit(draft)
  }

  if (!editing && (readOnly || render)) {
    const shown = render ? render(value) : value
    return (
      <div
        role={readOnly ? undefined : "button"}
        tabIndex={readOnly ? undefined : 0}
        aria-label={readOnly ? undefined : `Edit ${label.toLowerCase()}`}
        // Links inside the text navigate; only a click elsewhere starts editing.
        onClick={(e) => !readOnly && !(e.target as HTMLElement).closest("a") && setEditing(true)}
        onKeyDown={(e) => !readOnly && e.key === "Enter" && setEditing(true)}
        className={`rounded-md ${readOnly ? "" : "-mx-1.5 cursor-text px-1.5 hover:bg-hover/50"} ${className}`}
      >
        {shown || <span className="text-faint">{placeholder}</span>}
      </div>
    )
  }

  return (
    <textarea
      ref={ref}
      autoFocus={editing}
      value={draft}
      readOnly={readOnly}
      aria-label={label}
      placeholder={placeholder}
      rows={1}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(singleLine ? e.target.value.replace(/\n/g, " ") : e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          setDraft(value)
          setEditing(false)
          e.currentTarget.blur()
        }
        if (e.key === "Enter" && (singleLine || e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      className={`-mx-1.5 block w-[calc(100%+12px)] resize-none overflow-hidden rounded-md bg-transparent px-1.5 outline-none placeholder:text-faint focus:bg-hover/40 ${className}`}
    />
  )
}
