import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDownIcon, ArrowUpIcon, CaretDownIcon, CaretRightIcon, CheckIcon, LinkSimpleIcon, PlusIcon } from "@phosphor-icons/react"
import {
  applyTrackerOp,
  issuesOf,
  issueStatuses,
  issuePriorities,
  runsOf,
  type Issue,
  type IssueStatus,
  type Member,
  type TrackerOp,
  type TrackerPatch,
  type TrackerState,
} from "@standard-artifacts/protocol"
import type { RoomClient, RoomSnapshot } from "@standard-artifacts/room"
import { useRoom } from "@standard-artifacts/room/react"
import { AssigneeAvatar, PriorityIcon, StatusIcon } from "./icons"
import { IssuePanel } from "./issue-panel"
import type { Workspace } from "./links"
import { PropertyMenu } from "./menu"
import { activeRun, agentStatusOn, ago, membersOn } from "./model"
import { NewIssue } from "./new-issue"

export type TrackerRoom = RoomClient<TrackerState, TrackerOp>
export type TrackerSnapshot = RoomSnapshot<TrackerState>

export function useTrackerRoom(url: string, actorKey: string) {
  return useRoom<TrackerState, TrackerOp>({ url, actorKey, apply: applyTrackerOp })
}

type Filter = "active" | "all"
const FILTER_KEY = "standard-artifacts:tracker-filter"

/**
 * An issue tracker, Linear-style: issues grouped by status, a detail panel on
 * the right, and agents as first-class delegates whose runs show on the issue.
 *
 * Keys: C new issue, ↑/↓ (or J/K) move, Enter open, Esc close.
 */
export function TrackerView({
  room,
  snapshot,
  trackerId,
  workspace,
  issueNumber,
  onIssuePage,
  title,
}: {
  room: TrackerRoom
  snapshot: TrackerSnapshot
  /** This tracker's artifact id, so issues can link each other. */
  trackerId?: string
  /** The rest of the workspace, for linking and previewing artifacts from issues. */
  workspace?: Workspace
  /** Show this issue on its own page (from the URL) instead of the list. */
  issueNumber?: number | undefined
  /** Go to an issue's page, or back to the list with null. Without it, issues only open in the side panel. */
  onIssuePage?: (number: number | null) => void
  /** The tracker's name, for the issue page's breadcrumb. */
  title?: string
}) {
  const state = snapshot.state
  const readOnly = snapshot.self?.readOnly ?? true
  const members = useMemo(() => [...(snapshot.self ? [snapshot.self] : []), ...snapshot.others], [snapshot.self, snapshot.others])
  const [filter, setFilter] = useState<Filter>(() => {
    try {
      return localStorage.getItem(FILTER_KEY) === "all" ? "all" : "active"
    } catch {
      return "active"
    }
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [creating, setCreating] = useState<IssueStatus | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<IssueStatus>>(new Set())
  const list = useRef<HTMLDivElement>(null)

  const issues = useMemo(() => (state ? issuesOf(state) : []), [state])
  const groups = useMemo(
    () =>
      issueStatuses
        .filter((s) => filter === "all" || s.open)
        .map((s) => ({ ...s, issues: issues.filter((i) => i.status === s.id) }))
        .filter((g) => g.issues.length > 0 || (g.id === "todo" && issues.length === 0)),
    [issues, filter],
  )
  /** Rows in display order, for keyboard movement. */
  const visible = useMemo(() => groups.flatMap((g) => (collapsed.has(g.id) ? [] : g.issues)), [groups, collapsed])
  const open = openId ? issues.find((i) => i.id === openId) ?? null : null

  const send = useCallback((op: TrackerOp) => room.send(op), [room])
  const update = useCallback((id: string, patch: TrackerPatch) => send({ type: "update", id, patch }), [send])

  // Tell others which issue we have open.
  useEffect(() => room.setPresence({ issueId: openId }), [room, openId])

  const changeFilter = (f: Filter) => {
    setFilter(f)
    try {
      localStorage.setItem(FILTER_KEY, f)
    } catch {
      // per-viewer convenience
    }
  }

  /** A click or Enter opens the issue's page when the host can route; otherwise the side panel. */
  const openIssue = useCallback(
    (id: string) => {
      setCursor(id)
      const n = issues.find((i) => i.id === id)?.number
      if (onIssuePage && n !== undefined) {
        setOpenId(null)
        onIssuePage(n)
      } else setOpenId(id)
    },
    [issues, onIssuePage],
  )

  const pageIssue = issueNumber !== undefined ? issues.find((i) => i.number === issueNumber) : undefined
  const onPage = issueNumber !== undefined

  // Keyboard: C creates, arrows/J/K move, Enter opens the page, Space peeks, Esc closes. Not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest("[role=listbox],[role=dialog]"))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (onPage) {
        // On an issue's page: previous/next issue in list order, Esc back to the list.
        const at = visible.findIndex((i) => i.number === issueNumber)
        const go = (d: number) => {
          const next = visible[at + d]
          if (next) onIssuePage?.(next.number)
        }
        if (e.key === "ArrowDown" || e.key === "j") go(1)
        else if (e.key === "ArrowUp" || e.key === "k") go(-1)
        else if (e.key === "Escape") {
          if (pageIssue) setCursor(pageIssue.id)
          onIssuePage?.(null)
        } else if ((e.key === "c" || e.key === "C") && !readOnly) setCreating("todo")
        else return
        e.preventDefault()
        return
      }
      const at = visible.findIndex((i) => i.id === cursor)
      const move = (d: number) => {
        const next = visible[Math.min(Math.max(at + d, 0), visible.length - 1)] ?? visible[0]
        if (!next) return
        setCursor(next.id)
        if (openId) setOpenId(next.id)
        list.current?.querySelector<HTMLElement>(`[data-issue-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" })
      }
      if ((e.key === "c" || e.key === "C") && !readOnly) setCreating("todo")
      else if (e.key === "ArrowDown" || e.key === "j") move(1)
      else if (e.key === "ArrowUp" || e.key === "k") move(-1)
      else if (e.key === "Enter" && cursor) openIssue(cursor)
      else if (e.key === " " && cursor) setOpenId((o) => (o === cursor ? null : cursor))
      else if (e.key === "Escape" && openId) setOpenId(null)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [visible, cursor, openId, readOnly, onPage, issueNumber, pageIssue, onIssuePage])

  const create = (issue: Issue) => {
    send({ type: "insert", item: issue })
    setCreating(null)
    setCursor(issue.id)
  }

  if (!state) return <div className="grid h-full place-items-center text-[13px] text-faint">{snapshot.status === "closed" ? "Disconnected" : "Loading…"}</div>

  if (onPage) {
    const at = visible.findIndex((i) => i.number === issueNumber)
    const prev = visible[at - 1]
    const next = visible[at + 1]
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-4 text-[13px]">
          <button type="button" onClick={() => onIssuePage?.(null)} className="max-w-[40%] shrink-0 truncate rounded px-1 text-muted hover:bg-hover hover:text-text">
            {title ?? "Issues"}
          </button>
          <CaretRightIcon size={11} className="shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted">#{issueNumber}</span> {pageIssue?.title ?? ""}
          </span>
          {pageIssue && at >= 0 && (
            <span className="mr-1 shrink-0 text-[12px] whitespace-nowrap text-faint tabular-nums" aria-label="Position">
              {at + 1} / {visible.length}
            </span>
          )}
          <button
            type="button"
            aria-label="Next issue"
            title="Next issue (J or ↓)"
            disabled={!next}
            onClick={() => next && onIssuePage?.(next.number)}
            className="grid size-7 place-items-center rounded-md text-muted enabled:hover:bg-hover enabled:hover:text-text disabled:opacity-40"
          >
            <ArrowDownIcon size={14} />
          </button>
          <button
            type="button"
            aria-label="Previous issue"
            title="Previous issue (K or ↑)"
            disabled={!prev}
            onClick={() => prev && onIssuePage?.(prev.number)}
            className="grid size-7 place-items-center rounded-md text-muted enabled:hover:bg-hover enabled:hover:text-text disabled:opacity-40"
          >
            <ArrowUpIcon size={14} />
          </button>
          <CopyLink />
        </div>
        {pageIssue ? (
          <IssuePanel
            key={pageIssue.id}
            layout="page"
            issue={pageIssue}
            state={state}
            self={snapshot.self}
            others={snapshot.others}
            readOnly={readOnly}
            trackerId={trackerId}
            workspace={workspace}
            send={send}
            onClose={() => onIssuePage?.(null)}
            onOpenIssue={openIssue}
          />
        ) : (
          <div className="mx-auto mt-24 max-w-[340px] px-4 text-center">
            <div className="text-[15px] font-medium">Issue #{issueNumber} doesn't exist</div>
            <p className="mt-1.5 text-[13px] text-muted">It may have been deleted.</p>
            <button type="button" onClick={() => onIssuePage?.(null)} className="mt-4 h-8 rounded-md border border-border px-3 text-[13px] hover:bg-hover">
              Back to {title ?? "issues"}
            </button>
          </div>
        )}
        {creating && <NewIssue status={creating} state={state} self={snapshot.self} others={snapshot.others} onCreate={create} onClose={() => setCreating(null)} />}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-4">
          <div role="tablist" aria-label="Show" className="flex gap-0.5">
            {(["active", "all"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => changeFilter(f)}
                className={`h-7 rounded-md px-2.5 text-[13px] ${filter === f ? "bg-active font-medium text-text" : "text-muted hover:bg-hover hover:text-text"}`}
              >
                {f === "active" ? "Active" : "All issues"}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {!readOnly && (
            <button
              type="button"
              onClick={() => setCreating("todo")}
              aria-keyshortcuts="C"
              title="New issue (C)"
              className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[13px] font-medium text-accent-text hover:opacity-90"
            >
              <PlusIcon size={14} weight="bold" /> New issue
            </button>
          )}
        </div>

        <div ref={list} role="grid" aria-label="Issues" className="min-h-0 flex-1 overflow-y-auto pb-16">
          {issues.length === 0 ? (
            <Empty readOnly={readOnly} onCreate={() => setCreating("todo")} />
          ) : (
            groups.map((g) => (
              <section key={g.id} aria-label={g.label}>
                <div className="sticky top-0 z-[1] flex h-9 items-center gap-2 border-b border-border bg-surface/95 px-4 backdrop-blur">
                  <button
                    type="button"
                    aria-expanded={!collapsed.has(g.id)}
                    onClick={() =>
                      setCollapsed((c) => {
                        const next = new Set(c)
                        if (next.has(g.id)) next.delete(g.id)
                        else next.add(g.id)
                        return next
                      })
                    }
                    className="-ml-1 flex items-center gap-2 rounded px-1 text-[13px] font-medium"
                  >
                    <CaretDownIcon size={10} weight="bold" className={`text-faint transition-transform ${collapsed.has(g.id) ? "-rotate-90" : ""}`} />
                    <StatusIcon status={g.id} />
                    {g.label}
                    <span className="font-normal text-faint">{g.issues.length}</span>
                  </button>
                  <div className="flex-1" />
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`New ${g.label} issue`}
                      onClick={() => setCreating(g.id)}
                      className="grid size-6 place-items-center rounded text-faint hover:bg-hover hover:text-text"
                    >
                      <PlusIcon size={13} />
                    </button>
                  )}
                </div>
                {!collapsed.has(g.id) &&
                  g.issues.map((issue) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      state={state}
                      members={members}
                      selfId={snapshot.self?.connectionId}
                      selected={issue.id === (openId ?? cursor)}
                      readOnly={readOnly}
                      onOpen={() => openIssue(issue.id)}
                      onStatus={(status) => update(issue.id, { status })}
                      onPriority={(priority) => update(issue.id, { priority })}
                    />
                  ))}
              </section>
            ))
          )}
        </div>
      </div>

      {open && (
        <IssuePanel
          key={open.id}
          issue={open}
          state={state}
          self={snapshot.self}
          others={snapshot.others}
          readOnly={readOnly}
          trackerId={trackerId}
          workspace={workspace}
          send={send}
          onClose={() => setOpenId(null)}
          onOpenIssue={(id) => {
            setCursor(id)
            setOpenId(id)
          }}
          {...(onIssuePage && { onExpand: () => openIssue(open.id) })}
        />
      )}

      {creating && (
        <NewIssue
          status={creating}
          state={state}
          self={snapshot.self}
          others={snapshot.others}
          onCreate={create}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  )
}

function IssueRow({
  issue,
  state,
  members,
  selfId,
  selected,
  readOnly,
  onOpen,
  onStatus,
  onPriority,
}: {
  issue: Issue
  state: TrackerState
  members: ReadonlyArray<Member>
  selfId: string | undefined
  selected: boolean
  readOnly: boolean
  onOpen: () => void
  onStatus: (s: IssueStatus) => void
  onPriority: (p: Issue["priority"]) => void
}) {
  const runs = runsOf(state, issue.id)
  const running = activeRun(runs)
  const live = agentStatusOn(issue, members)
  // Other people with this issue open (not you; agents show as working instead).
  const viewers = membersOn(issue, members).filter((m) => m.actor.type !== "agent" && m.connectionId !== selfId)
  const review = runs.some((r) => r.state === "needs_review")
  return (
    <div
      role="row"
      data-issue-id={issue.id}
      aria-selected={selected}
      onClick={onOpen}
      className={`group flex h-10 cursor-default items-center gap-2.5 border-b border-border/60 px-4 text-[13px] ${selected ? "bg-active/70" : "hover:bg-hover/60"}`}
    >
      <span onClick={(e) => e.stopPropagation()}>
        <PropertyMenu
          label="Priority"
          value={issue.priority}
          disabled={readOnly}
          onChange={onPriority}
          options={issuePriorities.map((p) => ({ value: p.id, label: p.label, icon: <PriorityIcon priority={p.id} /> }))}
          className="size-6 justify-center"
        >
          <PriorityIcon priority={issue.priority} />
        </PropertyMenu>
      </span>
      <span className="w-9 shrink-0 text-[12px] text-faint tabular-nums">#{issue.number}</span>
      <span onClick={(e) => e.stopPropagation()}>
        <PropertyMenu
          label="Status"
          value={issue.status}
          disabled={readOnly}
          onChange={onStatus}
          options={issueStatuses.map((s) => ({ value: s.id, label: s.label, icon: <StatusIcon status={s.id} /> }))}
          className="size-6 justify-center"
        >
          <StatusIcon status={issue.status} />
        </PropertyMenu>
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
      {(running || live) && (
        <span data-agent-working className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-[12px] text-accent">
          <span className="size-1.5 animate-pulse rounded-full bg-accent" />
          {live ? `${live.name}: ${live.status}` : `${running!.agent.name} working`}
        </span>
      )}
      {!running && !live && review && (
        <span className="shrink-0 rounded-full bg-[#e5a400]/15 px-2 py-0.5 text-[12px] text-[#a87800] dark:text-[#f2c14e]">Needs review</span>
      )}
      {issue.labels?.slice(0, 3).map((l) => (
        <span key={l} className="hidden shrink-0 rounded-full border border-border px-2 py-px text-[12px] text-muted md:inline">
          {l}
        </span>
      ))}
      {viewers.length > 0 && (
        <span className="flex shrink-0 -space-x-1">
          {viewers.slice(0, 3).map((m) => (
            <span key={m.connectionId} title={`${m.name} has this open`} className="size-2 rounded-full ring-2 ring-bg" style={{ background: m.color }} />
          ))}
        </span>
      )}
      {issue.due && <span className="hidden shrink-0 text-[12px] text-muted sm:inline">{issue.due.slice(5)}</span>}
      <span className="hidden w-16 shrink-0 text-right text-[12px] text-faint sm:inline">{ago(issue.createdAt)}</span>
      <span className="flex shrink-0 items-center" title={issue.delegate ? `Delegated to ${issue.delegate.name}` : issue.owner ? `Owned by ${issue.owner.name}` : "Unassigned"}>
        <AssigneeAvatar who={issue.delegate ?? issue.owner ?? null} />
      </span>
    </div>
  )
}

function Empty({ readOnly, onCreate }: { readOnly: boolean; onCreate: () => void }) {
  return (
    <div className="mx-auto mt-24 max-w-[340px] px-4 text-center">
      <div className="text-[15px] font-medium">No issues yet</div>
      <p className="mt-1.5 text-[13px] text-muted">
        Track work for people and agents. Delegate an issue to Claude, ChatGPT or Codex, and every run it makes shows up on the issue.
      </p>
      {!readOnly && (
        <button type="button" onClick={onCreate} className="mt-4 h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-text hover:opacity-90">
          Create an issue <kbd className="ml-1 font-sans opacity-70">C</kbd>
        </button>
      )}
    </div>
  )
}

/** Copy this page's URL (Linear's "copy link"). */
function CopyLink() {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={copied ? "Link copied" : "Copy link"}
      title="Copy link"
      onClick={() => {
        void navigator.clipboard?.writeText(window.location.href).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text"
    >
      {copied ? <CheckIcon size={14} /> : <LinkSimpleIcon size={14} />}
    </button>
  )
}
