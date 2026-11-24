import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { KanbanIcon, LockSimpleIcon, TableIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import { emptyTable } from "@standard-artifacts/protocol"
import { useTableActions, type TableRoom, type TableSnapshot } from "./model"
import { GridView } from "./grid"
import { KanbanView } from "./kanban"
import type { TableLinks } from "./links"
import { Avatars } from "./presence"
import { ViewToolbar } from "./toolbar"
import { emptyView, isActive, searchMatches, visibleColumns, visibleRows, type ViewSettings } from "./view"

export type TableViewMode = "grid" | "kanban"

/**
 * A live table: toolbar (views, who's here, connection) over a Grid or Kanban
 * view of the same cell. The host owns the connection (see useTableRoom).
 */
export function TableView({
  room,
  snapshot,
  view: mode,
  onViewChange,
  presence = true,
  openRow,
  links,
}: {
  room: TableRoom
  snapshot: TableSnapshot
  view: TableViewMode
  onViewChange: (view: TableViewMode) => void
  /** Show the connection status, avatars and "View only" in the toolbar. Hosts with their own header turn this off. */
  presence?: boolean
  /** A row to open on, in the grid's record panel (a link to one row). */
  openRow?: string | undefined
  /** Chips, titles and a picker for Artifact cells. */
  links?: TableLinks | undefined
}) {
  const actions = useTableActions(room)
  // `n` makes the same message shown twice in a row restart its timer instead of expiring early.
  const [notice, setNotice] = useState<{ text: string; n: number } | null>(null)
  const showNotice = useCallback((text: string) => setNotice((prev) => ({ text, n: (prev?.n ?? 0) + 1 })), [])
  const { state, self, others, status, error } = snapshot
  const readOnly = self?.readOnly ?? true

  // This viewer's sort, filters, search and hidden fields. Never sent anywhere: others keep their own view.
  const [view, setView] = useState<ViewSettings>(emptyView)
  /** Rows kept visible despite the filters (ones added or worked in here); reset when the filters change. */
  const [keep, setKeep] = useState<ReadonlySet<string>>(() => new Set())
  const filterKey = JSON.stringify(view.filters)
  useEffect(() => setKeep(new Set()), [filterKey])
  const onKeep = useCallback((rowId: string) => setKeep((k) => (k.has(rowId) ? k : new Set(k).add(rowId))), [])
  const table = state ?? emptyTable()
  const titleOf = links?.titleOf
  const rows = useMemo(() => visibleRows(table, view, keep, titleOf), [table, view, keep, titleOf])
  const columns = useMemo(() => visibleColumns(table, view), [table, view])
  const matches = useMemo(() => searchMatches(table, rows, columns, view.search, titleOf), [table, rows, columns, view.search, titleOf])
  const [matchIndex, setMatchIndex] = useState(-1)
  const [jump, setJump] = useState<{ rowId: string; colId: string } | null>(null)
  useEffect(() => setMatchIndex(-1), [view.search])
  const searchRef = useRef<HTMLInputElement>(null)
  /** Next/previous search match; the first Enter goes to the first match. */
  const step = (d: 1 | -1) => {
    if (!matches.length) return
    const i = matchIndex < 0 ? (d > 0 ? 0 : matches.length - 1) : (matchIndex + d + matches.length) % matches.length
    setMatchIndex(i)
    const m = matches[i]
    // A fresh object each time, so jumping to the same cell again still selects it.
    if (m) setJump({ ...m })
  }
  const filteredCols = useMemo(() => view.filters.filter((f) => isActive(f, table.columns)).map((f) => f.colId), [view.filters, table.columns])

  useEffect(() => {
    if (error) showNotice(error)
  }, [error, showNotice])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        // Cmd/Ctrl+F finds in the table, like Airtable; the browser's find can't see rows it would need to scroll to.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && searchRef.current) {
          e.preventDefault()
          searchRef.current.focus()
          searchRef.current.select()
        }
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <div role="tablist" aria-label="View" className="flex rounded-md bg-surface p-0.5">
          {([
            ["grid", "Grid", TableIcon],
            ["kanban", "Kanban", KanbanIcon],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => onViewChange(id)}
              className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-[13px] ${mode === id ? "bg-bg font-medium shadow-sm" : "text-muted hover:text-text"}`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        {state && (
          <ViewToolbar
            state={state}
            view={view}
            setView={setView}
            shown={rows.length}
            matchCount={matches.length}
            matchIndex={matchIndex}
            onStep={step}
            searchRef={searchRef}
            canHide={mode === "grid"}
          />
        )}
        {presence && readOnly && self && (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
            <LockSimpleIcon size={13} /> View only
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {presence && status !== "open" && (
            <span className="text-[12px] text-muted">
              {status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : "Disconnected"}
            </span>
          )}
          {presence && <Avatars self={self} others={others} />}
        </div>
      </div>

      {notice && (
        <div role="status" className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[13px] text-danger">
          <WarningCircleIcon size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-text">
            <XIcon size={13} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {!state ? (
          <div className="grid h-full place-items-center text-[13px] text-muted">Loading…</div>
        ) : mode === "grid" ? (
          <GridView
            state={state}
            rows={rows}
            columns={columns}
            others={others}
            actions={actions}
            readOnly={readOnly}
            onError={showNotice}
            search={view.search}
            sort={view.sort}
            filtered={filteredCols}
            jump={jump}
            openRow={openRow}
            links={links}
            onKeep={onKeep}
            onSort={(colId, dir) => setView((v) => ({ ...v, sort: { colId, dir } }))}
            onHide={(colId) => setView((v) => ({ ...v, hidden: [...v.hidden, colId] }))}
          />
        ) : (
          <KanbanView state={state} rows={rows} others={others} actions={actions} readOnly={readOnly} links={links} />
        )}
      </div>
    </div>
  )
}
