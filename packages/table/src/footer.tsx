import { useCallback, useEffect, useRef, useState } from "react"
import { CaretDownIcon, CheckIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { cellKey, cellText, type Column, type ColumnType, type TableState } from "@standard-artifacts/protocol"
import { ProgressBar, percent, progressTitle, runProgress } from "./agent"

/**
 * The bar under the grid: how many rows you're looking at, and a calculation
 * per column (count, % filled, sum, average…) that each viewer picks for
 * themselves. Agent columns default to how far their run has got.
 */

type Calc =
  | "none"
  | "progress"
  | "filled"
  | "empty"
  | "percentFilled"
  | "unique"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "checked"
  | "percentChecked"

const labels: Record<Calc, string> = {
  none: "None",
  progress: "Run progress",
  filled: "Filled",
  empty: "Empty",
  percentFilled: "Percent filled",
  unique: "Unique",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
  checked: "Checked",
  percentChecked: "Percent checked",
}

/** Short labels shown next to the result. */
const short: Partial<Record<Calc, string>> = { percentFilled: "Filled", percentChecked: "Checked", avg: "Avg" }

function calcsFor(type: ColumnType): ReadonlyArray<Calc> {
  const counts: Array<Calc> = ["filled", "empty", "percentFilled", "unique"]
  if (type === "agent") return ["progress", ...counts, "none"]
  if (type === "number") return ["sum", "avg", "min", "max", ...counts, "none"]
  if (type === "checkbox") return ["checked", "percentChecked", "none"]
  return [...counts, "none"]
}

const defaultCalc = (type: ColumnType): Calc => (type === "agent" ? "progress" : "none")

/** Per viewer, per column (column ids are unique across tables), in localStorage. */
const STORAGE_KEY = "standard-artifacts.table.calculations"

function loadCalcs(): Record<string, Calc> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Calc>) : {}
  } catch {
    return {}
  }
}

function useCalcs() {
  const [calcs, setCalcs] = useState<Record<string, Calc>>(loadCalcs)
  const set = useCallback((colId: string, calc: Calc) => {
    setCalcs((prev) => {
      const next = { ...prev, [colId]: calc }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Private mode or storage full: the choice still holds for this visit.
      }
      return next
    })
  }, [])
  return [calcs, set] as const
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 })

function compute(calc: Calc, state: TableState, rows: ReadonlyArray<string>, column: Column): string {
  const values = rows.map((r) => state.cells[cellKey(r, column.id)])
  // Queued, running and failed cells hold the agent's progress text, not a value.
  const settled = values.map((c) => (c && (c.status === undefined || c.status === "done") ? c.v : null))
  const nonEmpty = settled.filter((v) => cellText(v ?? null) !== "")
  const numbers = settled.filter((v): v is number => typeof v === "number")
  switch (calc) {
    case "filled":
      return fmt(nonEmpty.length)
    case "empty":
      return fmt(rows.length - nonEmpty.length)
    case "percentFilled":
      return `${percent(nonEmpty.length, rows.length)}%`
    case "unique":
      return fmt(new Set(nonEmpty.map((v) => cellText(v).trim().toLowerCase())).size)
    case "sum":
      return fmt(numbers.reduce((a, b) => a + b, 0))
    case "avg":
      return numbers.length ? fmt(numbers.reduce((a, b) => a + b, 0) / numbers.length) : "–"
    case "min":
      return numbers.length ? fmt(Math.min(...numbers)) : "–"
    case "max":
      return numbers.length ? fmt(Math.max(...numbers)) : "–"
    case "checked":
      return fmt(settled.filter((v) => v === true).length)
    case "percentChecked":
      return `${percent(settled.filter((v) => v === true).length, rows.length)}%`
    case "none":
    case "progress":
      return ""
  }
}

export function GridFooter({
  state,
  rows,
  columns,
  template,
}: {
  state: TableState
  rows: ReadonlyArray<string>
  columns: ReadonlyArray<Column>
  template: string
}) {
  const [calcs, setCalc] = useCalcs()
  const n = rows.length
  return (
    <div
      role="row"
      aria-label="Summary"
      className="group/foot sticky bottom-0 z-20 grid h-8 border-t border-border bg-bg text-[12px]"
      style={{ gridTemplateColumns: template }}
    >
      <div className="flex items-center justify-center text-[11px] whitespace-nowrap text-faint tabular-nums" title={`${n.toLocaleString("en-US")} rows`}>
        {n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US")} {n === 1 ? "row" : "rows"}
      </div>
      {columns.map((c) => (
        <FooterCell key={c.id} column={c} calc={calcs[c.id] ?? defaultCalc(c.type)} onCalc={(calc) => setCalc(c.id, calc)} state={state} rows={rows} />
      ))}
    </div>
  )
}

function FooterCell({
  column,
  calc: chosen,
  onCalc,
  state,
  rows,
}: {
  column: Column
  calc: Calc
  onCalc: (calc: Calc) => void
  state: TableState
  rows: ReadonlyArray<string>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => e.target instanceof Node && !ref.current?.contains(e.target) && setOpen(false)
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])
  const options = calcsFor(column.type)
  // A choice saved for another type (the column changed type since) falls back to the default.
  const calc = options.includes(chosen) ? chosen : defaultCalc(column.type)
  const right = column.type === "number"

  let body
  if (calc === "progress") {
    const p = runProgress(state, rows, column.id)
    const busy = p.running + p.queued
    body = (
      <span className="flex min-w-0 flex-1 items-center gap-2 tabular-nums" title={progressTitle(p)}>
        <ProgressBar progress={p} className="h-1.5 w-12 shrink-0 rounded-full" />
        <span className="shrink-0 font-medium text-text">
          {p.done}/{p.total}
        </span>
        {busy > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-accent">
            <CircleNotchIcon size={11} weight="bold" className={p.running ? "animate-spin" : ""} />
            {busy}
          </span>
        )}
        {p.failed > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-danger">
            <WarningCircleIcon size={12} weight="fill" />
            {p.failed}
          </span>
        )}
      </span>
    )
  } else if (calc === "none") {
    body = (
      <span className={`flex flex-1 items-center gap-1 text-faint opacity-0 group-hover/foot:opacity-100 ${right ? "justify-end" : ""} ${open ? "opacity-100" : ""}`}>
        Calculate <CaretDownIcon size={10} weight="bold" />
      </span>
    )
  } else {
    body = (
      <span className={`flex min-w-0 flex-1 items-baseline gap-1.5 ${right ? "justify-end" : ""}`}>
        <span className="text-faint">{short[calc] ?? labels[calc]}</span>
        <span className="truncate font-medium text-text tabular-nums">{compute(calc, state, rows, column)}</span>
      </span>
    )
  }

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        aria-label={`Calculation for ${column.name}: ${labels[calc]}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-full w-full min-w-0 items-center px-2.5 text-left hover:bg-hover aria-expanded:bg-hover"
      >
        {body}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Calculate ${column.name}`}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Escape") setOpen(false)
          }}
          className="absolute bottom-full left-0 z-40 mb-1 w-48 rounded-lg border border-border bg-bg p-1 text-[13px] shadow-lg"
        >
          <div className="px-2 pt-1 pb-1 text-[11px] font-medium text-faint">Calculate</div>
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="menuitemradio"
              aria-checked={o === calc}
              onClick={() => {
                onCalc(o)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-hover"
            >
              <span className="flex-1">{labels[o]}</span>
              {o === calc && <CheckIcon size={13} weight="bold" className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
