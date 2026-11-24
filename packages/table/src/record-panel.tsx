import { useEffect, useRef, useState } from "react"
import { ArrowSquareOutIcon, PlusIcon, RobotIcon, TrashIcon, XIcon } from "@phosphor-icons/react"
import { columnTypes, isTags, refsOf, sameValue, type Cell, type CellValue, type Column, type TableState } from "@standard-artifacts/protocol"
import { RefChips, RefPicker, type TableLinks } from "./links"
import { displayValue, getCell, misfit, parseInput, titleColumn, type TableActions } from "./model"
import { MAX_OPTION, MAX_OPTIONS, Tag, TagPicker, addOptionPatch } from "./tags"

/**
 * Everything in one row, in full: long research values wrap, sources are
 * clickable, and each value says who wrote it. Editable for editors.
 */
export function RecordPanel({
  state,
  rowId,
  focusColumn,
  links,
  actions,
  readOnly,
  onError,
  onClose,
}: {
  state: TableState
  rowId: string
  focusColumn?: string | undefined
  links?: TableLinks | undefined
  actions: TableActions
  readOnly: boolean
  onError: (message: string) => void
  onClose: () => void
}) {
  const title = titleColumn(state)
  const name = title ? displayValue(getCell(state, rowId, title.id)?.v) : ""
  const index = state.rowIds.indexOf(rowId)

  const ref = useRef<HTMLElement>(null)

  // Take focus on open so Esc and typing go to the panel, not the grid behind it.
  useEffect(() => {
    ref.current?.focus()
    if (focusColumn) document.getElementById(`field-${rowId}-${focusColumn}`)?.scrollIntoView({ block: "center" })
  }, [rowId, focusColumn])

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Record"
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") onClose()
      }}
      className="absolute inset-y-0 right-0 z-40 flex w-[min(440px,100%)] flex-col border-l border-border bg-bg shadow-xl outline-none"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-[12px] text-faint tabular-nums">#{index + 1}</span>
        <h2 className={`min-w-0 flex-1 truncate font-medium ${name ? "" : "text-faint"}`}>{name || "Untitled"}</h2>
        {!readOnly && (
          <button
            type="button"
            title="Delete row"
            aria-label="Delete row"
            onClick={() => {
              actions.removeRow(rowId)
              onClose()
            }}
            className="grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-danger"
          >
            <TrashIcon size={16} />
          </button>
        )}
        <button type="button" aria-label="Close" title="Close (Esc)" onClick={onClose} className="grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-text">
          <XIcon size={16} />
        </button>
      </header>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {state.columns.map((c) => (
          <Field
            key={c.id}
            id={`field-${rowId}-${c.id}`}
            column={c}
            cell={getCell(state, rowId, c.id)}
            highlighted={c.id === focusColumn}
            links={links}
            readOnly={readOnly}
            onSave={(raw) => {
              const parsed = parseInput(c, raw)
              if (!parsed.ok) return parsed.error
              if (!sameValue(parsed.value, getCell(state, rowId, c.id)?.v)) actions.setCell(rowId, c.id, parsed.value)
              return null
            }}
            onSet={(v) => {
              if (!sameValue(v, getCell(state, rowId, c.id)?.v)) actions.setCell(rowId, c.id, v)
            }}
            onCreateOption={(option) => {
              const options = c.options ?? []
              if (option.length > MAX_OPTION) onError(`Options can be up to ${MAX_OPTION} characters.`)
              else if (options.length >= MAX_OPTIONS) onError(`A select can have up to ${MAX_OPTIONS} options.`)
              else return actions.updateColumn(c.id, addOptionPatch(c, option))
              return false
            }}
          />
        ))}
      </div>
    </aside>
  )
}

function Field({
  id,
  column,
  cell,
  highlighted,
  links,
  readOnly,
  onSave,
  onSet,
  onCreateOption,
}: {
  id: string
  column: Column
  cell: Cell | undefined
  highlighted: boolean
  links: TableLinks | undefined
  readOnly: boolean
  /** Returns why the text doesn't fit the column, or null once saved. */
  onSave: (raw: string) => string | null
  onSet: (v: CellValue) => void
  onCreateOption: (option: string) => boolean
}) {
  const value = displayValue(cell?.v)
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(value)
    setError(null)
  }, [value])
  const byAgent = cell?.by?.includes(":")
  // Multi-select tags flag themselves one by one.
  const problem = error ?? (column.type === "multiSelect" && isTags(cell?.v) ? null : misfit(column, cell))
  const [picking, setPicking] = useState(false)

  return (
    <section id={id} className={`-mx-2 rounded-md px-2 py-1.5 ${highlighted ? "bg-surface ring-1 ring-border" : ""}`}>
      <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-muted">
        {column.name}
        <span className="font-normal text-faint">{columnTypes[column.type].label}</span>
        {cell?.status && cell.status !== "done" && <span className="rounded bg-hover px-1 text-[11px] font-normal">{cell.status}</span>}
        {cell?.by && (
          <span className="ml-auto flex items-center gap-1 font-normal text-faint" title={cell.by}>
            {byAgent && <RobotIcon size={12} />}
            {byAgent ? "Agent" : "Person"}
          </span>
        )}
      </div>

      {column.type === "checkbox" ? (
        <input
          type="checkbox"
          aria-label={column.name}
          checked={cell?.v === true}
          disabled={readOnly}
          onChange={(e) => onSet(e.target.checked)}
          className="size-4 accent-accent"
        />
      ) : column.type === "artifact" && links ? (
        <div className="relative">
          <div className="flex min-h-8 flex-wrap items-center gap-1">
            {refsOf(cell?.v).length ? (
              <RefChips links={links} value={cell?.v} wrap />
            ) : value ? (
              <span className="text-[14px] text-danger">{value}</span>
            ) : (
              readOnly && <span className="text-[14px] text-faint">Empty</span>
            )}
            {!readOnly && (
              <button
                type="button"
                aria-label={`Edit ${column.name}`}
                onClick={() => setPicking(true)}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted hover:bg-hover hover:text-text"
              >
                <PlusIcon size={12} /> Link
              </button>
            )}
          </div>
          {picking && (
            <RefPicker
              links={links}
              column={column}
              value={cell?.v}
              className="absolute top-0 -left-2 z-10"
              onChange={(next) => onSet(next.length ? next : null)}
              onClose={() => setPicking(false)}
            />
          )}
        </div>
      ) : column.type === "multiSelect" ? (
        <div className="relative">
          <button
            type="button"
            aria-label={`Edit ${column.name}`}
            disabled={readOnly}
            onClick={() => setPicking(true)}
            className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-transparent px-2 py-1 -mx-2 text-left text-[14px] enabled:hover:border-border"
          >
            {isTags(cell?.v) && cell.v.length ? (
              cell.v.map((t) => <Tag key={t} column={column} value={t} />)
            ) : cell?.v !== null && cell?.v !== undefined ? (
              <span className="text-danger">{displayValue(cell.v)}</span>
            ) : (
              <span className="text-faint">Empty</span>
            )}
          </button>
          {picking && (
            <TagPicker
              column={column}
              value={isTags(cell?.v) ? cell.v : []}
              multiple
              className="absolute top-0 -left-2 z-10"
              onChange={(next) => onSet(next.length ? next : null)}
              onCreate={onCreateOption}
              onClose={() => setPicking(false)}
            />
          )}
        </div>
      ) : column.type === "select" ? (
        <select
          aria-label={column.name}
          value={displayValue(cell?.v)}
          disabled={readOnly}
          onChange={(e) => onSet(e.target.value || null)}
          className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[14px] disabled:opacity-100"
        >
          <SelectOptions options={column.options ?? []} current={displayValue(cell?.v)} />
        </select>
      ) : readOnly ? (
        <p className={`text-[14px] leading-relaxed break-words whitespace-pre-wrap ${value ? "" : "text-faint"}`}>
          {column.type === "url" && value ? <Link href={value} /> : value || "Empty"}
        </p>
      ) : (
        <textarea
          aria-label={column.name}
          aria-invalid={!!error}
          value={draft}
          rows={Math.min(8, Math.max(1, Math.ceil(draft.length / 48)))}
          placeholder="Empty"
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onBlur={() => draft !== value && setError(onSave(draft))}
          onKeyDown={(e) => {
            // Save by moving focus to the panel (not blur(), which parks focus on <body> and makes Esc dead).
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.closest<HTMLElement>("[aria-label=Record]")?.focus()
            // Esc with unsaved text puts the saved value back; a second Esc closes the panel.
            if (e.key === "Escape" && draft !== value) {
              e.stopPropagation()
              setDraft(value)
              setError(null)
            }
          }}
          className={`w-full resize-none rounded-md border bg-transparent px-2 py-1.5 -mx-2 text-[14px] leading-relaxed focus:outline-none ${error ? "border-danger" : "border-transparent hover:border-border focus:border-accent"}`}
        />
      )}
      {problem && (
        <p role="alert" className="mt-1 text-[12px] text-danger">
          {problem}
        </p>
      )}

      {cell?.sources && cell.sources.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {cell.sources.map((s) => (
            <li key={s}>
              <Link href={s} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Option list for a select, keeping a current value that isn't an option so it's never silently shown as empty. */
export function SelectOptions({ options, current }: { options: ReadonlyArray<string>; current: string }) {
  return (
    <>
      <option value="">—</option>
      {current && !options.includes(current) && (
        <option value={current} disabled>
          {current} (not an option)
        </option>
      )}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </>
  )
}

function Link({ href }: { href: string }) {
  let label = href
  try {
    const u = new URL(href)
    label = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "")
  } catch {
    // not a URL; show as-is
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-[12px] text-accent hover:underline">
      <span className="truncate">{label}</span>
      <ArrowSquareOutIcon size={12} className="shrink-0" />
    </a>
  )
}
