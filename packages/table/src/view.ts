import { cellKey, cellLabel, cellText, isTags, type CellValue, type Column, type ColumnType, type TableState, type TitleOf } from "@standard-artifacts/protocol"

/**
 * Per-viewer view settings: sort, filters, search and hidden columns. They
 * only change what this viewer sees; the shared row order is never touched.
 */
export type SortRule = { colId: string; dir: "asc" | "desc" }

export type FilterOp =
  | "contains"
  | "notContains"
  | "is"
  | "isNot"
  | "has"
  | "hasNot"
  | "eq"
  | "gt"
  | "lt"
  | "checked"
  | "unchecked"
  | "empty"
  | "notEmpty"

export type FilterRule = { id: string; colId: string; op: FilterOp; value: string }

export type ViewSettings = {
  sort: SortRule | null
  filters: ReadonlyArray<FilterRule>
  search: string
  hidden: ReadonlyArray<string>
}

export const emptyView: ViewSettings = { sort: null, filters: [], search: "", hidden: [] }

const labels: Record<FilterOp, string> = {
  contains: "contains",
  notContains: "does not contain",
  is: "is",
  isNot: "is not",
  has: "has",
  hasNot: "doesn't have",
  eq: "=",
  gt: ">",
  lt: "<",
  checked: "is checked",
  unchecked: "is not checked",
  empty: "is empty",
  notEmpty: "is not empty",
}

/** The operators that make sense for a column type, in menu order. */
export function filterOps(type: ColumnType): ReadonlyArray<{ op: FilterOp; label: string; needsValue: boolean }> {
  const ops: Array<FilterOp> =
    type === "select"
      ? ["is", "isNot", "empty", "notEmpty"]
      : type === "multiSelect"
        ? ["has", "hasNot", "empty", "notEmpty"]
        : type === "number"
          ? ["eq", "gt", "lt", "empty", "notEmpty"]
          : type === "checkbox"
            ? ["checked", "unchecked"]
            : ["contains", "notContains", "empty", "notEmpty"]
  return ops.map((op) => ({ op, label: labels[op], needsValue: !["checked", "unchecked", "empty", "notEmpty"].includes(op) }))
}

/** A filter still waiting for its value (or whose column is gone) doesn't filter anything. */
export function isActive(rule: FilterRule, columns: ReadonlyArray<Column>) {
  const column = columns.find((c) => c.id === rule.colId)
  if (!column) return false
  const spec = filterOps(column.type).find((o) => o.op === rule.op)
  return !!spec && (!spec.needsValue || rule.value.trim() !== "")
}

const isEmpty = (v: CellValue | undefined) => v === null || v === undefined || v === "" || (isTags(v) && v.length === 0)
const lower = (s: string) => s.trim().toLowerCase()

function matches(rule: FilterRule, column: Column | undefined, v: CellValue | undefined, titleOf: TitleOf | undefined): boolean {
  const want = lower(rule.value)
  const label = () => lower(column ? cellLabel(column, v, titleOf) : cellText(v))
  switch (rule.op) {
    case "empty":
      return isEmpty(v)
    case "notEmpty":
      return !isEmpty(v)
    case "checked":
      return v === true
    case "unchecked":
      return v !== true
    case "contains":
      return label().includes(want)
    case "notContains":
      return !label().includes(want)
    case "is":
      return lower(cellText(v)) === want
    case "isNot":
      return lower(cellText(v)) !== want
    case "has":
      return isTags(v) ? v.some((t) => lower(t) === want) : lower(cellText(v)) === want
    case "hasNot":
      return !(isTags(v) ? v.some((t) => lower(t) === want) : lower(cellText(v)) === want)
    case "eq":
    case "gt":
    case "lt": {
      const n = typeof v === "number" ? v : Number(cellText(v))
      const target = Number(rule.value)
      if (isEmpty(v) || !Number.isFinite(n) || !Number.isFinite(target)) return false
      return rule.op === "eq" ? n === target : rule.op === "gt" ? n > target : n < target
    }
  }
}

/** Sort key for one cell: options sort in option order (like kanban lanes), numbers numerically, the rest as text. */
function compareCells(column: Column, a: CellValue | undefined, b: CellValue | undefined, titleOf: TitleOf | undefined): number {
  if (column.type === "number" && typeof a === "number" && typeof b === "number") return a - b
  if (column.type === "checkbox") return Number(a === true) - Number(b === true)
  if (column.type === "select" || column.type === "multiSelect") {
    const options = column.options ?? []
    const rank = (v: CellValue | undefined) => {
      const first = isTags(v) ? v[0] : typeof v === "string" ? v : undefined
      const i = first === undefined ? -1 : options.indexOf(first)
      return i < 0 ? options.length : i
    }
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    if (isTags(a) && isTags(b) && a.length !== b.length) return a.length - b.length
  }
  return cellLabel(column, a, titleOf).localeCompare(cellLabel(column, b, titleOf), undefined, { numeric: true, sensitivity: "base" })
}

/**
 * The rows this viewer sees, in the order they see them. `keep` holds rows that
 * stay visible even if they stop matching (ones this viewer just added or is
 * working in), so a row doesn't vanish from under the cursor mid-edit.
 */
export function visibleRows(state: TableState, view: ViewSettings, keep: ReadonlySet<string>, titleOf?: TitleOf): ReadonlyArray<string> {
  const filters = view.filters.filter((f) => isActive(f, state.columns))
  let rows: ReadonlyArray<string> = state.rowIds
  if (filters.length) {
    rows = rows.filter(
      (rowId) => keep.has(rowId) || filters.every((f) => matches(f, state.columns.find((c) => c.id === f.colId), state.cells[cellKey(rowId, f.colId)]?.v, titleOf)),
    )
  }
  const sort = view.sort
  const column = sort && state.columns.find((c) => c.id === sort.colId)
  if (sort && column) {
    const dir = sort.dir === "asc" ? 1 : -1
    const index = new Map(state.rowIds.map((r, i) => [r, i]))
    rows = [...rows].sort((ra, rb) => {
      const a = state.cells[cellKey(ra, column.id)]?.v
      const b = state.cells[cellKey(rb, column.id)]?.v
      // Empty cells go last whichever way you sort, like Airtable and Sheets.
      const ea = isEmpty(a)
      const eb = isEmpty(b)
      if (ea !== eb) return ea ? 1 : -1
      const d = ea ? 0 : compareCells(column, a, b, titleOf) * dir
      return d !== 0 ? d : (index.get(ra) ?? 0) - (index.get(rb) ?? 0)
    })
  }
  return rows
}

export const visibleColumns = (state: TableState, view: ViewSettings) => state.columns.filter((c) => !view.hidden.includes(c.id))

/** Cells whose text contains the search, in reading order (row by row). */
export function searchMatches(state: TableState, rows: ReadonlyArray<string>, columns: ReadonlyArray<Column>, search: string, titleOf?: TitleOf) {
  const q = lower(search)
  const out: Array<{ rowId: string; colId: string }> = []
  if (!q) return out
  for (const rowId of rows) {
    for (const c of columns) {
      if (lower(cellLabel(c, state.cells[cellKey(rowId, c.id)]?.v, titleOf)).includes(q)) out.push({ rowId, colId: c.id })
    }
  }
  return out
}
