import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsDownUpIcon,
  CaretDownIcon,
  CaretUpIcon,
  EyeSlashIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react"
import { newId, type Column, type TableState } from "@standard-artifacts/protocol"
import { filterOps, isActive, type FilterOp, type FilterRule, type ViewSettings } from "./view"

/**
 * Per-viewer controls over the table: search, filter, sort and hidden fields.
 * Each button is tinted while it's changing what you see, so a sorted or
 * filtered view is never mistaken for the whole table.
 */
export function ViewToolbar({
  state,
  view,
  setView,
  shown,
  matchCount,
  matchIndex,
  onStep,
  searchRef,
  canHide,
}: {
  state: TableState
  view: ViewSettings
  setView: (update: (v: ViewSettings) => ViewSettings) => void
  /** Rows currently visible, to say "3 of 12 rows" while filtered. */
  shown: number
  matchCount: number
  matchIndex: number
  onStep: (delta: 1 | -1) => void
  searchRef: RefObject<HTMLInputElement | null>
  canHide: boolean
}) {
  const filters = view.filters.filter((f) => isActive(f, state.columns))
  const sortColumn = view.sort && state.columns.find((c) => c.id === view.sort?.colId)
  const hidden = view.hidden.filter((id) => state.columns.some((c) => c.id === id))

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="relative flex items-center">
        <MagnifyingGlassIcon size={13} className="pointer-events-none absolute left-2 text-faint" />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search this table"
          placeholder="Search"
          value={view.search}
          onChange={(e) => setView((v) => ({ ...v, search: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              onStep(e.shiftKey ? -1 : 1)
            }
            if (e.key === "Escape" && view.search) {
              e.preventDefault()
              setView((v) => ({ ...v, search: "" }))
            }
          }}
          className={`h-7 rounded-md border bg-bg pr-2 pl-7 text-[13px] outline-none placeholder:text-faint focus:border-accent ${view.search ? "w-52 border-accent" : "w-32 border-border"} [&::-webkit-search-cancel-button]:hidden`}
        />
        {view.search && (
          <span className="absolute right-1 flex items-center gap-0.5 bg-bg text-[11px] text-muted tabular-nums">
            <span aria-live="polite">{matchCount ? `${matchIndex + 1}/${matchCount}` : "0 found"}</span>
            <IconButton label="Previous match" icon={CaretUpIcon} onClick={() => onStep(-1)} />
            <IconButton label="Next match" icon={CaretDownIcon} onClick={() => onStep(1)} />
          </span>
        )}
      </div>

      <Popover
        label={filters.length ? `${filters.length} filter${filters.length > 1 ? "s" : ""}` : "Filter"}
        icon={FunnelIcon}
        active={filters.length > 0}
      >
        <FilterEditor state={state} view={view} setView={setView} />
      </Popover>

      <Popover label={sortColumn ? `Sorted by ${sortColumn.name}` : "Sort"} icon={ArrowsDownUpIcon} active={!!sortColumn}>
        <SortEditor columns={state.columns} view={view} setView={setView} />
      </Popover>

      {canHide && (
        <Popover label={hidden.length ? `${hidden.length} hidden` : "Fields"} icon={EyeSlashIcon} active={hidden.length > 0}>
          <FieldsEditor columns={state.columns} view={view} setView={setView} />
        </Popover>
      )}

      {(filters.length > 0 || sortColumn) && (
        <span className="ml-1 flex items-center gap-1 text-[12px] whitespace-nowrap text-muted">
          {filters.length > 0 && `${shown} of ${state.rowIds.length} rows`}
          <button
            type="button"
            onClick={() => setView((v) => ({ ...v, filters: [], sort: null }))}
            className="rounded px-1 text-accent hover:bg-hover"
          >
            Reset view
          </button>
        </span>
      )}
    </div>
  )
}

function IconButton({ label, icon: I, onClick }: { label: string; icon: Icon; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-5 place-items-center rounded hover:bg-hover hover:text-text">
      <I size={11} weight="bold" />
    </button>
  )
}

/** A toolbar button with a panel under it that closes on Esc or a click outside. */
function Popover({ label, icon: I, active, children }: { label: string; icon: Icon; active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => e.target instanceof Node && !ref.current?.contains(e.target) && setOpen(false)
    // Esc closes it wherever focus is: picking from a native <select> can leave focus outside the panel.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      setOpen(false)
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", escape)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] whitespace-nowrap ${active ? "bg-accent/12 font-medium text-accent" : "text-muted hover:bg-hover hover:text-text"}`}
      >
        <I size={14} /> {label}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          onKeyDown={(e) => {
            // Handled here so the grid behind doesn't also treat it as "clear selection".
            if (e.key === "Escape") {
              e.stopPropagation()
              setOpen(false)
            }
          }}
          className="absolute top-full left-0 z-50 mt-1 rounded-lg border border-border bg-bg p-2 text-[13px] shadow-lg"
        >
          {children}
        </div>
      )}
    </div>
  )
}

const field = "h-7 rounded border border-border bg-bg px-1.5 text-[13px] outline-none focus:border-accent"

function FilterEditor({ state, view, setView }: { state: TableState; view: ViewSettings; setView: (u: (v: ViewSettings) => ViewSettings) => void }) {
  const update = (id: string, patch: Partial<FilterRule>) =>
    setView((v) => ({ ...v, filters: v.filters.map((f) => (f.id === id ? { ...f, ...patch } : f)) }))
  const first = state.columns[0]
  return (
    <div className="w-[420px] space-y-1.5">
      {view.filters.length === 0 && <p className="px-1 py-1 text-muted">No filters. Only you see the result.</p>}
      {view.filters.map((f, i) => {
        const column = state.columns.find((c) => c.id === f.colId)
        const ops = column ? filterOps(column.type) : []
        const spec = ops.find((o) => o.op === f.op)
        return (
          <div key={f.id} className="flex items-center gap-1.5">
            <span className="w-10 shrink-0 text-right text-[12px] text-faint">{i === 0 ? "Where" : "and"}</span>
            <select
              aria-label="Filter field"
              value={f.colId}
              onChange={(e) => {
                const next = state.columns.find((c) => c.id === e.target.value)
                if (next) update(f.id, { colId: next.id, op: filterOps(next.type)[0]?.op ?? "contains", value: "" })
              }}
              className={`${field} w-32`}
            >
              {!column && <option value={f.colId}>(deleted)</option>}
              {state.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter condition"
              value={f.op}
              onChange={(e) => {
                const op = ops.find((o) => o.op === e.target.value)
                if (op) update(f.id, { op: op.op })
              }}
              className={`${field} w-32`}
            >
              {ops.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {spec?.needsValue && column ? (
              <FilterValue column={column} value={f.value} onChange={(value) => update(f.id, { value })} />
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            <button
              type="button"
              aria-label="Remove filter"
              onClick={() => setView((v) => ({ ...v, filters: v.filters.filter((x) => x.id !== f.id) }))}
              className="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-danger"
            >
              <TrashIcon size={13} />
            </button>
          </div>
        )
      })}
      {first && (
        <button
          type="button"
          onClick={() => {
            const op: FilterOp = filterOps(first.type)[0]?.op ?? "contains"
            setView((v) => ({ ...v, filters: [...v.filters, { id: newId("f_"), colId: first.id, op, value: "" }] }))
          }}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-muted hover:bg-hover hover:text-text"
        >
          <PlusIcon size={12} weight="bold" /> Add filter
        </button>
      )}
    </div>
  )
}

function FilterValue({ column, value, onChange }: { column: Column; value: string; onChange: (v: string) => void }) {
  if (column.type === "select" || column.type === "multiSelect") {
    return (
      <select aria-label="Filter value" value={value} onChange={(e) => onChange(e.target.value)} className={`${field} min-w-0 flex-1`}>
        <option value="">Choose…</option>
        {(column.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      autoFocus
      aria-label="Filter value"
      inputMode={column.type === "number" ? "decimal" : undefined}
      value={value}
      placeholder="Value"
      onChange={(e) => onChange(e.target.value)}
      className={`${field} min-w-0 flex-1`}
    />
  )
}

function SortEditor({ columns, view, setView }: { columns: ReadonlyArray<Column>; view: ViewSettings; setView: (u: (v: ViewSettings) => ViewSettings) => void }) {
  const sort = view.sort
  return (
    <div className="w-72 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Sort by"
          value={sort?.colId ?? ""}
          onChange={(e) => setView((v) => ({ ...v, sort: e.target.value ? { colId: e.target.value, dir: v.sort?.dir ?? "asc" } : null }))}
          className={`${field} min-w-0 flex-1`}
        >
          <option value="">Not sorted</option>
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {sort && (
          <>
            <button
              type="button"
              aria-label={sort.dir === "asc" ? "Ascending" : "Descending"}
              title="Flip direction"
              onClick={() => setView((v) => ({ ...v, sort: v.sort && { ...v.sort, dir: v.sort.dir === "asc" ? "desc" : "asc" } }))}
              className="flex h-7 items-center gap-1 rounded border border-border px-1.5 hover:bg-hover"
            >
              {sort.dir === "asc" ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
              {sort.dir === "asc" ? "A → Z" : "Z → A"}
            </button>
            <button
              type="button"
              aria-label="Remove sort"
              onClick={() => setView((v) => ({ ...v, sort: null }))}
              className="grid size-7 place-items-center rounded text-muted hover:bg-hover hover:text-danger"
            >
              <XIcon size={13} />
            </button>
          </>
        )}
      </div>
      <p className="px-1 text-[12px] text-faint">Only you see this order. New rows still go to the end for everyone.</p>
    </div>
  )
}

function FieldsEditor({ columns, view, setView }: { columns: ReadonlyArray<Column>; view: ViewSettings; setView: (u: (v: ViewSettings) => ViewSettings) => void }) {
  const visible = columns.filter((c) => !view.hidden.includes(c.id))
  return (
    <div className="w-56">
      <ul className="max-h-72 overflow-y-auto">
        {columns.map((c) => {
          const shown = !view.hidden.includes(c.id)
          return (
            <li key={c.id}>
              <label className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-hover">
                <input
                  type="checkbox"
                  checked={shown}
                  // Keep at least one column, so the grid always has somewhere for the cursor to be.
                  disabled={shown && visible.length === 1}
                  onChange={() =>
                    setView((v) => ({ ...v, hidden: shown ? [...v.hidden, c.id] : v.hidden.filter((id) => id !== c.id) }))
                  }
                  className="accent-accent"
                />
                <span className="truncate">{c.name}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="mt-1 flex gap-1 border-t border-border pt-1">
        <button type="button" onClick={() => setView((v) => ({ ...v, hidden: [] }))} className="flex-1 rounded px-1.5 py-1 text-muted hover:bg-hover hover:text-text">
          Show all
        </button>
      </div>
      <p className="px-1.5 pt-1 text-[12px] text-faint">Hidden only for you.</p>
    </div>
  )
}
