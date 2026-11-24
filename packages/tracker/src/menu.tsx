import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { CheckIcon } from "@phosphor-icons/react"

export type MenuOption<V> = { value: V; label: string; icon?: ReactNode; hint?: string; section?: string }

/**
 * A property picker (Linear-style): a trigger that opens a small list right
 * under it. Arrow keys move, Enter picks, Escape or a press elsewhere closes.
 * Typing filters when there are more than a handful of options.
 */
export function PropertyMenu<V>({
  label,
  value,
  options,
  onChange,
  disabled,
  children,
  className = "",
  equals = (a, b) => a === b,
}: {
  /** Accessible name of the trigger, e.g. "Status". */
  label: string
  value: V
  options: ReadonlyArray<MenuOption<V>>
  onChange: (value: V) => void
  disabled?: boolean
  children: ReactNode
  className?: string
  equals?: (a: V, b: V) => boolean
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className={`flex items-center gap-1.5 rounded-md text-left transition-colors enabled:hover:bg-hover disabled:cursor-default ${className}`}
      >
        {children}
      </button>
      {open && trigger.current && (
        <MenuList
          label={label}
          anchor={trigger.current}
          options={options}
          isSelected={(v) => equals(v, value)}
          onPick={(v) => {
            setOpen(false)
            trigger.current?.focus()
            if (!equals(v, value)) onChange(v)
          }}
          onClose={() => {
            setOpen(false)
            trigger.current?.focus()
          }}
        />
      )}
    </>
  )
}

function MenuList<V>({
  label,
  anchor,
  options,
  isSelected,
  onPick,
  onClose,
}: {
  label: string
  anchor: HTMLElement
  options: ReadonlyArray<MenuOption<V>>
  isSelected: (v: V) => boolean
  onPick: (v: V) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const searchable = options.length > 6
  const shown = query ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())) : options
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => isSelected(o.value))))
  const list = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const h = list.current?.offsetHeight ?? 240
    const w = list.current?.offsetWidth ?? 220
    const below = r.bottom + 4 + h <= window.innerHeight - 8
    setAt({ left: Math.min(r.left, window.innerWidth - w - 8), top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - h) })
  }, [anchor])

  useEffect(() => {
    if (!searchable) list.current?.focus()
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    window.addEventListener("pointerdown", away, true)
    return () => window.removeEventListener("pointerdown", away, true)
  }, [anchor, onClose, searchable])

  useEffect(() => setActive((a) => Math.min(a, Math.max(0, shown.length - 1))), [shown.length])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, shown.length - 1))
    else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0))
    else if (e.key === "Enter" && shown[active]) onPick(shown[active].value)
    else if (e.key === "Escape") onClose()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return createPortal(
    <div
      ref={list}
      role="listbox"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKey}
      style={{ left: at?.left ?? -9999, top: at?.top ?? -9999 }}
      className="fixed z-50 max-h-[320px] w-[220px] overflow-y-auto rounded-lg border border-border bg-bg p-1 text-[13px] shadow-[0_8px_30px_rgb(0_0_0/0.12)] outline-none"
    >
      {searchable && (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`${label}…`}
          aria-label={`Filter ${label.toLowerCase()}`}
          className="mb-1 h-7 w-full rounded-md border border-border bg-surface px-2 text-[13px] outline-none placeholder:text-faint"
        />
      )}
      {shown.map((o, i) => (
        <div key={i}>
          {o.section && o.section !== shown[i - 1]?.section && <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-faint">{o.section}</div>}
          <div
            role="option"
            aria-selected={isSelected(o.value)}
            onPointerEnter={() => setActive(i)}
            onClick={() => onPick(o.value)}
            className={`flex h-8 cursor-default items-center gap-2 rounded-md px-2 ${i === active ? "bg-hover" : ""}`}
          >
            {o.icon}
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.hint && <span className="text-[12px] text-faint">{o.hint}</span>}
            {isSelected(o.value) && <CheckIcon size={14} className="text-muted" />}
          </div>
        </div>
      ))}
      {!shown.length && <div className="px-2 py-1.5 text-faint">No matches</div>}
    </div>,
    document.body,
  )
}
