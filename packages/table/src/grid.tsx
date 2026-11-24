import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CheckSquareIcon,
  EyeSlashIcon,
  FunnelIcon,
  PlusIcon,
  SquareIcon,
  RobotIcon,
  TableIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react"
import {
  cellKey,
  cellLabel,
  cellText,
  columnTypes,
  hasOptions,
  isTags,
  refsOf,
  sameValue,
  type Cell,
  type CellValue,
  type Column,
  type ColumnType,
  type Member,
  type TableState,
} from "@standard-artifacts/protocol"
import { AgentMark, AgentPending, HeaderProgress, ProgressBar, SourcesButton, byAgent, runProgress, type RunProgress } from "./agent"
import { parseClipboard, toTSV } from "./clipboard"
import { AddColumnButton, typeIcons, type ColumnDraft } from "./column-picker"
import { GridFooter } from "./footer"
import { RefChips, RefPicker, type TableLinks } from "./links"
import { displayValue, freeColumnName, getCell, misfit, nextColumnName, parseInput, presenceByCell, presenceRanges, type TableActions } from "./model"
import { PresenceTag } from "./presence"
import { RecordPanel } from "./record-panel"
import { MAX_OPTION, MAX_OPTIONS, OptionsEditor, Tag, TagPicker, addOptionPatch } from "./tags"
import type { SortRule } from "./view"

type Pos = { rowId: string; colId: string }
/** A rectangle of cells, as inclusive indexes into the rows and columns this viewer sees. */
type Rect = { top: number; bottom: number; left: number; right: number }

/** Others see at most this many rows of my selection (presence is broadcast on every change). */
const PRESENCE_RANGE_ROWS = 200
const DEFAULT_WIDTH = 180
const MIN_WIDTH = 60
const MAX_WIDTH = 800

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** A select cell's value as a list of tags, whatever shape it's stored in. */
const tagsOf = (v: CellValue | undefined): ReadonlyArray<string> => (isTags(v) ? v : typeof v === "string" && v ? [v] : [])

/** Cells edited through a picker that saves as you go, not a text box. Artifact cells need the host's picker, or edit as ids. */
const usesPicker = (column: Column, links: TableLinks | undefined) => hasOptions(column.type) || (column.type === "artifact" && !!links)

export function GridView({
  state,
  rows: rowIds,
  columns,
  others,
  actions,
  readOnly,
  onError,
  search = "",
  sort = null,
  filtered = [],
  jump = null,
  openRow,
  links,
  onKeep,
  onSort,
  onHide,
}: {
  state: TableState
  /** The rows this viewer sees, in order (after their sort and filters). */
  rows: ReadonlyArray<string>
  /** The columns this viewer sees (hidden ones left out). */
  columns: ReadonlyArray<Column>
  others: ReadonlyArray<Member>
  actions: TableActions
  readOnly: boolean
  onError: (message: string) => void
  search?: string
  sort?: SortRule | null
  /** Columns with an active filter, marked in their header. */
  filtered?: ReadonlyArray<string>
  /** Select this cell (search results); a new object each time, so the same cell can be jumped to twice. */
  jump?: Pos | null
  /** A row to open in the record panel once it exists (a link to one row). */
  openRow?: string | undefined
  /** Chips, titles and a picker for Artifact cells. */
  links?: TableLinks | undefined
  /** Keep a row visible under filters even if it stops matching (rows I add or work in). */
  onKeep?: (rowId: string) => void
  onSort?: (colId: string, dir: SortRule["dir"]) => void
  onHide?: (colId: string) => void
}) {
  const [sel, setSel] = useState<Pos | null>(null)
  /** The other corner of a multi-cell selection; null means just `sel`. */
  const [anchor, setAnchor] = useState<Pos | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  /** Why the draft can't be saved; the editor stays open until it's fixed or cancelled. */
  const [editError, setEditError] = useState<string | null>(null)
  const [record, setRecord] = useState<{ rowId: string; colId?: string } | null>(null)
  const openedRow = useRef<string | null>(null)
  useEffect(() => {
    if (!openRow || openedRow.current === openRow || !state.rowIds.includes(openRow)) return
    openedRow.current = openRow
    setRecord({ rowId: openRow })
  }, [openRow, state.rowIds])
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  /** Live widths while a column edge is being dragged; saved to the column on release. */
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({})
  /** A header being dragged to a new place, and the gap (0..columns.length) it would drop into. */
  const [colDrag, setColDrag] = useState<{ id: string; slot: number } | null>(null)
  /** A column just added from the "+" picker: its header opens for naming (or its prompt) once it mounts. */
  const [added, setAdded] = useState<{ id: string; intro: HeaderIntro } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  /** Whether keyboard focus belongs to the grid (or its editor/panel), so we can win it back. */
  const hasFocus = useRef(false)
  /** Where the selection was, so it can land on a neighbour if its row or column is deleted. */
  const lastIndex = useRef({ row: 0, col: 0 })
  /** Where a mouse drag-select started, while the button is down. */
  const dragFrom = useRef<Pos | null>(null)
  /** Last row whose checkbox was clicked, for shift-click ranges. */
  const lastChecked = useRef<string | null>(null)
  const presence = useMemo(() => presenceByCell(others), [others])
  const tints = useMemo(() => presenceRanges(others), [others])
  const rowIndex = useMemo(() => new Map(rowIds.map((r, i) => [r, i])), [rowIds])
  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c.id, i])), [columns])
  const allRows = useMemo(() => new Set(state.rowIds), [state.rowIds])
  /** How far each agent column's run has got, over the rows this viewer sees. */
  const progress = useMemo(
    () => new Map(columns.filter((c) => c.type === "agent").map((c) => [c.id, runProgress(state, rowIds, c.id)])),
    [state, rowIds, columns],
  )
  // The new header has mounted (and read its intro), so a later remount (unhide) doesn't reopen it.
  useEffect(() => {
    if (added && colIndex.has(added.id)) setAdded(null)
  }, [added, colIndex])

  const rect = useMemo((): Rect | null => {
    if (!sel) return null
    const r = rowIndex.get(sel.rowId)
    const c = colIndex.get(sel.colId)
    if (r === undefined || c === undefined) return null
    const ar = anchor ? rowIndex.get(anchor.rowId) : undefined
    const ac = anchor ? colIndex.get(anchor.colId) : undefined
    if (ar === undefined || ac === undefined) return { top: r, bottom: r, left: c, right: c }
    return { top: Math.min(r, ar), bottom: Math.max(r, ar), left: Math.min(c, ac), right: Math.max(c, ac) }
  }, [sel, anchor, rowIndex, colIndex])
  const multi = !!rect && (rect.top !== rect.bottom || rect.left !== rect.right)

  // Checked rows that still exist and are on screen; bulk actions only touch what you can see.
  const selectedRows = useMemo(() => rowIds.filter((r) => checked.has(r)), [rowIds, checked])

  // Tell everyone where we are, including the range (as ids: others may sort differently).
  const range =
    rect && multi
      ? {
          rowIds: rowIds.slice(rect.top, Math.min(rect.bottom, rect.top + PRESENCE_RANGE_ROWS - 1) + 1),
          colIds: columns.slice(rect.left, rect.right + 1).map((c) => c.id),
        }
      : null
  const rangeKey = JSON.stringify(range)
  useEffect(() => {
    actions.focus({ selection: sel, editing, range })
    // `range` is rebuilt every render; rangeKey is its identity, so presence is only sent when it changes.
  }, [actions, sel, editing, rangeKey])

  // If the selected row or column disappears (someone deleted it, or this
  // viewer's filter or hidden fields now exclude it), move to its neighbour so
  // the keyboard keeps working, and say so if an edit was lost to a delete.
  useEffect(() => {
    if (!sel) return
    const row = rowIndex.get(sel.rowId) ?? -1
    const col = colIndex.get(sel.colId) ?? -1
    if (row >= 0 && col >= 0) {
      lastIndex.current = { row, col }
      return
    }
    if (editing) {
      const gone = !allRows.has(sel.rowId) ? "row" : !state.columns.some((c) => c.id === sel.colId) ? "column" : null
      if (gone) onError(`Someone deleted the ${gone} you were editing, so your change wasn't saved.`)
      setEditing(false)
      setEditError(null)
    }
    const nextRow = rowIds[row >= 0 ? row : Math.min(lastIndex.current.row, rowIds.length - 1)]
    const nextCol = columns[col >= 0 ? col : Math.min(lastIndex.current.col, columns.length - 1)]
    setAnchor(null)
    setSel(nextRow && nextCol ? { rowId: nextRow, colId: nextCol.id } : null)
  }, [sel, editing, rowIds, columns, rowIndex, colIndex, allRows, state.columns, onError])

  // Same for the record panel: close it and say why, rather than vanishing.
  useEffect(() => {
    if (record && !allRows.has(record.rowId)) {
      setRecord(null)
      onError("The row you had open was deleted by someone else.")
    }
  }, [record, allRows, onError])

  // The row you're in stays visible even if an edit makes it stop matching a filter.
  useEffect(() => {
    if (sel) onKeep?.(sel.rowId)
  }, [sel?.rowId, onKeep])

  // Search results and keyboard moves can land off screen.
  useEffect(() => {
    if (!sel) return
    gridRef.current
      ?.querySelector(`[data-cell="${CSS.escape(cellKey(sel.rowId, sel.colId))}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [sel?.rowId, sel?.colId])

  useEffect(() => {
    if (!jump) return
    setAnchor(null)
    setSel({ rowId: jump.rowId, colId: jump.colId })
  }, [jump])

  // When an editor (or the cell it was in) unmounts, the browser parks focus on
  // <body> and arrow keys stop working. Take it back if it was ours.
  useEffect(() => {
    if (hasFocus.current && document.activeElement === document.body) gridRef.current?.focus()
  })

  // A mouse drag-select ends wherever the button comes up.
  useEffect(() => {
    const up = () => {
      dragFrom.current = null
    }
    window.addEventListener("mouseup", up)
    return () => window.removeEventListener("mouseup", up)
  }, [])

  const column = (id: string) => columns.find((c) => c.id === id)
  const at = (row: number, col: number): Pos | null => {
    const rowId = rowIds[Math.max(0, Math.min(rowIds.length - 1, row))]
    const colId = columns[Math.max(0, Math.min(columns.length - 1, col))]?.id
    return rowId && colId ? { rowId, colId } : null
  }

  /** Move the cursor; with `extend`, grow the selection from its anchor instead. */
  const go = (pos: Pos | null, extend = false) => {
    if (!pos) return
    setAnchor(extend ? (anchor ?? sel) : null)
    setSel(pos)
  }

  const move = (dRow: number, dCol: number, extend = false) => {
    // Nothing selected yet: the first arrow press lands on the first cell.
    if (!sel) return go(at(0, 0))
    go(at((rowIndex.get(sel.rowId) ?? 0) + dRow, (colIndex.get(sel.colId) ?? 0) + dCol), extend)
  }

  const startEdit = (initial?: string) => {
    if (!sel || readOnly) return
    const col = column(sel.colId)
    if (!col) return
    setAnchor(null)
    if (col.type === "checkbox") {
      const current = getCell(state, sel.rowId, sel.colId)?.v === true
      actions.setCell(sel.rowId, sel.colId, !current)
      return
    }
    // A picker opens with an empty search (or what you started typing), not the current value.
    setDraft(initial ?? (usesPicker(col, links) ? "" : displayValue(getCell(state, sel.rowId, sel.colId)?.v)))
    setEditError(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditError(null)
  }

  /** Save the draft. Returns false (and keeps the editor open, draft intact) if it doesn't fit the column. */
  const commit = (): boolean => {
    if (!sel || !editing) return true
    const col = column(sel.colId)
    const before = getCell(state, sel.rowId, sel.colId)?.v ?? null
    // Pickers save on change, and an untouched draft has nothing to save (even if the stored value
    // doesn't fit the column), so neither should trap the editor open.
    if (!col || usesPicker(col, links) || draft === displayValue(before)) {
      cancelEdit()
      return true
    }
    const parsed = parseInput(col, draft)
    if (!parsed.ok) {
      // Shown right under the cell (role="alert"), not in the banner, so it goes away once fixed.
      setEditError(parsed.error)
      return false
    }
    cancelEdit()
    if (!sameValue(parsed.value, before)) actions.setCell(sel.rowId, sel.colId, parsed.value)
    return true
  }

  /** Add an option from the picker, with the column menu's limits. */
  const createOption = (col: Column, option: string) => {
    const options = col.options ?? []
    const problem =
      option.length > MAX_OPTION
        ? `Options can be up to ${MAX_OPTION} characters.`
        : options.length >= MAX_OPTIONS
          ? `A select can have up to ${MAX_OPTIONS} options.`
          : null
    if (problem) onError(problem)
    return !problem && actions.updateColumn(col.id, addOptionPatch(col, option))
  }

  const cellsIn = (r: Rect) =>
    rowIds.slice(r.top, r.bottom + 1).flatMap((rowId) => columns.slice(r.left, r.right + 1).map((c) => ({ rowId, col: c })))

  const clearRange = () => {
    if (readOnly || !rect) return
    const writes = cellsIn(rect)
      .filter(({ rowId, col }) => getCell(state, rowId, col.id))
      .map(({ rowId, col }) => ({ rowId, colId: col.id, value: null }))
    if (writes.length) actions.setCells(writes)
  }

  const copyText = () => {
    if (!rect) return null
    const lines = rowIds
      .slice(rect.top, rect.bottom + 1)
      .map((rowId) => columns.slice(rect.left, rect.right + 1).map((c) => cellText(getCell(state, rowId, c.id)?.v)))
    return toTSV(lines)
  }

  /**
   * Paste a block of cells at the selection's top-left corner, like a
   * spreadsheet: one value fills the whole selection, rows past the end are
   * added, each value is fitted to its column, and what doesn't fit is skipped
   * and reported rather than failing the whole paste.
   */
  const paste = (text: string) => {
    if (readOnly) return onError("You can view this table but not edit it.")
    if (!rect || text === "") return
    const data = parseClipboard(text)
    const fill = multi && data.length === 1 && data[0]?.length === 1
    const height = fill ? rect.bottom - rect.top + 1 : data.length
    const width = fill ? rect.right - rect.left + 1 : Math.max(...data.map((r) => r.length))
    const writes: Array<{ rowId: string; colId: string; value: CellValue }> = []
    const added: Array<Record<string, CellValue>> = []
    /** Skipped values per column, with the first reason, so the report says where to look. */
    const misfits = new Map<string, { count: number; example: string }>()
    let skipped = 0
    let pasted = 0
    for (let i = 0; i < height; i++) {
      const rowId = rowIds[rect.top + i]
      const values: Record<string, CellValue> = {}
      for (let j = 0; j < width; j++) {
        const col = columns[rect.left + j]
        if (!col) break
        const raw = (fill ? data[0]?.[0] : data[i]?.[j]) ?? ""
        const parsed = parseInput(col, raw)
        if (!parsed.ok) {
          skipped++
          const m = misfits.get(col.name)
          if (m) m.count++
          else misfits.set(col.name, { count: 1, example: `row ${rect.top + i + 1}: ${parsed.error}` })
          continue
        }
        pasted++
        if (!rowId) {
          if (parsed.value !== null) values[col.id] = parsed.value
        } else if (!sameValue(parsed.value, getCell(state, rowId, col.id)?.v ?? null)) {
          writes.push({ rowId, colId: col.id, value: parsed.value })
        }
      }
      if (!rowId) added.push(values)
    }
    if (writes.length) actions.setCells(writes)
    const newRows = added.length ? actions.addRows(added) : []
    for (const r of newRows) onKeep?.(r)
    // Select what was pasted, so it's easy to see (and to clear again).
    const lastRow = rowIds[rect.top + height - 1] ?? newRows[newRows.length - 1]
    const lastCol = columns[Math.min(columns.length - 1, rect.left + width - 1)]
    const first = at(rect.top, rect.left)
    if (first && lastRow && lastCol) {
      setAnchor(first)
      setSel({ rowId: lastRow, colId: lastCol.id })
    }
    const notes: Array<string> = []
    if (skipped) {
      const where = [...misfits].map(([name, m]) => `${name} (${m.count})`).join(", ")
      const example = misfits.values().next().value?.example
      notes.push(`Skipped ${plural(skipped, "cell")} that didn't fit: ${where}. For example, ${example}.`)
    }
    const extraCols = rect.left + width - columns.length
    if (extraCols > 0) notes.push(`${plural(extraCols, "column")} past the last one ${extraCols > 1 ? "were" : "was"} left out.`)
    if (notes.length) onError(`Pasted ${pasted} of ${pasted + skipped} cells. ${notes.join(" ")}`)
  }

  // Clipboard events go to the focused element's document; handle them while the grid itself has focus
  // (an open editor gets the browser's own text copy and paste). A ref keeps the listeners current.
  const clip = useRef({ copyText, paste, clearRange })
  clip.current = { copyText, paste, clearRange }
  /** Set by Cmd/Ctrl+C/X/V; cleared if a real clipboard event follows. Browsers that skip it get the async API. */
  const pendingClip = useRef<"copy" | "cut" | "paste" | null>(null)
  useEffect(() => {
    const ours = () => !!gridRef.current && document.activeElement === gridRef.current
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (!ours()) return
      pendingClip.current = null
      const text = clip.current.copyText()
      if (text === null || !e.clipboardData) return
      e.preventDefault()
      e.clipboardData.setData("text/plain", text)
      if (cut) clip.current.clearRange()
    }
    const copy = (e: ClipboardEvent) => onCopy(e, false)
    const cut = (e: ClipboardEvent) => onCopy(e, true)
    const pasteEvent = (e: ClipboardEvent) => {
      if (!ours()) return
      pendingClip.current = null
      e.preventDefault()
      clip.current.paste(e.clipboardData?.getData("text/plain") ?? "")
    }
    document.addEventListener("copy", copy)
    document.addEventListener("cut", cut)
    document.addEventListener("paste", pasteEvent)
    return () => {
      document.removeEventListener("copy", copy)
      document.removeEventListener("cut", cut)
      document.removeEventListener("paste", pasteEvent)
    }
  }, [])

  const clipboardFallback = (kind: "copy" | "cut" | "paste") => {
    pendingClip.current = kind
    // The browser fires copy/paste right after keydown if it's going to; give it that tick.
    setTimeout(() => {
      if (pendingClip.current !== kind) return
      pendingClip.current = null
      if (kind === "paste") {
        navigator.clipboard.readText().then(paste, () => onError("Your browser blocked reading the clipboard. Use the Edit menu's Paste."))
        return
      }
      const text = copyText()
      if (text === null) return
      navigator.clipboard.writeText(text).then(
        () => kind === "cut" && clearRange(),
        () => onError("Your browser blocked writing to the clipboard."),
      )
    })
  }

  const toggleRow = (rowId: string, shift: boolean) => {
    const on = !checked.has(rowId)
    const next = new Set(checked)
    const from = lastChecked.current ? rowIndex.get(lastChecked.current) : undefined
    const to = rowIndex.get(rowId)
    if (shift && from !== undefined && to !== undefined) {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        const r = rowIds[i]
        if (r) on ? next.add(r) : next.delete(r)
      }
    } else if (on) next.add(rowId)
    else next.delete(rowId)
    lastChecked.current = rowId
    setChecked(next)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && record) return setRecord(null)
    // Keys typed into the editor or picker are theirs; keys on a checkbox or button inside the grid are too.
    if (!editing && e.target !== e.currentTarget) return
    const mod = e.metaKey || e.ctrlKey
    if (!sel) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(e.key)) {
        e.preventDefault()
        move(0, 0)
      } else if (e.key === "Escape" && checked.size) setChecked(new Set())
      return
    }
    if (editing) {
      if (e.key === "Enter") {
        e.preventDefault()
        if (commit()) move(1, 0)
      } else if (e.key === "Tab") {
        e.preventDefault()
        if (commit()) move(0, e.shiftKey ? -1 : 1)
      } else if (e.key === "Escape") {
        cancelEdit()
      }
      return
    }
    if (mod && !e.altKey && ["c", "x", "v"].includes(e.key.toLowerCase())) {
      const kind = e.key.toLowerCase() === "c" ? "copy" : e.key.toLowerCase() === "x" ? "cut" : "paste"
      return clipboardFallback(kind)
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault()
      setAnchor(at(0, 0))
      setSel(at(rowIds.length - 1, columns.length - 1))
      return
    }
    const nav: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    const step = nav[e.key]
    if (step) {
      e.preventDefault()
      // Cmd/Ctrl+arrow jumps to the edge, like a spreadsheet.
      const far = Math.max(rowIds.length, columns.length)
      return move(step[0] * (mod ? far : 1), step[1] * (mod ? far : 1), e.shiftKey)
    }
    if (e.key === "Tab") {
      e.preventDefault()
      return move(0, e.shiftKey ? -1 : 1)
    }
    if (e.key === "Enter" || e.key === "F2" || (e.key === " " && column(sel.colId)?.type === "checkbox" && !multi)) {
      e.preventDefault()
      return startEdit()
    }
    // Space opens the whole record (like Airtable), for reading long values and sources.
    if (e.key === " ") {
      e.preventDefault()
      return setRecord({ rowId: sel.rowId, colId: sel.colId })
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !readOnly) {
      e.preventDefault()
      return clearRange()
    }
    if (e.key === "Escape") {
      if (multi) return setAnchor(null)
      if (checked.size) return setChecked(new Set())
      return setSel(null)
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      if (column(sel.colId)?.type !== "checkbox") {
        e.preventDefault()
        startEdit(e.key)
      }
    }
  }

  // --- Columns: resize and reorder -------------------------------------------------

  const width = (c: Column) => widths[c.id] ?? c.width ?? DEFAULT_WIDTH
  const gutter = readOnly ? 44 : 64
  const template = `${gutter}px ${columns.map((c) => `${width(c)}px`).join(" ")} ${readOnly ? "" : "44px"}`

  const startResize = (col: Column, e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const start = width(col)
    let current = start
    const onMove = (ev: PointerEvent) => {
      current = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, start + ev.clientX - startX)))
      setWidths((w) => ({ ...w, [col.id]: current }))
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      if (current !== (col.width ?? DEFAULT_WIDTH)) actions.updateColumn(col.id, { width: current })
      setWidths(({ [col.id]: _, ...rest }) => rest)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  /** Double-click a column's edge: fit it to its longest value (or header). */
  const autoFit = (col: Column) => {
    const ctx = document.createElement("canvas").getContext("2d")
    if (!ctx) return
    ctx.font = "13px Inter Variable, ui-sans-serif, system-ui, sans-serif"
    let widest = ctx.measureText(col.name).width + 56
    for (const rowId of state.rowIds) {
      const text = cellLabel(col, getCell(state, rowId, col.id)?.v, links?.titleOf)
      if (text) widest = Math.max(widest, ctx.measureText(text.slice(0, 200)).width + (usesPicker(col, links) ? 40 : 28))
    }
    const next = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, widest)))
    if (next !== col.width) actions.updateColumn(col.id, { width: next })
  }

  /** Where in the full column list a visible column dropped into `slot` lands (hidden columns keep their places). */
  const dropIndex = (id: string, slot: number) => {
    const rest = state.columns.filter((c) => c.id !== id)
    const visible = columns.filter((c) => c.id !== id)
    const from = colIndex.get(id) ?? 0
    const before = visible[slot > from ? slot - 1 : slot]
    if (before) return rest.findIndex((c) => c.id === before.id)
    const last = visible[visible.length - 1]
    return last ? rest.findIndex((c) => c.id === last.id) + 1 : rest.length
  }

  const addColumn = (draft: ColumnDraft) => {
    const name = draft.name ? freeColumnName(state.columns, draft.name) : nextColumnName(state.columns)
    const id = actions.addColumn({ ...draft, name })
    // Agent columns open on their prompt and selects on their options; anything else on its name.
    setAdded({ id, intro: draft.type === "agent" || hasOptions(draft.type) ? "menu" : "rename" })
  }

  const moveColumnTo = (id: string, index: number) => {
    if (index !== state.columns.findIndex((c) => c.id === id)) actions.moveColumn(id, index)
  }

  const startColumnDrag = (col: Column, e: ReactPointerEvent) => {
    if (readOnly || e.button !== 0) return
    const startX = e.clientX
    let slot: number | null = null
    const onMove = (ev: PointerEvent) => {
      if (slot === null && Math.abs(ev.clientX - startX) < 5) return
      const heads = [...(headerRef.current?.querySelectorAll<HTMLElement>("[data-col]") ?? [])]
      slot = heads.filter((h) => {
        const r = h.getBoundingClientRect()
        return r.left + r.width / 2 < ev.clientX
      }).length
      setColDrag({ id: col.id, slot })
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      if (slot !== null) moveColumnTo(col.id, dropIndex(col.id, slot))
      setColDrag(null)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  // Rows call back through a ref, so their props stay equal (and memo holds) while these closures change.
  const handlers = useRef<RowHandlers | null>(null)
  handlers.current = {
    cellMouseDown: (e, pos, active) => {
      if (e.button !== 0) return
      if (active && editing) return
      // A draft that doesn't fit its column stays open (and focused) instead of being thrown away.
      if (editing && !commit()) return e.preventDefault()
      if (e.shiftKey && sel) {
        setAnchor(anchor ?? sel)
        setSel(pos)
      } else {
        setAnchor(null)
        setSel(pos)
        dragFrom.current = pos
      }
      gridRef.current?.focus()
    },
    cellMouseEnter: (pos) => {
      const from = dragFrom.current
      if (!from) return
      setAnchor(from)
      setSel(pos)
    },
    startEdit: () => startEdit(),
    openRecord: (rowId, colId) => setRecord(colId ? { rowId, colId } : { rowId }),
    toggleRow,
    setDraft: (v) => {
      setDraft(v)
      setEditError(null)
    },
    commit,
    pick: (rowId, col, next) => {
      const before = getCell(state, rowId, col.id)?.v ?? null
      const v: CellValue = col.type === "multiSelect" || col.type === "artifact" ? (next.length ? next : null) : (next[0] ?? null)
      if (!sameValue(v, before)) actions.setCell(rowId, col.id, v)
    },
    createOption,
    closePicker: () => {
      // Closed from the keyboard: keep driving the grid. Closed by clicking elsewhere: leave focus there.
      const ours = wrapRef.current?.contains(document.activeElement)
      cancelEdit()
      if (ours) gridRef.current?.focus()
    },
  }

  const openRecord = record && allRows.has(record.rowId) ? record : null
  const allChecked = rowIds.length > 0 && selectedRows.length === rowIds.length
  const showChecks = selectedRows.length > 0

  return (
    <div
      ref={wrapRef}
      className="relative h-full"
      onFocus={() => {
        hasFocus.current = true
      }}
      onBlur={(e) => {
        hasFocus.current = !!e.relatedTarget && !!wrapRef.current?.contains(e.relatedTarget)
      }}
    >
    <div
      ref={gridRef}
      role="grid"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-multiselectable
      className="relative h-full overflow-auto outline-none select-none"
      aria-readonly={readOnly}
    >
      <div className="flex min-h-full min-w-max flex-col">
        {/* Header */}
        <div ref={headerRef} role="row" className="group/head sticky top-0 z-30 grid border-b border-border bg-surface" style={{ gridTemplateColumns: template }}>
          <div className="flex items-center justify-start border-r border-border pl-2.5">
            {!readOnly && rowIds.length > 0 && (
              <input
                type="checkbox"
                aria-label="Select all rows"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = showChecks && !allChecked
                }}
                onChange={() => setChecked(allChecked ? new Set() : new Set(rowIds))}
                className={`size-3.5 accent-accent ${showChecks ? "" : "invisible group-hover/head:visible focus-visible:visible"}`}
              />
            )}
          </div>
          {columns.map((c, i) => (
            <HeaderCell
              key={c.id}
              column={c}
              hasValues={state.rowIds.some((r) => getCell(state, r, c.id) !== undefined)}
              actions={actions}
              readOnly={readOnly}
              canDelete={state.columns.length > 1}
              canHide={columns.length > 1}
              sorted={sort?.colId === c.id ? sort.dir : null}
              filtered={filtered.includes(c.id)}
              dragging={colDrag?.id === c.id}
              dropBefore={colDrag?.slot === i}
              dropAfter={colDrag?.slot === columns.length && i === columns.length - 1}
              onError={onError}
              onSort={(dir) => onSort?.(c.id, dir)}
              onHide={() => onHide?.(c.id)}
              onMove={(d) => {
                const target = columns[i + d]
                if (target) moveColumnTo(c.id, state.columns.findIndex((x) => x.id === target.id))
              }}
              onDragStart={(e) => startColumnDrag(c, e)}
              onResizeStart={(e) => startResize(c, e)}
              onAutoFit={() => autoFit(c)}
              progress={progress.get(c.id)}
              narrow={width(c) < PROGRESS_MIN_WIDTH}
              intro={added?.id === c.id ? added.intro : null}
            />
          ))}
          {!readOnly && <AddColumnButton onAdd={addColumn} />}
        </div>

        {columns.length === 0 && (
          <p className="border-b border-border px-3 py-2 text-[13px] text-muted">
            This table has no columns{readOnly ? "." : ". Add one with the + button above."}
          </p>
        )}
        {rowIds.length === 0 && state.rowIds.length > 0 && (
          <p className="border-b border-border px-3 py-2 text-[13px] text-muted">No rows match your filters.</p>
        )}
        {state.rowIds.length === 0 && columns.length > 0 && (
          <div className="sticky left-0 flex max-w-xl flex-col items-start gap-1 px-4 py-6 text-[13px]">
            <span className="flex items-center gap-2 font-medium text-text">
              <TableIcon size={16} className="text-faint" /> No rows yet
            </span>
            <span className="text-muted">
              {readOnly
                ? "Rows people and agents add will show up here."
                : "Add a row below, paste from a spreadsheet, or ask an agent: type @claude in a cell."}
            </span>
          </div>
        )}

        {/* Rows: memoized, so moving the cursor re-renders the rows it touches, not every row. */}
        {rowIds.map((rowId, i) => {
          const isActive = sel?.rowId === rowId
          const inRange = !!rect && i >= rect.top && i <= rect.bottom
          return (
            <GridRow
              key={rowId}
              rowId={rowId}
              index={i}
              state={state}
              columns={columns}
              template={template}
              readOnly={readOnly}
              checked={checked.has(rowId)}
              showChecks={showChecks}
              activeCol={isActive ? (sel?.colId ?? null) : null}
              editing={isActive && editing}
              draft={isActive ? draft : ""}
              editError={isActive ? editError : null}
              multi={inRange && multi}
              rangeLeft={inRange && rect ? rect.left : -1}
              rangeRight={inRange && rect ? rect.right : -1}
              rangeTop={inRange && rect?.top === i}
              rangeBottom={inRange && rect?.bottom === i}
              presence={presence}
              tints={tints}
              search={search}
              links={links}
              handlers={handlers}
            />
          )
        })}

        {!readOnly && (
          <button
            type="button"
            onClick={() => {
              const rowId = actions.addRow()
              onKeep?.(rowId)
              const colId = columns[0]?.id
              if (colId) go({ rowId, colId })
              gridRef.current?.focus()
            }}
            className="flex h-9 w-full items-center gap-2 border-b border-border px-3 text-left text-[13px] text-muted hover:bg-surface hover:text-text"
          >
            <PlusIcon size={13} weight="bold" /> New row
          </button>
        )}
        {/* Room under the last row (and for the bulk bar), then the summary pinned to the bottom. */}
        <div className="min-h-16 flex-1" />
        {columns.length > 0 && <GridFooter state={state} rows={rowIds} columns={columns} template={template} />}
      </div>
    </div>
    {!readOnly && selectedRows.length > 0 && (
      <BulkBar
        key={selectedRows.length}
        rows={selectedRows}
        columns={state.columns}
        state={state}
        actions={actions}
        onError={onError}
        onDone={() => {
          setChecked(new Set())
          gridRef.current?.focus()
        }}
      />
    )}
    {openRecord && (
      <RecordPanel
        state={state}
        rowId={openRecord.rowId}
        focusColumn={openRecord.colId}
        links={links}
        actions={actions}
        readOnly={readOnly}
        onError={onError}
        onClose={() => {
          setRecord(null)
          gridRef.current?.focus()
        }}
      />
    )}
    </div>
  )
}

type RowHandlers = {
  cellMouseDown: (e: ReactMouseEvent, pos: Pos, active: boolean) => void
  cellMouseEnter: (pos: Pos) => void
  startEdit: () => void
  openRecord: (rowId: string, colId?: string) => void
  toggleRow: (rowId: string, shift: boolean) => void
  setDraft: (v: string) => void
  commit: () => boolean
  pick: (rowId: string, col: Column, next: ReadonlyArray<string>) => void
  createOption: (col: Column, option: string) => boolean
  closePicker: () => void
}

/**
 * One grid row. Selection arrives as plain values (the active column, the
 * range's columns), so a row outside the cursor's path keeps equal props and
 * skips rendering; that's what keeps 500-row tables quick to navigate.
 */
const GridRow = memo(function GridRow({
  rowId,
  index: i,
  state,
  columns,
  template,
  readOnly,
  checked,
  showChecks,
  activeCol,
  editing,
  draft,
  editError,
  multi,
  rangeLeft,
  rangeRight,
  rangeTop,
  rangeBottom,
  presence,
  tints,
  search,
  links,
  handlers,
}: {
  rowId: string
  index: number
  state: TableState
  columns: ReadonlyArray<Column>
  template: string
  readOnly: boolean
  checked: boolean
  showChecks: boolean
  activeCol: string | null
  editing: boolean
  draft: string
  editError: string | null
  multi: boolean
  rangeLeft: number
  rangeRight: number
  rangeTop: boolean
  rangeBottom: boolean
  presence: ReadonlyMap<string, ReadonlyArray<Member>>
  tints: ReadonlyMap<string, string>
  search: string
  links: TableLinks | undefined
  handlers: RefObject<RowHandlers | null>
}) {
  const h = () => handlers.current
  // A row with nothing in it yet gets a hint on hover instead of reading as a rendering glitch.
  const blank = state.columns.every((c) => !getCell(state, rowId, c.id))
  return (
    <div role="row" aria-selected={checked || undefined} className={`group grid border-b border-border ${checked ? "bg-accent/6" : ""}`} style={{ gridTemplateColumns: template }}>
      <div className="relative flex h-9 items-center border-r border-border text-[12px] text-faint tabular-nums">
        {!readOnly && (
          <input
            type="checkbox"
            aria-label={`Select row ${i + 1}`}
            checked={checked}
            onChange={(e) => h()?.toggleRow(rowId, e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey)}
            className={`ml-2.5 size-3.5 shrink-0 accent-accent ${showChecks ? "" : "invisible group-hover:visible focus-visible:visible"}`}
          />
        )}
        <span className={`flex-1 text-center group-hover:invisible ${readOnly ? "" : "pr-1"}`}>{i + 1}</span>
        <button
          type="button"
          aria-label={`Open row ${i + 1}`}
          title="Open row (Space)"
          onClick={() => h()?.openRecord(rowId)}
          className={`absolute inset-y-0 m-auto hidden size-6 place-items-center rounded text-muted group-hover:grid hover:bg-hover hover:text-text ${readOnly ? "inset-x-0" : "right-1.5"}`}
        >
          <ArrowsOutSimpleIcon size={13} />
        </button>
      </div>
      {columns.map((c, j) => {
        const key = cellKey(rowId, c.id)
        const active = activeCol === c.id
        const inRange = j >= rangeLeft && j <= rangeRight
        const here = presence.get(key) ?? []
        const ring = here[0]?.color
        const tint = tints.get(key)
        const cell = getCell(state, rowId, c.id)
        const style: CSSProperties = {}
        if (multi && inRange) {
          // Outline the range's outer edge only, so it reads as one block.
          const edges = [
            rangeTop && "inset 0 2px 0 0 var(--accent)",
            rangeBottom && "inset 0 -2px 0 0 var(--accent)",
            j === rangeLeft && "inset 2px 0 0 0 var(--accent)",
            j === rangeRight && "inset -2px 0 0 0 var(--accent)",
          ].filter(Boolean)
          if (edges.length) style.boxShadow = edges.join(", ")
        } else if (ring && !active) {
          style.boxShadow = `inset 0 0 0 2px ${ring}`
        }
        if (tint && !inRange) style.background = `color-mix(in oklab, ${tint} 14%, transparent)`
        const pos = { rowId, colId: c.id }
        return (
          <div
            key={c.id}
            role="gridcell"
            data-cell={key}
            aria-selected={inRange}
            onMouseDown={(e) => h()?.cellMouseDown(e, pos, active)}
            onMouseEnter={() => h()?.cellMouseEnter(pos)}
            onDoubleClick={() => h()?.startEdit()}
            className={`relative h-9 scroll-mt-9 border-r border-border ${active ? `${editing ? "z-40" : "z-10"} outline-2 -outline-offset-2 outline-accent` : ""} ${multi && inRange && !active ? "bg-accent/8" : ""}`}
            style={style}
          >
            {here.length > 0 && <PresenceTag members={here} />}
            {active && editing && !usesPicker(c, links) ? (
              <CellEditor column={c} draft={draft} error={editError} setDraft={(v) => h()?.setDraft(v)} onCommit={() => h()?.commit()} />
            ) : (
              <CellDisplay
                column={c}
                cell={cell}
                query={search}
                seed={key}
                links={links}
                selected={active}
                placeholder={j === 0 && blank && c.type !== "checkbox" ? "Empty row" : c.type === "agent" ? "Not run yet" : null}
                onOpen={() => h()?.openRecord(rowId, c.id)}
              />
            )}
            {active && editing && hasOptions(c.type) && (
              <TagPicker
                column={c}
                value={tagsOf(cell?.v)}
                multiple={c.type === "multiSelect"}
                initialQuery={draft}
                onChange={(next) => h()?.pick(rowId, c, next)}
                onCreate={(o) => h()?.createOption(c, o) ?? false}
                onClose={() => h()?.closePicker()}
              />
            )}
            {active && editing && c.type === "artifact" && links && (
              <RefPicker
                links={links}
                column={c}
                value={cell?.v}
                initialQuery={draft}
                onChange={(next) => h()?.pick(rowId, c, next)}
                onClose={() => h()?.closePicker()}
              />
            )}
          </div>
        )
      })}
      {!readOnly && <div />}
    </div>
  )
})

/** Wrap occurrences of the search in a highlight. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase()
  if (!q) return text
  const lower = text.toLowerCase()
  const parts: Array<ReactNode> = []
  let from = 0
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} className="rounded-sm bg-[color-mix(in_oklab,#f5c518_45%,transparent)] text-inherit">
        {text.slice(at, at + q.length)}
      </mark>,
    )
    from = at + q.length
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

function CellDisplay({
  column,
  cell,
  query,
  seed,
  links,
  selected,
  placeholder,
  onOpen,
}: {
  column: Column
  cell: Cell | undefined
  query: string
  /** Stable per cell (its key), for the queued skeleton's width. */
  seed: string
  links: TableLinks | undefined
  selected: boolean
  /** Faint text shown on row hover while the cell is empty. */
  placeholder: string | null
  onOpen: () => void
}) {
  const v = cell?.v
  let content: ReactNode = <Highlight text={displayValue(v)} query={query} />
  // A value that doesn't fit the column (left over from a type change, or an
  // option that was removed) is shown as-is and flagged, never hidden.
  // Tags flag themselves one by one, so the rest of a multi-select still reads normally.
  const problem = column.type === "multiSelect" && isTags(v) ? null : misfit(column, cell)

  if (problem) {
    content = (
      <span className="text-danger underline decoration-dotted underline-offset-2" title={`${problem}. Edit the cell to fix it.`}>
        {displayValue(v)}
      </span>
    )
  } else if (column.type === "checkbox") {
    content = v === true ? <CheckSquareIcon size={16} weight="fill" className="text-accent" /> : <SquareIcon size={16} className="text-faint" />
  } else if (column.type === "url" && typeof v === "string" && /^https?:\/\//.test(v)) {
    content = (
      <a href={v} target="_blank" rel="noreferrer" onMouseDown={(e) => e.stopPropagation()} className="text-accent hover:underline">
        <Highlight text={v.replace(/^https?:\/\/(www\.)?/, "")} query={query} />
      </a>
    )
  } else if (hasOptions(column.type) && tagsOf(v).length) {
    content = (
      <span className="flex gap-1 overflow-hidden">
        {tagsOf(v).map((t) => (
          <Tag key={t} column={column} value={t}>
            <Highlight text={t} query={query} />
          </Tag>
        ))}
      </span>
    )
  } else if (column.type === "artifact" && refsOf(v).length) {
    content = <RefChips links={links} value={v} selected={selected} />
  } else if (column.type === "number") {
    content = (
      <span className="block text-right tabular-nums">
        <Highlight text={displayValue(v)} query={query} />
      </span>
    )
  }

  // Queued, running and failed agent cells hold progress text or an error, not a value.
  const pending = cell?.status === "queued" || cell?.status === "running" || cell?.status === "error"
  const empty = !pending && column.type !== "checkbox" && displayValue(v) === ""
  const sources = !pending && cell?.sources?.length ? cell.sources : null
  return (
    <div className="flex h-full items-center gap-1.5 overflow-hidden px-2.5 text-[13px] whitespace-nowrap">
      {pending && cell ? (
        <AgentPending cell={cell} seed={seed} />
      ) : empty ? (
        placeholder && <span aria-hidden data-placeholder={placeholder} className="min-w-0 flex-1 truncate text-faint opacity-0 transition-opacity group-hover:opacity-100 before:content-[attr(data-placeholder)]" />
      ) : (
        <>
          {byAgent(cell) && <AgentMark />}
          <span className="min-w-0 flex-1 truncate">{content}</span>
        </>
      )}
      {sources && <SourcesButton sources={sources} onOpenRow={onOpen} />}
    </div>
  )
}

function CellEditor({
  column,
  draft,
  error,
  setDraft,
  onCommit,
}: {
  column: Column
  draft: string
  error: string | null
  setDraft: (v: string) => void
  onCommit: () => void
}) {
  return (
    <>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={onCommit}
        inputMode={column.type === "number" ? "decimal" : undefined}
        aria-invalid={!!error}
        aria-label={column.name}
        className={`h-full w-full bg-bg px-2.5 text-[13px] outline-none ${error ? "outline-2 -outline-offset-2 outline-danger" : ""}`}
      />
      {error && (
        <div role="alert" className="absolute top-full left-0 z-20 mt-0.5 w-max max-w-80 rounded-md border border-border bg-bg px-2 py-1 text-[12px] whitespace-normal text-danger shadow-md">
          {error}
          <span className="block text-faint">Enter to retry · Esc to cancel</span>
        </div>
      )}
    </>
  )
}

/**
 * Actions for checked rows: set one field on all of them, clear their values,
 * or delete them. Destructive actions ask once more, inline.
 */
function BulkBar({
  rows,
  columns,
  state,
  actions,
  onError,
  onDone,
}: {
  rows: ReadonlyArray<string>
  columns: ReadonlyArray<Column>
  state: TableState
  actions: TableActions
  onError: (message: string) => void
  onDone: () => void
}) {
  const [confirm, setConfirm] = useState<"clear" | "delete" | null>(null)
  const [setting, setSetting] = useState(false)
  const [colId, setColId] = useState(columns[0]?.id ?? "")
  const [raw, setRaw] = useState("")
  const col = columns.find((c) => c.id === colId)
  const n = rows.length
  const label = `${n} row${n === 1 ? "" : "s"}`

  const apply = () => {
    if (!col) return
    const parsed = parseInput(col, raw)
    if (!parsed.ok) return onError(parsed.error)
    const writes = rows
      .filter((r) => !sameValue(getCell(state, r, col.id)?.v ?? null, parsed.value))
      .map((rowId) => ({ rowId, colId: col.id, value: parsed.value }))
    if (writes.length) actions.setCells(writes)
    setSetting(false)
    setRaw("")
  }

  const button = "flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-hover"
  return (
    <div
      role="toolbar"
      aria-label="Selected rows"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          onDone()
        }
      }}
      className="absolute bottom-11 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-bg p-1 text-[13px] shadow-lg"
    >
      <span className="px-2 font-medium tabular-nums">{n} selected</span>
      <span className="h-5 w-px bg-border" />
      {setting ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <select aria-label="Field to set" value={colId} onChange={(e) => setColId(e.target.value)} className="h-7 rounded border border-border bg-bg px-1 text-[13px]">
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {col?.type === "select" || col?.type === "checkbox" ? (
            <select aria-label="Value" value={raw} onChange={(e) => setRaw(e.target.value)} className="h-7 rounded border border-border bg-bg px-1 text-[13px]">
              <option value="">(empty)</option>
              {(col.type === "checkbox" ? ["Yes", "No"] : (col.options ?? [])).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              autoFocus
              aria-label="Value"
              value={raw}
              placeholder={col?.type === "multiSelect" ? (col.options ?? []).slice(0, 2).join(", ") || "a, b" : "Value (empty clears)"}
              onChange={(e) => setRaw(e.target.value)}
              className="h-7 w-44 rounded border border-border bg-bg px-1.5 text-[13px] outline-none focus:border-accent"
            />
          )}
          <button type="submit" className="h-7 rounded-md bg-accent px-2.5 font-medium text-accent-text">
            Set {label}
          </button>
          <button type="button" onClick={() => setSetting(false)} className="h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-text">
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button type="button" onClick={() => setSetting(true)} className={button}>
            Set field…
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm !== "clear") return setConfirm("clear")
              const writes = rows.flatMap((rowId) =>
                columns.filter((c) => getCell(state, rowId, c.id)).map((c) => ({ rowId, colId: c.id, value: null })),
              )
              if (writes.length) actions.setCells(writes)
              setConfirm(null)
            }}
            className={`${button} ${confirm === "clear" ? "text-danger" : ""}`}
          >
            {confirm === "clear" ? `Clear all values in ${label}?` : "Clear values"}
          </button>
          <button
            type="button"
            onClick={() => {
              // Deleting rows can't be undone, so ask once more.
              if (confirm !== "delete") return setConfirm("delete")
              actions.removeRows(rows)
              onDone()
            }}
            className={`${button} text-danger`}
          >
            <TrashIcon size={14} /> {confirm === "delete" ? `Delete ${label}? Click again` : `Delete ${label}`}
          </button>
        </>
      )}
      <button type="button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onDone} className="grid size-7 place-items-center rounded text-muted hover:bg-hover hover:text-text">
        <XIcon size={13} />
      </button>
    </div>
  )
}

/** Limits from the protocol's Column schema, checked here so people get a sentence instead of a schema error. */
const MAX_NAME = 120
const MAX_PROMPT = 4000
const DEFAULT_OPTIONS = ["Lead", "Contacted", "Replied", "Won"]

/** The column menu's width (w-64), to decide which way it opens. */
const MENU_WIDTH = 256
/** Agent headers narrower than this leave out the "7/20 · 35%" so the name still reads. */
const PROGRESS_MIN_WIDTH = 170

/** What a just-added column's header opens on: its menu (prompt or options) or its name. */
type HeaderIntro = "menu" | "rename" | null

function HeaderCell({
  column,
  hasValues,
  actions,
  readOnly,
  canDelete,
  canHide,
  sorted,
  filtered,
  dragging,
  dropBefore,
  dropAfter,
  onError,
  onSort,
  onHide,
  onMove,
  onDragStart,
  onResizeStart,
  onAutoFit,
  progress,
  narrow = false,
  intro = null,
}: {
  column: Column
  hasValues: boolean
  actions: TableActions
  readOnly: boolean
  canDelete: boolean
  canHide: boolean
  sorted: SortRule["dir"] | null
  filtered: boolean
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  onError: (message: string) => void
  onSort: (dir: SortRule["dir"]) => void
  onHide: () => void
  onMove: (delta: -1 | 1) => void
  onDragStart: (e: ReactPointerEvent) => void
  onResizeStart: (e: ReactPointerEvent) => void
  onAutoFit: () => void
  /** Agent columns: how far their run has got. */
  progress?: RunProgress | undefined
  /** Too narrow for the progress text (the bar under the header still shows it). */
  narrow?: boolean
  intro?: HeaderIntro
}) {
  const [renaming, setRenaming] = useState(intro === "rename")
  const [name, setName] = useState(column.name)
  const [menu, setMenu] = useState(intro === "menu")
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** Open the menu leftwards from a header near the right edge, so it isn't cut off. */
  const [menuRight, setMenuRight] = useState(false)
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (menu && r) setMenuRight(r.left + MENU_WIDTH > window.innerWidth - 8)
  }, [menu])
  const ref = useRef<HTMLDivElement>(null)
  const TypeIcon = typeIcons[column.type]

  useEffect(() => setName(column.name), [column.name])
  useEffect(() => {
    setConfirmDelete(false)
    if (!menu) return
    const close = (e: MouseEvent) => e.target instanceof Node && !ref.current?.contains(e.target) && setMenu(false)
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [menu])

  const rename = () => {
    setRenaming(false)
    const next = name.trim()
    if (!next) {
      setName(column.name)
      if (name !== column.name) onError("A column needs a name.")
      return
    }
    // A duplicate name is rejected by the reducer, which shows why; put the old name back.
    if (next === column.name || !actions.updateColumn(column.id, { name: next })) setName(column.name)
  }

  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-hover"
  const drop = dropBefore ? "inset 2px 0 0 0 var(--accent)" : dropAfter ? "inset -2px 0 0 0 var(--accent)" : undefined

  return (
    <div
      ref={ref}
      role="columnheader"
      data-col={column.id}
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
      onPointerDown={(e) => {
        // Drag the header itself (not its menu button, rename box or resize edge) to reorder.
        if (e.target instanceof Element && e.target.closest("button, input, [role=separator], [role=dialog]")) return
        onDragStart(e)
      }}
      className={`group/h relative flex h-9 items-center gap-1.5 border-r border-border px-2.5 text-[13px] font-medium text-muted ${readOnly ? "" : "cursor-grab active:cursor-grabbing"} ${dragging ? "opacity-50" : ""}`}
      style={drop ? { boxShadow: drop } : undefined}
    >
      <TypeIcon size={14} weight={column.type === "agent" ? "duotone" : "regular"} className={`shrink-0 ${column.type === "agent" ? "text-accent" : ""}`} />
      {renaming ? (
        <input
          autoFocus
          onFocus={(e) => e.target.select()}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          maxLength={MAX_NAME}
          aria-label="Column name"
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") rename()
            if (e.key === "Escape") {
              setName(column.name)
              setRenaming(false)
            }
          }}
          className="min-w-0 flex-1 rounded bg-bg px-1 text-text outline-none"
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate"
          title={column.type === "agent" && column.prompt ? `${column.name}\n\nAgent prompt: ${column.prompt}` : column.name}
          onDoubleClick={() => !readOnly && setRenaming(true)}
        >
          {column.name}
        </span>
      )}
      {progress && !renaming && !narrow && <HeaderProgress progress={progress} />}
      {progress && <ProgressBar progress={progress} className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5" />}
      {filtered && <FunnelIcon size={12} weight="fill" className="shrink-0 text-accent" aria-label="Filtered" />}
      {sorted && (sorted === "asc" ? <ArrowUpIcon size={12} weight="bold" className="shrink-0 text-accent" aria-label="Sorted ascending" /> : <ArrowDownIcon size={12} weight="bold" className="shrink-0 text-accent" aria-label="Sorted descending" />)}
      <button
        type="button"
        aria-label={`${column.name} options`}
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
        className="grid size-5 shrink-0 place-items-center rounded opacity-0 group-hover/h:opacity-100 hover:bg-active focus-visible:opacity-100 aria-expanded:opacity-100"
      >
        <CaretDownIcon size={11} weight="bold" />
      </button>
      {!readOnly && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${column.name}`}
          title="Drag to resize · double-click to fit"
          onPointerDown={onResizeStart}
          onDoubleClick={onAutoFit}
          className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-accent/40"
        />
      )}
      {menu && (
        <div
          role="dialog"
          aria-label={`${column.name} menu`}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Escape") setMenu(false)
          }}
          className={`absolute top-full ${menuRight ? "right-0" : "left-0"} z-40 mt-1 max-h-[min(640px,calc(100vh-160px))] w-64 cursor-default overflow-y-auto overscroll-contain rounded-lg border border-border bg-bg p-1 text-[13px] font-normal text-text shadow-lg`}
        >
          <button type="button" onClick={() => { setMenu(false); onSort("asc") }} className={item}>
            <ArrowUpIcon size={14} /> Sort A → Z
          </button>
          <button type="button" onClick={() => { setMenu(false); onSort("desc") }} className={item}>
            <ArrowDownIcon size={14} /> Sort Z → A
          </button>
          {canHide && (
            <button type="button" onClick={() => { setMenu(false); onHide() }} className={item}>
              <EyeSlashIcon size={14} /> Hide field <span className="ml-auto text-[11px] text-faint">just for you</span>
            </button>
          )}
          {!readOnly && (
            <>
              <div className="my-1 border-t border-border" />
              <button type="button" onClick={() => { setMenu(false); setRenaming(true) }} className={item}>
                Rename
              </button>
              <div className="flex gap-1">
                <button type="button" onClick={() => onMove(-1)} className={`${item} justify-center`}>
                  ← Move left
                </button>
                <button type="button" onClick={() => onMove(1)} className={`${item} justify-center`}>
                  Move right →
                </button>
              </div>
              {column.type === "agent" && (
                <label className="block px-2 pt-2 pb-1 text-[11px] font-medium text-faint">
                  <span className="flex items-center gap-1">
                    <RobotIcon size={12} weight="duotone" className="text-accent" /> Agent prompt
                  </span>
                  <textarea
                    key={column.prompt ?? ""}
                    autoFocus={intro === "menu"}
                    onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
                    maxLength={MAX_PROMPT}
                    defaultValue={column.prompt ?? ""}
                    placeholder="e.g. Find this company's CEO and their LinkedIn URL"
                    onBlur={(e) => e.target.value !== (column.prompt ?? "") && actions.updateColumn(column.id, { prompt: e.target.value })}
                    rows={4}
                    className="mt-1 w-full resize-none rounded border border-border bg-bg px-1.5 py-1 text-[13px] leading-snug font-normal text-text outline-none focus:border-accent"
                  />
                  <span className="block font-normal">Runs row by row. To fill it, @mention claude in a cell.</span>
                </label>
              )}
              <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-faint">Type</div>
              <div role="group" aria-label="Type" className="grid grid-cols-2 gap-0.5">
              {(Object.keys(columnTypes) as ColumnType[]).map((t) => {
                const Icon = typeIcons[t]
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      if (t === column.type) return
                      // Turning a column with values into a (multi-)select makes its values the options (in the
                      // reducer); an empty one starts with a sensible pipeline.
                      actions.updateColumn(
                        column.id,
                        hasOptions(t) && !column.options?.length && !hasValues ? { type: t, options: DEFAULT_OPTIONS } : { type: t },
                      )
                      // Stay open on a select so its options can be edited right away.
                      if (!hasOptions(t)) setMenu(false)
                    }}
                    aria-pressed={t === column.type}
                    className={`${item} py-1 ${t === column.type ? "bg-active font-medium" : ""}`}
                  >
                    <Icon size={14} className="shrink-0" /> <span className="truncate">{columnTypes[t].label}</span>
                  </button>
                )
              })}
              </div>
              {hasOptions(column.type) && (
                <OptionsEditor
                  column={column}
                  onError={onError}
                  setOptions={(options) => actions.updateColumn(column.id, { options })}
                  addOption={(option) => actions.updateColumn(column.id, addOptionPatch(column, option))}
                  setColor={(option, color) => actions.updateColumn(column.id, { colors: { ...column.colors, [option]: color } })}
                  rename={(from, to) => actions.renameOption(column.id, from, to)}
                />
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={() => {
                    // Deleting a column with data can't be undone, so ask once more.
                    if (hasValues && !confirmDelete) return setConfirmDelete(true)
                    setMenu(false)
                    actions.removeColumn(column.id)
                  }}
                  className="mt-1 flex w-full items-center gap-2 rounded border-t border-border px-2 py-1.5 text-left text-danger hover:bg-hover"
                >
                  <TrashIcon size={14} /> {confirmDelete ? "Delete column and its values?" : "Delete column"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
