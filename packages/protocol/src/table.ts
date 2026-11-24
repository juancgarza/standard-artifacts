import { Schema } from "effect"
import { Id, parseArtifactUrl, type ArtifactRef } from "./core.ts"
import { kindOfId } from "./mention.ts"

/**
 * Table surface: columns, ordered rows, and cells keyed `rowId:colId`.
 * `applyTableOp` is the single reducer used by the cell (authoritative) and by
 * the browser (optimistic), so both always agree on what an op does.
 */

export const ColumnType = Schema.Literals(["text", "number", "url", "email", "checkbox", "select", "multiSelect", "artifact", "agent"])
export type ColumnType = typeof ColumnType.Type

export const columnTypes: Record<ColumnType, { label: string }> = {
  text: { label: "Text" },
  number: { label: "Number" },
  url: { label: "URL" },
  email: { label: "Email" },
  checkbox: { label: "Checkbox" },
  select: { label: "Select" },
  multiSelect: { label: "Multi-select" },
  artifact: { label: "Artifact" },
  agent: { label: "Agent" },
}

/** Column types whose values come from the column's `options`. */
export const hasOptions = (type: ColumnType) => type === "select" || type === "multiSelect"

/** Tag colors for select options. Names, not hex, so each theme can render them legibly. */
export const OptionColor = Schema.Literals(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"])
export type OptionColor = typeof OptionColor.Type
export const optionColors: ReadonlyArray<OptionColor> = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]

/**
 * An option's color: the one someone picked, or a stable pick from its name,
 * so tags are colored (and stay the same color everywhere) before anyone chooses.
 */
export function optionColor(column: { readonly colors?: Readonly<Record<string, OptionColor>> | undefined }, option: string): OptionColor {
  const picked = column.colors?.[option]
  if (picked) return picked
  let h = 0
  for (const ch of option.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0
  // Skip gray: it reads as "unset", so it's only used when chosen.
  return optionColors[1 + (Math.abs(h) % (optionColors.length - 1))] ?? "blue"
}

const OptionName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60))

const ColumnFields = {
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  type: ColumnType,
  width: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 800 }))),
  /** For agent columns: what the agent should produce for each row. */
  prompt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  /** For select and multi-select columns: the allowed values, in lane order for kanban. */
  options: Schema.optionalKey(Schema.Array(OptionName).check(Schema.isMaxLength(50))),
  /** Option name to tag color, for options someone colored. Others get `optionColor`'s default. */
  colors: Schema.optionalKey(Schema.Record(Schema.String, OptionColor)),
}

export const Column = Schema.Struct({ id: Id, ...ColumnFields })
export interface Column extends Schema.Schema.Type<typeof Column> {}

export const ColumnPatch = Schema.Struct({
  name: Schema.optionalKey(ColumnFields.name),
  type: Schema.optionalKey(ColumnType),
  width: ColumnFields.width,
  prompt: ColumnFields.prompt,
  options: ColumnFields.options,
  colors: ColumnFields.colors,
})

/**
 * What a cell holds. The array form (added with multi-select) is new; every
 * value stored before it is still one of the scalar forms, so old tables load
 * and old clients' ops still decode unchanged.
 */
export const CellValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(20_000)),
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
  /** Multi-select tags, or an Artifact column's references (see `refText`), in the order they were added. */
  Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(100)),
])
export type CellValue = typeof CellValue.Type

/** A multi-select value. (Array.isArray doesn't narrow readonly arrays out of a union.) */
export const isTags = (v: CellValue | undefined): v is ReadonlyArray<string> => Array.isArray(v)

/** Value equality (tags compare by content), so writes that change nothing can be skipped. */
export function sameValue(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (isTags(a) && isTags(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  return (a ?? null) === (b ?? null)
}

export const CellStatus = Schema.Literals(["queued", "running", "done", "error"])
export type CellStatus = typeof CellStatus.Type

const Sources = Schema.Array(Schema.String.check(Schema.isPattern(/^https?:\/\//))).check(Schema.isMaxLength(20))

export const Cell = Schema.Struct({
  v: CellValue,
  /** actorKey of whoever last wrote this cell. */
  by: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(CellStatus),
  sources: Schema.optionalKey(Sources),
})
export interface Cell extends Schema.Schema.Type<typeof Cell> {}

const RowIds = Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(1000))

/** Most cells one setCells op writes (a paste or bulk edit); clients split bigger writes. */
export const MAX_SET_CELLS = 5000

export const TableOp = Schema.Union([
  Schema.Struct({ type: Schema.tag("addColumn"), column: Column, index: Schema.optionalKey(Schema.Int) }),
  Schema.Struct({ type: Schema.tag("updateColumn"), id: Id, patch: ColumnPatch }),
  Schema.Struct({ type: Schema.tag("removeColumn"), id: Id }),
  Schema.Struct({
    type: Schema.tag("addRows"),
    rowIds: RowIds,
    /** Optional initial values per row, keyed by column id. */
    values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Record(Schema.String, CellValue))),
  }),
  Schema.Struct({ type: Schema.tag("removeRows"), rowIds: RowIds }),
  Schema.Struct({
    type: Schema.tag("setCell"),
    rowId: Id,
    colId: Id,
    value: CellValue,
    status: Schema.optionalKey(CellStatus),
    sources: Schema.optionalKey(Sources),
  }),
  /** Move a column so it ends up at `index` (clamped). */
  Schema.Struct({ type: Schema.tag("moveColumn"), id: Id, index: Schema.Int }),
  /** Write many cells at once (paste, clear a range, bulk edit). All or nothing. */
  Schema.Struct({
    type: Schema.tag("setCells"),
    cells: Schema.Array(Schema.Struct({ rowId: Id, colId: Id, value: CellValue })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_SET_CELLS),
    ),
  }),
  /** Rename a select option, its color, and every cell that holds it. */
  Schema.Struct({ type: Schema.tag("renameOption"), id: Id, from: OptionName, to: OptionName }),
])
export type TableOp = typeof TableOp.Type

export const decodeTableOp = Schema.decodeUnknownResult(TableOp)

export const TableState = Schema.Struct({
  columns: Schema.Array(Column),
  rowIds: Schema.Array(Schema.String),
  cells: Schema.Record(Schema.String, Cell),
})
export interface TableState extends Schema.Schema.Type<typeof TableState> {}

/** What a person or agent is pointing at in a table. */
export type TablePresence = {
  selection?: { rowId: string; colId: string } | null
  /** A multi-cell selection, as the rows and columns it spans (capped; ids, since each viewer may sort differently). */
  range?: { rowIds: ReadonlyArray<string>; colIds: ReadonlyArray<string> } | null
  editing?: boolean
  thinking?: boolean
  status?: string
}

export const cellKey = (rowId: string, colId: string) => `${rowId}:${colId}`

export const emptyTable = (): TableState => ({ columns: [], rowIds: [], cells: {} })

export type ApplyResult = { ok: true; state: TableState } | { ok: false; error: string }

export type CoerceResult = { ok: true; value: CellValue } | { ok: false; error: string }

const TRUE = /^(true|yes|y|1|x|checked|✓)$/i
const FALSE = /^(false|no|n|0|unchecked)$/i

/**
 * Fit a value to a column's type: what a person typed, what an agent sent, or
 * what a cell held before its column changed type. The reducer runs every
 * write through this, so the cell and the browser accept (and reject) exactly
 * the same values, and errors name the column and say what it expects.
 */
export function coerceCellValue(column: Pick<Column, "name" | "type" | "options">, input: CellValue): CoerceResult {
  if (input === null) return okValue(null)
  const label = `"${column.name}"`
  if (column.type === "multiSelect") return coerceTags(column, input, label)
  if (column.type === "artifact") return coerceRefs(input, label)
  if (column.type === "select" && isTags(input) && input.length > 1) {
    return failValue(`${label} is a Select column and holds one option, not ${input.length} (${clip(input.join(", "))})`)
  }
  // Single-value columns read tags as "a, b", so multi-select → text → multi-select round-trips.
  const value = isTags(input) ? (input.length ? input.join(", ") : null) : input
  if (value === null) return okValue(null)
  switch (column.type) {
    case "number": {
      if (typeof value === "number") return okValue(value)
      if (typeof value === "boolean") return failValue(`${label} is a Number column; it can't hold ${value ? "Yes" : "No"}`)
      const text = value.trim()
      if (text === "") return okValue(null)
      // Accept what people paste: "1,200", "$1,200", "1 200".
      const digits = text.replace(/^[$€£¥]/, "").replace(/[,\s_]/g, "")
      const n = digits === "" ? NaN : Number(digits)
      return Number.isFinite(n) ? okValue(n) : failValue(`${label} is a Number column, and "${clip(text)}" isn't a number`)
    }
    case "checkbox": {
      if (typeof value === "boolean") return okValue(value)
      const text = String(value).trim()
      if (text === "") return okValue(null)
      if (TRUE.test(text)) return okValue(true)
      if (FALSE.test(text)) return okValue(false)
      return failValue(`${label} is a Checkbox column; use yes/no or true/false, not "${clip(text)}"`)
    }
    case "select": {
      const text = asText(value).trim()
      if (text === "") return okValue(null)
      const options = column.options ?? []
      const match = findOption(options, text)
      if (match) return okValue(match)
      return failValue(
        options.length
          ? `${label} has no option "${clip(text)}". Options: ${options.join(", ")}`
          : `${label} has no options yet. Add options to the column first`,
      )
    }
    default:
      return okValue(asText(value))
  }
}

/** Multi-select: a list of options, or text split on commas and newlines ("a, b"), matched like Select. */
function coerceTags(column: Pick<Column, "type" | "options">, value: CellValue, label: string): CoerceResult {
  if (value === null) return okValue(null)
  const options = column.options ?? []
  const items = isTags(value) ? value : splitTags(asText(value), options)
  const out: Array<string> = []
  for (const raw of items) {
    const text = raw.trim()
    if (!text) continue
    const match = findOption(options, text)
    if (!match) {
      return failValue(
        options.length
          ? `${label} has no option "${clip(text)}". Options: ${options.join(", ")}`
          : `${label} has no options yet. Add options to the column first`,
      )
    }
    if (!out.includes(match)) out.push(match)
  }
  return okValue(out.length ? out : null)
}

/** How many references an Artifact cell holds: CellValue's limit on a list. */
const MAX_REFS = 100

/** An Artifact cell stores each reference as `id` or `id#item`, the form doc embeds write as `![[id#item]]`. */
export const refText = (ref: ArtifactRef) => (ref.item ? `${ref.artifactId}#${ref.item}` : ref.artifactId)

/**
 * `t_abc`, `t_abc#r_1`, or a link to either. A link counts from any origin, so
 * this reads the same in the cell as in the browser, and links survive a move
 * between hosts. Only an id is kept, and access is checked when it's viewed.
 */
export function parseRef(text: string): ArtifactRef | null {
  const raw = text.trim()
  const m = raw.match(/^([\w-]{1,64})(?:#([\w-]{1,64}))?$/)
  const ref = parseArtifactUrl(raw) ?? (m?.[1] ? { artifactId: m[1], ...(m[2] && { item: m[2] }) } : null)
  return ref && kindOfId(ref.artifactId) ? ref : null
}

/** What an Artifact cell points at, leaving out anything that isn't a reference. */
export const refsOf = (v: CellValue | undefined): ReadonlyArray<ArtifactRef> => (isTags(v) ? v.flatMap((t) => parseRef(t) ?? []) : [])

/** Artifact: a list of references, or text split on commas and newlines. Stored in one form, without repeats. */
function coerceRefs(value: Exclude<CellValue, null>, label: string): CoerceResult {
  const items = isTags(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : [asText(value)]
  const out: Array<string> = []
  for (const raw of items) {
    const text = raw.trim()
    if (!text) continue
    const ref = parseRef(text)
    if (!ref) return failValue(`${label} links to artifacts, and "${clip(text)}" isn't one. Use an id like t_abc or t_abc#r_1, or a link copied from the app`)
    const canonical = refText(ref)
    if (!out.includes(canonical)) out.push(canonical)
  }
  if (out.length > MAX_REFS) return failValue(`${label} holds up to ${MAX_REFS} links in a cell, not ${out.length}`)
  return okValue(out.length ? out : null)
}

const findOption = (options: ReadonlyArray<string>, text: string) =>
  options.find((o) => o === text) ?? options.find((o) => o.toLowerCase() === text.toLowerCase())

/** "a, b" → ["a", "b"], unless the whole text is itself an option. */
export function splitTags(text: string, options: ReadonlyArray<string> = []): Array<string> {
  if (findOption(options, text.trim())) return [text.trim()]
  return text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)
}

/** A value as plain text: tags as "a, b", booleans as Yes/No. */
export const cellText = (v: CellValue | undefined): string =>
  v === null || v === undefined ? "" : isTags(v) ? v.join(", ") : asText(v)

/** The titles of the artifacts this viewer can open; anything else has no title for them. */
export type TitleOf = (artifactId: string) => string | undefined

/**
 * A value as a person reads it: like `cellText`, but references show as titles.
 * What this viewer can't open stays "Unavailable", so its title never leaks.
 */
export const cellLabel = (column: Pick<Column, "type">, v: CellValue | undefined, titleOf?: TitleOf): string => {
  const refs = column.type === "artifact" && titleOf ? refsOf(v) : []
  return refs.length ? refs.map((r) => titleOf?.(r.artifactId) ?? "Unavailable").join(", ") : cellText(v)
}

const asText = (v: string | number | boolean) => (typeof v === "string" ? v : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v))
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s)
const okValue = (value: CellValue): CoerceResult => ({ ok: true, value })
const failValue = (error: string): CoerceResult => ({ ok: false, error })

/** Agent progress (queued/running) and failures carry free-form text, so only settled values are typed. */
const settled = (status: CellStatus | undefined) => status === undefined || status === "done"

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Trimmed, non-empty, de-duplicated (React keys and kanban lanes need unique options). */
const cleanOptions = (options: ReadonlyArray<string>) => {
  const out: Array<string> = []
  for (const raw of options) {
    const o = raw.trim()
    if (o && !out.some((x) => sameName(x, o))) out.push(o)
  }
  return out
}

/**
 * Options for a column turning into a (multi-)select: what it already had, plus
 * the values it holds. A multi-select splits text on commas ("a, b" is two tags).
 */
function optionsFromValues(state: TableState, colId: string, existing: ReadonlyArray<string>, split: boolean) {
  const out = cleanOptions(existing)
  for (const rowId of state.rowIds) {
    const v = state.cells[cellKey(rowId, colId)]?.v
    if (v === null || v === undefined) continue
    const parts = isTags(v) ? v : split ? splitTags(asText(v)) : [asText(v)]
    for (const part of parts) {
      const o = part.trim()
      if (out.length >= 50) return out
      if (o && o.length <= 60 && !out.some((x) => sameName(x, o))) out.push(o)
    }
  }
  return out
}

/** Clean options, and drop colors of options that no longer exist (renamed options carry theirs over). */
function tidyColumn(column: Column): Column {
  if (!column.options && !column.colors) return column
  const options = cleanOptions(column.options ?? [])
  const { colors, ...rest } = column
  const kept = colors ? Object.fromEntries(Object.entries(colors).filter(([o]) => options.includes(o))) : {}
  return { ...rest, ...(column.options && { options }), ...(Object.keys(kept).length > 0 && { colors: kept }) }
}

/** Validate and write one cell into `cells` (mutated: callers pass their own copy). Returns why it can't, or null. */
function putCell(
  state: TableState,
  rows: ReadonlySet<string>,
  cells: Record<string, Cell>,
  w: { rowId: string; colId: string; value: CellValue; status?: CellStatus | undefined; sources?: ReadonlyArray<string> | undefined },
  by: string,
): string | null {
  if (!rows.has(w.rowId)) return `Row ${w.rowId} doesn't exist (it may have been deleted)`
  const column = state.columns.find((c) => c.id === w.colId)
  if (!column) return `Column ${w.colId} doesn't exist (it may have been deleted)`
  let value = w.value
  if (settled(w.status)) {
    const r = coerceCellValue(column, value)
    if (!r.ok) return r.error
    value = r.value
  }
  const key = cellKey(w.rowId, w.colId)
  if ((value === null || value === "") && !w.status) delete cells[key]
  else cells[key] = { v: value, by, ...(w.status && { status: w.status }), ...(w.sources && { sources: w.sources }) }
  return null
}

/** Pure: returns a new state, never mutates. */
export function applyTableOp(state: TableState, op: TableOp, by: string): ApplyResult {
  switch (op.type) {
    case "addColumn": {
      if (state.columns.some((c) => c.id === op.column.id)) return fail("Column already exists")
      const clash = state.columns.find((c) => sameName(c.name, op.column.name))
      if (clash) return fail(`There's already a column named "${clash.name}"`)
      const column = tidyColumn(op.column)
      const columns = [...state.columns]
      const index = Math.max(0, Math.min(columns.length, op.index ?? columns.length))
      columns.splice(index, 0, column)
      return ok({ ...state, columns })
    }
    case "updateColumn": {
      const current = state.columns.find((c) => c.id === op.id)
      if (!current) return fail("Unknown column")
      const { patch } = op
      const name = patch.name
      const clash = name === undefined ? undefined : state.columns.find((c) => c.id !== op.id && sameName(c.name, name))
      if (clash) return fail(`There's already a column named "${clash.name}"`)
      let next = tidyColumn({ ...current, ...patch })
      let cells = state.cells
      if (patch.type && patch.type !== current.type) {
        if (hasOptions(next.type) && patch.options === undefined) {
          next = { ...next, options: optionsFromValues(state, op.id, next.options ?? [], next.type === "multiSelect") }
        }
        // Convert what converts ("42" to 42, "yes" to true); keep the rest as-is
        // so changing the type back never loses data. The grid flags leftovers.
        const converted: Record<string, Cell> = { ...state.cells }
        for (const rowId of state.rowIds) {
          const key = cellKey(rowId, op.id)
          const cell = converted[key]
          if (!cell || !settled(cell.status)) continue
          const r = coerceCellValue(next, cell.v)
          if (r.ok && r.value !== null && !sameValue(r.value, cell.v)) converted[key] = { ...cell, v: r.value }
        }
        cells = converted
      }
      return ok({ ...state, columns: state.columns.map((c) => (c.id === op.id ? next : c)), cells })
    }
    case "removeColumn": {
      if (!state.columns.some((c) => c.id === op.id)) return fail("Unknown column")
      if (state.columns.length === 1) return fail("A table needs at least one column")
      const cells: Record<string, Cell> = { ...state.cells }
      for (const rowId of state.rowIds) delete cells[cellKey(rowId, op.id)]
      return ok({ ...state, columns: state.columns.filter((c) => c.id !== op.id), cells })
    }
    case "addRows": {
      const existing = new Set(state.rowIds)
      if (op.rowIds.some((id) => existing.has(id))) return fail("Row already exists")
      if (new Set(op.rowIds).size !== op.rowIds.length) return fail("Duplicate row id in addRows")
      const cells: Record<string, Cell> = { ...state.cells }
      for (const [rowId, values] of Object.entries(op.values ?? {})) {
        if (!op.rowIds.includes(rowId)) continue
        for (const [colId, raw] of Object.entries(values)) {
          const column = state.columns.find((c) => c.id === colId)
          if (!column) return fail(`Unknown column ${colId}`)
          const r = coerceCellValue(column, raw)
          if (!r.ok) return fail(r.error)
          if (r.value !== null && r.value !== "") cells[cellKey(rowId, colId)] = { v: r.value, by }
        }
      }
      return ok({ ...state, rowIds: [...state.rowIds, ...op.rowIds], cells })
    }
    case "removeRows": {
      const drop = new Set(op.rowIds)
      const cells: Record<string, Cell> = { ...state.cells }
      for (const rowId of op.rowIds) for (const c of state.columns) delete cells[cellKey(rowId, c.id)]
      return ok({ ...state, rowIds: state.rowIds.filter((id) => !drop.has(id)), cells })
    }
    case "setCell": {
      const cells: Record<string, Cell> = { ...state.cells }
      const error = putCell(state, new Set(state.rowIds), cells, op, by)
      return error ? fail(error) : ok({ ...state, cells })
    }
    case "setCells": {
      const rows = new Set(state.rowIds)
      const cells: Record<string, Cell> = { ...state.cells }
      for (const w of op.cells) {
        const error = putCell(state, rows, cells, w, by)
        if (error) return fail(error)
      }
      return ok({ ...state, cells })
    }
    case "moveColumn": {
      const from = state.columns.findIndex((c) => c.id === op.id)
      const moving = state.columns[from]
      if (!moving) return fail("Unknown column")
      const columns = state.columns.filter((c) => c.id !== op.id)
      columns.splice(Math.max(0, Math.min(columns.length, op.index)), 0, moving)
      return ok({ ...state, columns })
    }
    case "renameOption": {
      const current = state.columns.find((c) => c.id === op.id)
      if (!current) return fail("Unknown column")
      if (!hasOptions(current.type)) return fail(`"${current.name}" isn't a Select column`)
      const options = current.options ?? []
      const from = op.from
      const to = op.to.trim()
      if (!options.includes(from)) return fail(`"${current.name}" has no option "${clip(from)}"`)
      if (!to) return fail("An option needs a name")
      const clash = options.find((o) => o !== from && sameName(o, to))
      if (clash) return fail(`"${current.name}" already has an option "${clash}"`)
      const { [from]: color, ...colors } = current.colors ?? {}
      const next: Column = {
        ...current,
        options: options.map((o) => (o === from ? to : o)),
        ...(current.colors && { colors: color ? { ...colors, [to]: color } : colors }),
      }
      const cells: Record<string, Cell> = { ...state.cells }
      for (const rowId of state.rowIds) {
        const key = cellKey(rowId, op.id)
        const cell = cells[key]
        if (!cell || !settled(cell.status)) continue
        if (cell.v === from) cells[key] = { ...cell, v: to }
        else if (isTags(cell.v) && cell.v.includes(from)) cells[key] = { ...cell, v: cell.v.map((t) => (t === from ? to : t)) }
      }
      return ok({ ...state, columns: state.columns.map((c) => (c.id === op.id ? next : c)), cells })
    }
  }
}

const ok = (state: TableState): ApplyResult => ({ ok: true, state })
const fail = (error: string): ApplyResult => ({ ok: false, error })

/**
 * Compact, model-friendly view of a table for agents (MCP `read`):
 * a header line, then one line per row with only non-empty cells.
 */
export function tableToText(state: TableState, limit = 200): string {
  const lines = [
    // Options are listed so agents know which values a (multi-)select accepts.
    `columns: ${state.columns.map((c) => `${c.id}="${c.name}"(${c.type}${hasOptions(c.type) ? `: ${(c.options ?? []).join("|")}` : ""})`).join(", ") || "(none)"}`,
    `rows: ${state.rowIds.length}${state.rowIds.length > limit ? ` (showing first ${limit})` : ""}`,
  ]
  for (const rowId of state.rowIds.slice(0, limit)) {
    const parts = state.columns.flatMap((c) => {
      const cell = state.cells[cellKey(rowId, c.id)]
      return cell && cell.v !== null && cell.v !== "" ? [`${c.id}=${JSON.stringify(cell.v)}`] : []
    })
    lines.push(`${rowId}: ${parts.join(" ") || "(empty)"}`)
  }
  return lines.join("\n")
}

export function newId(prefix: string) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
  return `${prefix}${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % 36]).join("")}`
}
