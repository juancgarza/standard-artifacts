import { useEffect, useRef, useState } from "react"
import { ArrowSquareOutIcon, CircleNotchIcon, LinkSimpleIcon, SparkleIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { cellKey, cellText, type Cell, type TableState } from "@standard-artifacts/protocol"

/**
 * Agent columns and agent-written cells: run progress, the queued / running /
 * failed states, and the sources an agent cited.
 */

/** Agents write as `agentId:onBehalfOf` (see actorKey); people write as their own id. */
export const byAgent = (cell: Cell | undefined) => !!cell?.by?.includes(":")

/** A value that has landed (not queued, running or failed) and isn't empty. */
const filled = (cell: Cell | undefined) =>
  !!cell && (cell.status === undefined || cell.status === "done") && cellText(cell.v) !== ""

export type RunProgress = { total: number; done: number; running: number; queued: number; failed: number }

/** Where an agent column's run stands over these rows. A value someone typed counts as done. */
export function runProgress(state: TableState, rowIds: ReadonlyArray<string>, colId: string): RunProgress {
  const p: RunProgress = { total: rowIds.length, done: 0, running: 0, queued: 0, failed: 0 }
  for (const rowId of rowIds) {
    const cell = state.cells[cellKey(rowId, colId)]
    if (cell?.status === "running") p.running++
    else if (cell?.status === "queued") p.queued++
    else if (cell?.status === "error") p.failed++
    else if (filled(cell)) p.done++
  }
  return p
}

export const percent = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0)

/** "7/20 · 35%", with a spinner while anything is queued or running. */
export function HeaderProgress({ progress: p }: { progress: RunProgress }) {
  if (!p.total) return null
  const busy = p.running + p.queued > 0
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-[11px] font-normal text-faint tabular-nums"
      title={progressTitle(p)}
    >
      {busy && <CircleNotchIcon size={11} weight="bold" className="animate-spin text-accent" />}
      {p.done}/{p.total} · {percent(p.done, p.total)}%
    </span>
  )
}

export const progressTitle = (p: RunProgress) =>
  [
    `${p.done} of ${p.total} done`,
    p.running && `${p.running} running`,
    p.queued && `${p.queued} queued`,
    p.failed && `${p.failed} failed`,
  ]
    .filter(Boolean)
    .join(" · ")

/** A thin bar along the bottom of an agent column's header: done, then in flight, then failed. */
export function ProgressBar({ progress: p, className = "" }: { progress: RunProgress; className?: string }) {
  if (!p.total) return null
  const seg = (n: number) => `${(n / p.total) * 100}%`
  return (
    <span aria-hidden className={`flex overflow-hidden bg-border ${className}`}>
      <span className="bg-accent transition-[width] duration-500" style={{ width: seg(p.done) }} />
      <span className="animate-pulse bg-accent/45 transition-[width] duration-500" style={{ width: seg(p.running) }} />
      <span className="bg-accent/20 transition-[width] duration-500" style={{ width: seg(p.queued) }} />
      <span className="bg-danger/70 transition-[width] duration-500" style={{ width: seg(p.failed) }} />
    </span>
  )
}

/** Stable per-cell width for the queued skeleton, so a column of them doesn't look like a bar chart of nothing. */
function skeletonWidth(seed: string) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0
  return 38 + (Math.abs(h) % 40)
}

/** Queued: a skeleton line. Running: a spinner and what the agent says it's doing. Failed: why. */
export function AgentPending({ cell, seed }: { cell: Cell; seed: string }) {
  const text = cellText(cell.v)
  if (cell.status === "queued") {
    return (
      <span className="flex min-w-0 flex-1 items-center" title="Queued: waiting for the agent">
        <span className="h-2 animate-pulse rounded-full bg-hover" style={{ width: `${skeletonWidth(seed)}%` }} />
      </span>
    )
  }
  if (cell.status === "running") {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted" title={text || "The agent is working on this cell"}>
        <CircleNotchIcon size={12} weight="bold" className="shrink-0 animate-spin text-accent" />
        <span className="truncate">{text || "Researching…"}</span>
      </span>
    )
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-danger" title={text ? `Failed: ${text}` : "The agent couldn't fill this cell"}>
      <WarningCircleIcon size={13} weight="fill" className="shrink-0" />
      <span className="truncate">{text || "Failed"}</span>
    </span>
  )
}

/** A tiny marker in front of a value an agent wrote, so it reads differently from one a person typed. */
export function AgentMark() {
  return (
    <span title="Written by an agent" className="grid shrink-0 place-items-center">
      <SparkleIcon size={11} weight="fill" className="text-accent/55" aria-label="Written by an agent" />
    </span>
  )
}

const hostOf = (url: string) => {
  try {
    const u = new URL(url)
    return { host: u.hostname.replace(/^www\./, ""), path: `${u.pathname === "/" ? "" : u.pathname}${u.search}` }
  } catch {
    return { host: url, path: "" }
  }
}

/** "3" with a link glyph; opens a list of the sources the agent cited. */
export function SourcesButton({ sources, onOpenRow }: { sources: ReadonlyArray<string>; onOpenRow: () => void }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!at) return
    const close = (e: Event) => {
      if (e.target instanceof Node && (panel.current?.contains(e.target) || button.current?.contains(e.target))) return
      setAt(null)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      setAt(null)
    }
    // It's pinned to the viewport, so a scroll would leave it floating somewhere else.
    document.addEventListener("mousedown", close)
    document.addEventListener("scroll", close, true)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("scroll", close, true)
      document.removeEventListener("keydown", escape)
    }
  }, [at])

  const toggle = () => {
    if (at) return setAt(null)
    const r = button.current?.getBoundingClientRect()
    if (!r) return
    const width = 300
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width)) })
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`${sources.length} source${sources.length === 1 ? "" : "s"}`}
        aria-expanded={!!at}
        title="Sources"
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={toggle}
        className="flex h-[18px] shrink-0 items-center gap-0.5 rounded px-1 text-[11px] text-faint tabular-nums hover:bg-hover hover:text-text aria-expanded:bg-hover aria-expanded:text-text"
      >
        <LinkSimpleIcon size={11} weight="bold" />
        {sources.length}
      </button>
      {/* Fixed to the viewport (not portaled), so the cell's overflow and the grid's scroll don't clip it. */}
      {at && (
          <div
            ref={panel}
            role="dialog"
            aria-label="Sources"
            onMouseDown={(e) => e.stopPropagation()}
            className="fixed z-50 w-[300px] rounded-lg border border-border bg-bg p-1 text-[13px] text-text shadow-lg"
            style={at}
          >
            <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-faint">
              {sources.length} source{sources.length === 1 ? "" : "s"}
            </div>
            <ul>
              {sources.map((url) => {
                const { host, path } = hostOf(url)
                return (
                  <li key={url}>
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      title={url}
                      className="group/src flex items-center gap-2 rounded px-2 py-1.5 hover:bg-hover"
                    >
                      <span className="grid size-5 shrink-0 place-items-center rounded bg-surface text-[10px] font-semibold text-muted uppercase">
                        {host.charAt(0)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {host}
                        {path && <span className="text-faint">{path}</span>}
                      </span>
                      <ArrowSquareOutIcon size={13} className="shrink-0 text-faint opacity-0 group-hover/src:opacity-100" />
                    </a>
                  </li>
                )
              })}
            </ul>
            <button
              type="button"
              onClick={() => {
                setAt(null)
                onOpenRow()
              }}
              className="mt-1 w-full rounded border-t border-border px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text"
            >
              Open row
            </button>
          </div>
      )}
    </>
  )
}
