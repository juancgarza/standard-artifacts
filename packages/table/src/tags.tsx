import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { CheckIcon, DotsSixVerticalIcon, PlusIcon, XIcon } from "@phosphor-icons/react"
import { optionColor, optionColors, type Column, type OptionColor } from "@standard-artifacts/protocol"

/** Hues for option colors; mixed with the theme's bg/text below so tags stay legible in light and dark. */
const hues: Record<OptionColor, string> = {
  gray: "#8a8a85",
  brown: "#a27763",
  orange: "#e07b39",
  yellow: "#cf9f1f",
  green: "#3f9f6b",
  blue: "#3d7fe0",
  purple: "#8e63ce",
  pink: "#d0559c",
  red: "#d9534a",
}

export const tagStyle = (color: OptionColor): CSSProperties => ({
  background: `color-mix(in oklab, ${hues[color]} 20%, var(--bg))`,
  color: `color-mix(in oklab, ${hues[color]} 62%, var(--text))`,
})

export const swatchStyle = (color: OptionColor): CSSProperties => ({ background: hues[color] })

/** Limits from the protocol's Column schema, checked here so people get a sentence instead of a schema error. */
export const MAX_OPTION = 60
export const MAX_OPTIONS = 50

type OptionsColumn = Pick<Column, "name" | "options" | "colors">

/**
 * A column patch that adds `option`, colored with the color its siblings use
 * least (its name's default color when that's among them), so a handful of
 * options never repeat a color.
 */
export function addOptionPatch(column: OptionsColumn, option: string) {
  const options = column.options ?? []
  const uses = (c: OptionColor) => options.filter((o) => optionColor(column, o) === c).length
  // Gray reads as "unset", so it's only ever chosen by hand.
  const choices = optionColors.filter((c) => c !== "gray")
  const fewest = Math.min(...choices.map(uses))
  const preferred = optionColor(column, option)
  const color = uses(preferred) === fewest ? preferred : (choices.find((c) => uses(c) === fewest) ?? preferred)
  return { options: [...options, option], colors: { ...column.colors, [option]: color } }
}

/** One option as a colored pill. A value that isn't an option (left after it was removed) is flagged. */
export function Tag({
  column,
  value,
  onRemove,
  children,
}: {
  column: OptionsColumn
  value: string
  onRemove?: (() => void) | undefined
  children?: ReactNode
}) {
  const known = (column.options ?? []).includes(value)
  return (
    <span
      className={`inline-flex h-5 max-w-full shrink-0 items-center gap-0.5 rounded px-1.5 text-[12px] leading-5 ${known ? "" : "text-danger underline decoration-dotted underline-offset-2"}`}
      style={known ? tagStyle(optionColor(column, value)) : undefined}
      title={known ? value : `"${value}" isn't one of ${column.name}'s options`}
    >
      <span className="truncate">{children ?? value}</span>
      {onRemove && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Remove ${value}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
          className="-mr-0.5 grid size-3.5 shrink-0 place-items-center rounded-sm opacity-70 hover:opacity-100"
        >
          <XIcon size={9} weight="bold" />
        </button>
      )}
    </span>
  )
}

/**
 * Pick options for a select or multi-select cell: type to filter, Enter to
 * pick (or create what you typed), Backspace on an empty search removes the
 * last tag, Esc or Tab closes. Every change saves at once, like Airtable.
 */
export function TagPicker({
  column,
  value,
  multiple,
  initialQuery = "",
  onChange,
  onCreate,
  onClose,
  className = "absolute top-0 left-0 z-40",
}: {
  column: OptionsColumn
  value: ReadonlyArray<string>
  multiple: boolean
  initialQuery?: string
  onChange: (next: ReadonlyArray<string>) => void
  /** Add an option to the column; false if the column can't take it (the reason is shown elsewhere). */
  onCreate: ((option: string) => boolean) | undefined
  onClose: () => void
  className?: string
}) {
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const options = column.options ?? []
  const q = query.trim()
  const shown = useMemo(() => (q ? options.filter((o) => o.toLowerCase().includes(q.toLowerCase())) : options), [options, q])
  const exact = options.some((o) => o.toLowerCase() === q.toLowerCase())
  const creatable = !!onCreate && q !== "" && !exact && q.length <= MAX_OPTION && options.length < MAX_OPTIONS
  const count = shown.length + (creatable ? 1 : 0)
  // Keep the highlight on a real row as the list narrows.
  const at = Math.min(active, Math.max(0, count - 1))

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" })
  }, [at])

  const pick = (option: string) => {
    if (!multiple) {
      onChange(value[0] === option ? [] : [option])
      return onClose()
    }
    onChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option])
    setQuery("")
  }

  const create = () => {
    if (!onCreate || !onCreate(q)) return
    if (!multiple) {
      onChange([q])
      return onClose()
    }
    onChange([...value, q])
    setQuery("")
  }

  const choose = (index: number) => {
    const option = shown[index]
    if (option !== undefined) pick(option)
    else if (creatable && index === shown.length) create()
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`Choose ${column.name}`}
      onBlur={(e) => {
        // Clicking an option keeps focus (mousedown is prevented); anything else outside closes.
        if (!rootRef.current?.contains(e.relatedTarget)) onClose()
      }}
      className={`${className} w-64 min-w-full overflow-hidden rounded-lg border border-border bg-bg text-[13px] text-text shadow-lg`}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-border p-1.5">
        {value.map((v) => (
          <Tag key={v} column={column} value={v} onRemove={() => onChange(value.filter((x) => x !== v))} />
        ))}
        <input
          autoFocus
          role="combobox"
          aria-label={column.name}
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={count ? `${listId}-${at}` : undefined}
          value={query}
          placeholder={options.length ? "Find an option" : onCreate ? "Type to create an option" : "No options"}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              e.stopPropagation()
              if (count) setActive((at + (e.key === "ArrowDown" ? 1 : count - 1)) % count)
            } else if (e.key === "Enter") {
              e.preventDefault()
              e.stopPropagation()
              if (count) choose(at)
              else if (!q) onClose()
            } else if (e.key === "Backspace" && query === "" && value.length) {
              e.preventDefault()
              e.stopPropagation()
              onChange(value.slice(0, -1))
            } else if (e.key === "Escape") {
              // Only close the picker: in the record panel a bubbling Esc would close the whole panel.
              e.stopPropagation()
              onClose()
            } else if (e.key !== "Tab") {
              e.stopPropagation()
            }
          }}
          className="h-6 min-w-16 flex-1 bg-transparent px-1 outline-none placeholder:text-faint"
        />
      </div>
      <ul ref={listRef} id={listId} role="listbox" aria-label={`${column.name} options`} aria-multiselectable={multiple} className="max-h-60 overflow-y-auto p-1">
        {shown.map((o, i) => (
          <li
            key={o}
            id={`${listId}-${i}`}
            data-index={i}
            role="option"
            aria-selected={value.includes(o)}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(o)}
            className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 ${i === at ? "bg-hover" : ""}`}
          >
            <Tag column={column} value={o} />
            {value.includes(o) && <CheckIcon size={13} weight="bold" className="ml-auto shrink-0 text-accent" />}
          </li>
        ))}
        {creatable && (
          <li
            id={`${listId}-${shown.length}`}
            data-index={shown.length}
            role="option"
            aria-selected={false}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(shown.length)}
            onClick={create}
            className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-muted ${at === shown.length ? "bg-hover" : ""}`}
          >
            <PlusIcon size={12} weight="bold" /> Create
            <span className="inline-flex h-5 items-center rounded px-1.5 text-[12px]" style={tagStyle(optionColor(column, q))}>
              {q}
            </span>
          </li>
        )}
        {count === 0 && <li className="px-1.5 py-1 text-faint">{q ? "No matching option" : "No options yet"}</li>}
      </ul>
    </div>
  )
}

/**
 * The column menu's option list: rename in place (cells follow), pick a color,
 * drag (or Alt+↑/↓) to reorder, remove, and add.
 */
export function OptionsEditor({
  column,
  setOptions,
  addOption,
  setColor,
  rename,
  onError,
}: {
  column: OptionsColumn
  setOptions: (options: ReadonlyArray<string>) => void
  addOption: (option: string) => void
  setColor: (option: string, color: OptionColor) => void
  rename: (from: string, to: string) => boolean
  onError: (message: string) => void
}) {
  const saved = column.options ?? []
  const [adding, setAdding] = useState("")
  const [palette, setPalette] = useState<string | null>(null)
  /** While dragging, the order is previewed locally and saved once on drop (not one op per hover). */
  const [drag, setDrag] = useState<{ option: string; order: ReadonlyArray<string> } | null>(null)
  const options = drag?.order ?? saved

  const reorder = (list: ReadonlyArray<string>, option: string, to: number) => {
    const rest = list.filter((o) => o !== option)
    rest.splice(Math.max(0, Math.min(rest.length, to)), 0, option)
    return rest
  }
  const save = (next: ReadonlyArray<string>) => {
    if (next.join("\u0000") !== saved.join("\u0000")) setOptions(next)
  }

  const add = () => {
    const name = adding.trim()
    if (!name) return
    if (name.length > MAX_OPTION) return onError(`Options can be up to ${MAX_OPTION} characters.`)
    if (saved.length >= MAX_OPTIONS) return onError(`A select can have up to ${MAX_OPTIONS} options.`)
    const clash = saved.find((o) => o.toLowerCase() === name.toLowerCase())
    if (clash) return onError(`"${clash}" is already an option.`)
    addOption(name)
    setAdding("")
  }

  return (
    <div className="px-1 pt-2 pb-1">
      <div className="px-1 pb-1 text-[11px] font-medium text-faint">Options</div>
      <ul aria-label={`${column.name} options`} className="max-h-56 overflow-y-auto">
        {options.map((o, i) => (
          <li
            key={o}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move"
              e.dataTransfer.setData("text/plain", o)
              setDrag({ option: o, order: saved })
            }}
            onDragOver={(e) => {
              if (!drag) return
              e.preventDefault()
              if (drag.option !== o) setDrag({ ...drag, order: reorder(drag.order, drag.option, i) })
            }}
            onDrop={(e) => e.preventDefault()}
            onDragEnd={() => {
              if (drag) save(drag.order)
              setDrag(null)
            }}
            className={`rounded ${drag?.option === o ? "opacity-40" : ""}`}
          >
            <div className="group/o flex items-center gap-1 py-0.5">
              <DotsSixVerticalIcon size={14} className="shrink-0 cursor-grab text-faint" aria-hidden />
              <button
                type="button"
                aria-label={`Color of ${o}`}
                aria-expanded={palette === o}
                onClick={() => setPalette((p) => (p === o ? null : o))}
                className="size-3.5 shrink-0 rounded-full"
                style={swatchStyle(optionColor(column, o))}
              />
              <input
                key={o}
                defaultValue={o}
                aria-label={`Option ${i + 1}`}
                maxLength={MAX_OPTION}
                onBlur={(e) => {
                  const next = e.target.value.trim()
                  if (!next || next === o || !rename(o, next)) e.target.value = o
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur()
                  if (e.key === "Escape") {
                    e.currentTarget.value = o
                    e.currentTarget.blur()
                  }
                  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                    e.preventDefault()
                    save(reorder(saved, o, i + (e.key === "ArrowUp" ? -1 : 1)))
                  }
                }}
                className="h-6 min-w-0 flex-1 rounded px-1 text-[13px] outline-none hover:bg-hover focus:bg-hover"
              />
              <button
                type="button"
                aria-label={`Remove option ${o}`}
                title="Remove option (cells keep the value, flagged)"
                onClick={() => setOptions(saved.filter((x) => x !== o))}
                className="grid size-5 shrink-0 place-items-center rounded text-faint opacity-0 group-hover/o:opacity-100 hover:bg-hover hover:text-danger focus-visible:opacity-100"
              >
                <XIcon size={11} />
              </button>
            </div>
            {palette === o && (
              <div role="group" aria-label={`Colors for ${o}`} className="flex flex-wrap gap-1 py-1 pl-6">
                {optionColors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    aria-pressed={optionColor(column, o) === c}
                    onClick={() => {
                      setColor(o, c)
                      setPalette(null)
                    }}
                    className={`size-4 rounded-full ${optionColor(column, o) === c ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : ""}`}
                    style={swatchStyle(c)}
                  />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-1 flex items-center gap-1">
        <PlusIcon size={12} className="ml-1 shrink-0 text-faint" />
        <input
          value={adding}
          maxLength={MAX_OPTION}
          aria-label="Add an option"
          placeholder="Add an option"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          onBlur={add}
          className="h-6 min-w-0 flex-1 rounded px-1 text-[13px] outline-none placeholder:text-faint hover:bg-hover focus:bg-hover"
        />
      </div>
    </div>
  )
}
