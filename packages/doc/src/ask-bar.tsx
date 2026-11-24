import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ArrowUpIcon, CaretLeftIcon, CircleNotchIcon, SparkleIcon, TranslateIcon } from "@phosphor-icons/react"
import { editActions, languages, replyActions, type QuickAction } from "./ai"

export type AskContext = { kind: "selection"; count: number } | { kind: "doc" }

/**
 * The inline "Ask Claude" bar, anchored under a block or a selection. Typing a
 * request and pressing Enter sends it; with an empty input, Enter runs the
 * highlighted quick action. Arrow keys move through the actions, Esc closes.
 */
export function AskBar({
  context,
  cover,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  context: AskContext
  /** Sit on the anchor block instead of below it (the empty line the person pressed Space on). */
  cover: boolean
  busy: boolean
  error: string | null
  onSubmit: (prompt: string) => void
  /** `restoreCaret`: Esc puts the caret back where it was; a click elsewhere leaves it where the click went. */
  onClose: (restoreCaret: boolean) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  // -1 means "send what I typed"; an empty input starts on the first action so Enter does something.
  const [active, setActive] = useState(0)
  const [picking, setPicking] = useState<QuickAction | null>(null)

  const actions = context.kind === "selection" ? editActions : replyActions
  const q = query.trim().toLowerCase()
  const items = useMemo(() => {
    const all: ReadonlyArray<{ id: string; label: string; action?: QuickAction }> = picking
      ? languages.map((l) => ({ id: l, label: l }))
      : actions.map((a) => ({ id: a.id, label: a.label, action: a }))
    return q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all
  }, [actions, picking, q])

  useEffect(() => {
    input.current?.focus()
    root.current?.scrollIntoView({ block: "nearest" })
  }, [])

  // Clicking anywhere else closes the bar, like a popover.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) onClose(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [onClose])

  const choose = (item: { label: string; action?: QuickAction }) => {
    if (item.action?.pickLanguage) {
      setPicking(item.action)
      setQuery("")
      setActive(0)
      return input.current?.focus()
    }
    if (picking) return onSubmit(`${picking.prompt} ${item.label}.`)
    if (item.action) onSubmit(item.action.prompt)
  }

  const submitTyped = () => {
    const text = query.trim()
    if (!text) return
    // While picking a language, what's typed is the language ("Translate to Catalan").
    onSubmit(picking ? `${picking.prompt} ${text}.` : text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const n = items.length
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!n) return
      // Cycle through "typed text" (-1, only when there is some) and the actions.
      const floor = q ? -1 : 0
      const span = n - floor
      const next = ((active - floor + (e.key === "ArrowDown" ? 1 : -1) + span) % span) + floor
      return setActive(next)
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (busy) return
      const item = active >= 0 ? items[active] : undefined
      return item ? choose(item) : submitTyped()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      if (picking) {
        setPicking(null)
        setQuery("")
        return setActive(0)
      }
      return onClose(true)
    }
    if (e.key === "Backspace" && query === "" && picking) {
      e.preventDefault()
      setPicking(null)
      setActive(0)
    }
  }

  const chip = context.kind === "selection" ? `${context.count} block${context.count === 1 ? "" : "s"} selected` : "This doc"
  const placeholder = picking ? "Translate to which language?" : context.kind === "selection" ? "Ask Claude to edit the selection…" : "Ask Claude anything…"

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Ask Claude"
      className={`absolute right-0 left-3 z-30 ${cover ? "-top-1.5" : "top-full mt-1"}`}
      // Clicks inside keep focus in the input.
      onMouseDown={(e) => e.target !== input.current && e.preventDefault()}
    >
      <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-bg px-3 py-2 shadow-lg ring-4 ring-accent/10">
        <SparkleIcon size={16} weight="fill" className="shrink-0 text-accent" />
        {picking && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[12px] text-muted">
            <TranslateIcon size={12} /> Translate
          </span>
        )}
        <input
          ref={input}
          value={query}
          disabled={busy}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(e.target.value.trim() ? -1 : 0)
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Ask Claude"
          aria-controls="doc-ask-actions"
          aria-activedescendant={active >= 0 && items[active] ? `doc-ask-${items[active].id}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
        />
        <span data-ask-context className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted">
          {chip}
        </span>
        <button
          type="button"
          aria-label="Send"
          title="Send (↵)"
          disabled={busy || !query.trim()}
          onClick={submitTyped}
          className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-accent-text transition-opacity disabled:opacity-30"
        >
          {busy ? <CircleNotchIcon size={14} className="animate-spin" /> : <ArrowUpIcon size={14} weight="bold" />}
        </button>
      </div>
      {error && <div className="mt-1 rounded-md bg-bg px-3 py-1.5 text-[12px] text-danger shadow">{error}</div>}
      {items.length > 0 && !busy && (
        <div id="doc-ask-actions" role="listbox" aria-label="Claude actions" className="mt-1 w-72 rounded-lg border border-border bg-bg p-1 shadow-lg">
          <div className="flex items-center gap-1 px-2 pt-1 pb-1.5 text-[11px] font-medium text-faint">
            {picking ? (
              <>
                <CaretLeftIcon size={11} /> Translate to
              </>
            ) : context.kind === "selection" ? (
              "Edit selection"
            ) : (
              "Write with Claude"
            )}
          </div>
          {items.map((item, i) => {
            const ItemIcon = "action" in item && item.action ? item.action.icon : TranslateIcon
            return (
              <div
                key={item.id}
                id={`doc-ask-${item.id}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(item)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[14px] ${i === active ? "bg-hover" : ""}`}
              >
                <ItemIcon size={16} className="shrink-0 text-accent" />
                <span className="flex-1 truncate">{item.label}</span>
              </div>
            )
          })}
          <div className="mt-1 border-t border-border px-2 pt-1.5 pb-1 text-[11px] text-faint">↵ to run · ↑↓ to choose · esc to close</div>
        </div>
      )}
    </div>
  )
}
