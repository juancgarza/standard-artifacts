import { useMemo } from "react"
import {
  MAX_SET_CELLS,
  applyTableOp,
  cellKey,
  cellText,
  coerceCellValue,
  newId,
  type Cell,
  type CellValue,
  type CoerceResult,
  type Column,
  type Member,
  type TableOp,
  type TablePresence,
  type TableState,
} from "@standard-artifacts/protocol"
import type { RoomClient, RoomSnapshot } from "@standard-artifacts/room"
import { useRoom } from "@standard-artifacts/room/react"

export type TableRoom = RoomClient<TableState, TableOp>
export type TableSnapshot = RoomSnapshot<TableState>

/** Connect to a table cell. `url` is the room's ws(s):// address. */
export function useTableRoom(url: string, actorKey: string) {
  return useRoom<TableState, TableOp>({ url, actorKey, apply: applyTableOp })
}

/** Typed op helpers so views never hand-build op objects. */
export function useTableActions(room: TableRoom) {
  return useMemo(
    () => ({
      setCell: (rowId: string, colId: string, value: CellValue) => room.send({ type: "setCell", rowId, colId, value }),
      addRow: (values?: Record<string, CellValue>) => {
        const rowId = newId("r_")
        room.send({ type: "addRows", rowIds: [rowId], ...(values && { values: { [rowId]: values } }) })
        return rowId
      },
      removeRow: (rowId: string) => room.send({ type: "removeRows", rowIds: [rowId] }),
      /** Many cells at once (paste, clear, bulk edit); split to fit the op limit. Returns false if any part was rejected. */
      setCells: (cells: ReadonlyArray<{ rowId: string; colId: string; value: CellValue }>) => {
        let ok = true
        for (let i = 0; i < cells.length; i += MAX_SET_CELLS) ok = room.send({ type: "setCells", cells: cells.slice(i, i + MAX_SET_CELLS) }) && ok
        return ok
      },
      /** Append rows with initial values (already coerced); returns their ids in order. */
      addRows: (rows: ReadonlyArray<Record<string, CellValue>>) => {
        const rowIds = rows.map(() => newId("r_"))
        for (let i = 0; i < rowIds.length; i += ROWS_PER_OP) {
          const ids = rowIds.slice(i, i + ROWS_PER_OP)
          room.send({ type: "addRows", rowIds: ids, values: Object.fromEntries(ids.map((id, j) => [id, rows[i + j] ?? {}])) })
        }
        return rowIds
      },
      removeRows: (rowIds: ReadonlyArray<string>) => {
        for (let i = 0; i < rowIds.length; i += ROWS_PER_OP) room.send({ type: "removeRows", rowIds: rowIds.slice(i, i + ROWS_PER_OP) })
      },
      moveColumn: (id: string, index: number) => room.send({ type: "moveColumn", id, index }),
      renameOption: (id: string, from: string, to: string) => room.send({ type: "renameOption", id, from, to }),
      addColumn: (column: Omit<Column, "id">) => {
        const id = newId("c_")
        room.send({ type: "addColumn", column: { id, ...column } })
        return id
      },
      updateColumn: (id: string, patch: Partial<Omit<Column, "id">>) => room.send({ type: "updateColumn", id, patch }),
      removeColumn: (id: string) => room.send({ type: "removeColumn", id }),
      focus: (presence: TablePresence) => room.setPresence(presence),
    }),
    [room],
  )
}

/** The protocol's cap on row ids per addRows/removeRows op. */
const ROWS_PER_OP = 1000

export type TableActions = ReturnType<typeof useTableActions>

export const getCell = (state: TableState, rowId: string, colId: string): Cell | undefined =>
  state.cells[cellKey(rowId, colId)]

/** Who (other than me) is pointing at which cell. */
export function presenceByCell(others: ReadonlyArray<Member>) {
  const map = new Map<string, Array<Member>>()
  for (const m of others) {
    const sel = (m.presence as TablePresence).selection
    if (!sel) continue
    const key = cellKey(sel.rowId, sel.colId)
    map.set(key, [...(map.get(key) ?? []), m])
  }
  return map
}

/** Cells inside someone else's multi-cell selection, tinted with their color. */
export function presenceRanges(others: ReadonlyArray<Member>) {
  const map = new Map<string, string>()
  for (const m of others) {
    const range = (m.presence as TablePresence).range
    if (!range) continue
    for (const rowId of range.rowIds) for (const colId of range.colIds) map.set(cellKey(rowId, colId), m.color)
  }
  return map
}

/** The longest value a cell holds (matches CellValue in the protocol), checked here so people get a clear message. */
export const MAX_CELL_LENGTH = 20_000

/**
 * Convert what someone typed into a value for this column, or an error message.
 * Same rules the reducer applies to every write (coerceCellValue), so a value
 * the editor accepts is never rejected by the cell.
 */
export function parseInput(column: Column, raw: string): CoerceResult {
  if (raw.trim() === "") return { ok: true, value: null }
  if (raw.length > MAX_CELL_LENGTH) return { ok: false, error: `Too long: a cell holds up to ${MAX_CELL_LENGTH.toLocaleString("en-US")} characters` }
  return coerceCellValue(column, raw)
}

/**
 * Why a stored value doesn't fit its column, e.g. text left in a column that
 * became a Number, or a status that isn't one of the options any more.
 */
export function misfit(column: Column, cell: Cell | undefined): string | null {
  if (!cell || cell.v === null || (cell.status && cell.status !== "done")) return null
  const r = coerceCellValue(column, cell.v)
  return r.ok ? null : r.error
}

/** A value as text: tags as "a, b", booleans as Yes/No. */
export const displayValue = (v: CellValue | undefined) => cellText(v)

/** "Column 4", or the next free number, since column names must be unique. */
export function nextColumnName(columns: ReadonlyArray<Column>) {
  const taken = new Set(columns.map((c) => c.name.trim().toLowerCase()))
  let n = columns.length + 1
  while (taken.has(`column ${n}`)) n++
  return `Column ${n}`
}

/** `base`, or "base 2", "base 3"… if a column already has that name. */
export function freeColumnName(columns: ReadonlyArray<Column>, base: string) {
  const taken = new Set(columns.map((c) => c.name.trim().toLowerCase()))
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`
  return name
}

/** First text-ish column: the row's title on kanban cards. */
export const titleColumn = (state: TableState) =>
  state.columns.find((c) => c.type === "text") ?? state.columns[0]
