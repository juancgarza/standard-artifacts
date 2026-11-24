import { useMemo, useState } from "react"
import { PlusIcon } from "@phosphor-icons/react"
import { cellKey, coerceCellValue, hasOptions, isTags, refsOf, type Column, type Member, type TablePresence, type TableState } from "@standard-artifacts/protocol"
import { displayValue, freeColumnName, getCell, misfit, titleColumn, type TableActions } from "./model"
import { RefChips, type TableLinks } from "./links"
import { PresenceTag } from "./presence"
import { Tag } from "./tags"

const NONE = "\u0000none"
/** Row ids travel in dataTransfer so a drop never depends on React having re-rendered mid-drag. */
const ROW_MIME = "application/x-standard-artifacts-row"

/**
 * Kanban over a table: one lane per option of a select column, plus "No status"
 * for empty or unknown values. Cards are rows; moving a card is a single setCell,
 * so agents move cards the same way people do.
 *
 * Only single selects group. A multi-select row would belong to several lanes,
 * and dragging it would have to guess which tag to replace, so multi-select
 * columns show as tags on the cards instead.
 */
export function KanbanView({
  state,
  rows: visible,
  others,
  actions,
  readOnly,
  groupBy,
  links,
}: {
  state: TableState
  /** The rows this viewer sees, in order (after their sort and filters). Defaults to all rows. */
  rows?: ReadonlyArray<string>
  others: ReadonlyArray<Member>
  actions: TableActions
  readOnly: boolean
  /** Select column id to group by. Defaults to the first select column. */
  groupBy?: string
  /** Chips for Artifact cells. */
  links?: TableLinks | undefined
}) {
  const [picked, setPicked] = useState(groupBy)
  const selects = state.columns.filter((c) => c.type === "select")
  const group = selects.find((c) => c.id === picked) ?? selects.find((c) => c.id === groupBy) ?? selects[0]
  const title = titleColumn(state)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const byRow = useMemo(() => {
    const map = new Map<string, Array<Member>>()
    for (const m of others) {
      const rowId = (m.presence as TablePresence).selection?.rowId
      if (rowId) map.set(rowId, [...(map.get(rowId) ?? []), m])
    }
    return map
  }, [others])

  if (!group) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-xs">
          <p className="font-medium">Kanban groups rows by a Select column</p>
          <p className="mt-1 text-[13px] text-muted">This table doesn't have one yet.</p>
          {!readOnly && (
            <button
              type="button"
              onClick={() => actions.addColumn({ name: freeColumnName(state.columns, "Status"), type: "select", options: ["Lead", "Contacted", "Replied", "Won"] })}
              className="mt-4 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-text"
            >
              Add a Status column
            </button>
          )}
        </div>
      </div>
    )
  }

  const options = group.options ?? []
  const lanes = [...options, NONE]
  const laneOf = (rowId: string) => {
    const v = getCell(state, rowId, group.id)?.v
    if (v === null || v === undefined) return NONE
    // Same matching as writes ("lead" lands in "Lead"); anything else waits in the catch-all lane.
    const r = coerceCellValue(group, v)
    return r.ok && typeof r.value === "string" ? r.value : NONE
  }
  const details = state.columns.filter((c) => c.id !== group.id && c.id !== title?.id).slice(0, 3)

  const drop = (lane: string, rowId: string | null) => {
    if (rowId && state.rowIds.includes(rowId) && laneOf(rowId) !== lane) {
      actions.setCell(rowId, group.id, lane === NONE ? null : lane)
    }
    setDragging(null)
    setOver(null)
  }

  return (
    <div className="flex h-full flex-col">
      {(selects.length > 1 || options.length === 0) && (
        <div className="flex shrink-0 items-center gap-3 px-4 pt-3 text-[13px] text-muted">
          {selects.length > 1 && (
            <label className="flex items-center gap-2">
              Group by
              <select
                value={group.id}
                onChange={(e) => setPicked(e.target.value)}
                className="rounded-md border border-border bg-bg px-1.5 py-1 text-[13px] text-text"
              >
                {selects.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {options.length === 0 && <span>{group.name} has no options yet. Add them from its column menu in Grid view.</span>}
        </div>
      )}
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {lanes.map((lane) => {
        const rows = (visible ?? state.rowIds).filter((r) => laneOf(r) === lane)
        if (lane === NONE && rows.length === 0 && options.length > 0 && !dragging) return null
        return (
          <section
            key={lane}
            onDragOver={(e) => {
              if (readOnly || !e.dataTransfer.types.includes(ROW_MIME)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              setOver(lane)
            }}
            onDragLeave={() => setOver((o) => (o === lane ? null : o))}
            onDrop={(e) => {
              e.preventDefault()
              drop(lane, e.dataTransfer.getData(ROW_MIME) || dragging)
            }}
            className={`flex w-72 shrink-0 flex-col rounded-lg bg-surface transition-colors ${over === lane ? "ring-2 ring-accent" : ""}`}
          >
            <header className="flex items-center gap-2 px-3 pt-3 pb-2 text-[13px] font-medium">
              {lane === NONE ? <span className="text-muted">No {group.name.toLowerCase()}</span> : <Tag column={group} value={lane} />}
              <span className="text-faint">{rows.length}</span>
            </header>
            <div className="flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {rows.map((rowId) => (
                <Card
                  key={rowId}
                  rowId={rowId}
                  state={state}
                  title={title}
                  group={group}
                  details={details}
                  links={links}
                  here={byRow.get(rowId) ?? []}
                  draggable={!readOnly}
                  dragging={dragging === rowId}
                  onDragStart={() => setDragging(rowId)}
                  onDragEnd={() => {
                    setDragging(null)
                    setOver(null)
                  }}
                  onFocus={() => title && actions.focus({ selection: { rowId, colId: title.id } })}
                />
              ))}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => actions.addRow(lane === NONE ? undefined : { [group.id]: lane })}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-text"
                >
                  <PlusIcon size={12} weight="bold" /> New
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
    </div>
  )
}

function Card({
  rowId,
  state,
  title,
  group,
  details,
  links,
  here,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onFocus,
}: {
  rowId: string
  state: TableState
  title: Column | undefined
  group: Column
  details: ReadonlyArray<Column>
  links: TableLinks | undefined
  here: ReadonlyArray<Member>
  draggable: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onFocus: () => void
}) {
  const name = title ? displayValue(state.cells[cellKey(rowId, title.id)]?.v) : ""
  const ring = here[0]?.color
  return (
    <article
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData(ROW_MIME, rowId)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onMouseDown={onFocus}
      className={`relative rounded-md border border-border bg-bg p-2.5 text-[13px] shadow-sm ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${dragging ? "opacity-40" : ""}`}
      style={ring ? { boxShadow: `0 0 0 2px ${ring}` } : undefined}
    >
      {here.length > 0 && <PresenceTag members={here} />}
      <div className={`font-medium ${name ? "" : "text-faint"}`}>{name || "Untitled"}</div>
      {misfit(group, state.cells[cellKey(rowId, group.id)]) && (
        <div className="mt-1 text-[12px] text-danger" title={`Not one of ${group.name}'s options. Drag the card to a lane to fix it.`}>
          {group.name}: {displayValue(state.cells[cellKey(rowId, group.id)]?.v)} (not an option)
        </div>
      )}
      {details.map((c) => {
        const cell = state.cells[cellKey(rowId, c.id)]
        const v = displayValue(cell?.v)
        if (!v && cell?.status !== "running") return null
        if (c.type === "artifact" && refsOf(cell?.v).length) {
          return (
            <div key={c.id} className="mt-1.5" title={c.name}>
              <RefChips links={links} value={cell?.v} wrap />
            </div>
          )
        }
        if (hasOptions(c.type) && cell?.status !== "running") {
          const tags = isTags(cell?.v) ? cell.v : [v]
          return (
            <div key={c.id} className="mt-1.5 flex flex-wrap gap-1" title={c.name}>
              {tags.map((t) => (
                <Tag key={t} column={c} value={t} />
              ))}
            </div>
          )
        }
        return (
          <div key={c.id} className="mt-1 flex gap-1.5 text-[12px] text-muted">
            <span className="shrink-0 text-faint">{c.name}</span>
            <span className={`truncate ${cell?.status === "running" ? "animate-pulse" : ""}`}>
              {cell?.status === "running" ? "Researching…" : v}
            </span>
          </div>
        )
      })}
    </article>
  )
}
