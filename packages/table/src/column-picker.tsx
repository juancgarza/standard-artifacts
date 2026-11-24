import { useEffect, useRef, useState } from "react"
import {
  AtIcon,
  BuildingsIcon,
  CheckSquareIcon,
  HashIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  RobotIcon,
  SparkleIcon,
  TextTIcon,
  StackIcon,
  UserFocusIcon,
  type Icon,
} from "@phosphor-icons/react"
import { columnTypes, type Column, type ColumnType } from "@standard-artifacts/protocol"

export const typeIcons: Record<ColumnType, Icon> = {
  text: TextTIcon,
  number: HashIcon,
  url: LinkSimpleIcon,
  email: AtIcon,
  checkbox: CheckSquareIcon,
  select: ListBulletsIcon,
  multiSelect: ListChecksIcon,
  artifact: StackIcon,
  agent: RobotIcon,
}

/** A new column: what to call it and what it holds. The grid picks a free name and adds it. */
export type ColumnDraft = Omit<Column, "id">

type Choice = { id: string; label: string; hint: string; icon: Icon; agent: boolean; column: ColumnDraft; keywords?: string }

/** Starting points for agent columns; each is an ordinary agent column with its prompt filled in. */
const agentPresets: ReadonlyArray<Choice> = [
  {
    id: "research",
    label: "Research company",
    hint: "What it does, size, funding, news",
    icon: BuildingsIcon,
    agent: true,
    keywords: "enrich company firmographics summary",
    column: {
      name: "Company research",
      type: "agent",
      width: 280,
      prompt:
        "Research this row's company using its name and website. In 2–3 sentences, say what it does, roughly how many people work there, how it's funded and anything notable from the last year. Cite your sources.",
    },
  },
  {
    id: "person",
    label: "Find person",
    hint: "Name, title and LinkedIn for a role",
    icon: UserFocusIcon,
    agent: true,
    keywords: "contact people lead ceo founder linkedin",
    column: {
      name: "Contact",
      type: "agent",
      width: 240,
      prompt:
        "Find the person at this row's company who holds the role below. Return their full name and title, and their LinkedIn URL if you can confirm it. Cite your sources.\n\nRole: Head of Sales",
    },
  },
  {
    id: "custom",
    label: "Custom prompt",
    hint: "Tell the agent what to fill in",
    icon: SparkleIcon,
    agent: true,
    keywords: "ai agent prompt anything",
    column: { name: "Agent", type: "agent", width: 240, prompt: "" },
  },
]

const fieldHints: Record<ColumnType, string> = {
  text: "Any text",
  number: "Counts, amounts, scores",
  url: "Links, shown short",
  email: "Email addresses",
  checkbox: "Yes or no",
  select: "One option from a list",
  multiSelect: "Several options",
  artifact: "Links to boards, tables, docs and issues",
  agent: "Filled by an agent, row by row",
}

const DEFAULT_OPTIONS = ["Lead", "Contacted", "Replied", "Won"]

const fieldChoices: ReadonlyArray<Choice> = (Object.keys(columnTypes) as Array<ColumnType>)
  .filter((t) => t !== "agent")
  .map((t) => ({
    id: t,
    label: columnTypes[t].label,
    hint: fieldHints[t],
    icon: typeIcons[t],
    agent: false,
    // No name: the grid gives it the next "Column N" and opens it for renaming.
    column: { name: "", type: t, ...((t === "select" || t === "multiSelect") && { options: DEFAULT_OPTIONS }) },
  }))

/**
 * The "+" at the end of the header: agent fields first (the reason to use
 * this table over a spreadsheet), then the standard field types, with a search.
 */
export function AddColumnButton({ onAdd }: { onAdd: (column: ColumnDraft) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => e.target instanceof Node && !ref.current?.contains(e.target) && setOpen(false)
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Add column"
        title="Add column"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="grid h-9 w-full place-items-center text-muted hover:bg-hover hover:text-text aria-expanded:bg-hover aria-expanded:text-text"
      >
        <PlusIcon size={14} weight="bold" />
      </button>
      {open && (
        <ColumnPicker
          onPick={(column) => {
            setOpen(false)
            onAdd(column)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function ColumnPicker({ onPick, onClose }: { onPick: (column: ColumnDraft) => void; onClose: () => void }) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const match = (c: Choice) => !q || `${c.label} ${c.hint} ${c.keywords ?? ""}`.toLowerCase().includes(q)
  const agents = agentPresets.filter(match)
  const fields = fieldChoices.filter(match)
  const all = [...agents, ...fields]
  useEffect(() => setActive(0), [q])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const row = (c: Choice, i: number) => {
    const I = c.icon
    return (
      <button
        key={c.id}
        type="button"
        role="option"
        aria-selected={i === active}
        data-index={i}
        onMouseEnter={() => setActive(i)}
        onClick={() => onPick(c.column)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left aria-selected:bg-hover"
      >
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-md ${c.agent ? "bg-accent/10 text-accent" : "border border-border text-muted"}`}
        >
          <I size={15} weight={c.agent ? "duotone" : "regular"} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text">{c.label}</span>
          <span className="block truncate text-[11px] text-faint">{c.hint}</span>
        </span>
      </button>
    )
  }

  return (
    <div
      role="dialog"
      aria-label="Add a field"
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") onClose()
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault()
          if (all.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length)
        } else if (e.key === "Enter") {
          e.preventDefault()
          const pick = all[active]
          if (pick) onPick(pick.column)
        }
      }}
      className="absolute top-full right-0 z-40 mt-1 flex max-h-[min(520px,calc(100vh-180px))] w-72 cursor-default flex-col overflow-hidden rounded-lg border border-border bg-bg text-[13px] font-normal text-text shadow-lg"
    >
      <div className="relative border-b border-border p-1.5">
        <MagnifyingGlassIcon size={13} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a field type"
          aria-label="Find a field type"
          className="h-7 w-full rounded-md bg-surface pr-2 pl-7 text-[13px] outline-none placeholder:text-faint"
        />
      </div>
      <div ref={list} role="listbox" aria-label="Field types" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {agents.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-[11px] font-medium text-faint">
              <SparkleIcon size={11} weight="fill" className="text-accent/70" /> Agent fields
              <span className="ml-auto font-normal">filled per row</span>
            </div>
            {agents.map((c, i) => row(c, i))}
          </>
        )}
        {fields.length > 0 && (
          <>
            <div className={`px-2 pt-2 pb-1 text-[11px] font-medium text-faint ${agents.length ? "mt-1 border-t border-border" : ""}`}>Standard fields</div>
            {fields.map((c, i) => row(c, agents.length + i))}
          </>
        )}
        {all.length === 0 && <p className="px-2 py-3 text-center text-[12px] text-faint">No field type matches "{query}"</p>}
      </div>
    </div>
  )
}
