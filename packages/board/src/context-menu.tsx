import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react"

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export type MenuItem = {
  readonly label: string
  readonly icon?: ReactNode
  /** Muted, at the row's end: a shortcut. */
  readonly hint?: string
  /** Set (true or false) on rows that pick one of several: a check shows on the current one. */
  readonly checked?: boolean
  readonly disabled?: boolean
  readonly danger?: boolean
  readonly run?: () => void
  /** Makes the row open a submenu. */
  readonly items?: ReadonlyArray<MenuEntry>
}
export type MenuEntry = MenuItem | "-"

/** Separators only between things: conditional rows can leave them doubled or at an end. */
export function tidy(entries: ReadonlyArray<MenuEntry>): ReadonlyArray<MenuEntry> {
  const out: Array<MenuEntry> = []
  for (const e of entries) if (e !== "-" || (out.length && out.at(-1) !== "-")) out.push(e)
  if (out.at(-1) === "-") out.pop()
  return out
}

/** Pointer at rest this long over a row before submenus change, so crossing rows on the way into one doesn't switch it. */
const OPEN_MS = 90
const SWITCH_MS = 160
const MARGIN = 8

type Open = { readonly index: number; readonly anchor: DOMRect }

/**
 * A menu at a point, with submenus. In a portal: a canvas clips, and the menu
 * belongs over the whole window. React events still bubble to the canvas through
 * the portal, so the wrapper stops them all.
 *
 * Focus is the highlight: moving over a row focuses it, so keyboard and pointer
 * can't disagree about which row is current.
 */
export function ContextMenu({ x, y, entries, keyboard, label, onClose }: { x: number; y: number; entries: ReadonlyArray<MenuEntry>; keyboard?: boolean; label: string; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const [path, setPath] = useState<ReadonlyArray<Open>>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The level whose first row takes focus once it's measured (a submenu opened from the keyboard). */
  const focusFirst = useRef<number | null>(keyboard ? 0 : null)

  const later = (ms: number, f: () => void) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(f, ms)
  }
  const cancel = () => clearTimeout(timer.current)
  useEffect(() => () => clearTimeout(timer.current), [])

  useEffect(() => {
    const away = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      // Normally the rows handle this; it's for when focus has ended up elsewhere.
      if (e.key === "Escape" && !root.current?.contains(document.activeElement)) onClose()
    }
    document.addEventListener("pointerdown", away, true)
    // The canvas would pan or zoom out from under the menu.
    document.addEventListener("wheel", away, { capture: true, passive: true })
    document.addEventListener("keydown", key, true)
    window.addEventListener("blur", onClose)
    window.addEventListener("resize", onClose)
    return () => {
      document.removeEventListener("pointerdown", away, true)
      document.removeEventListener("wheel", away, { capture: true })
      document.removeEventListener("keydown", key, true)
      window.removeEventListener("blur", onClose)
      window.removeEventListener("resize", onClose)
    }
  }, [onClose])

  /** The entries shown at each level: the menu, then each open submenu. */
  const levels: Array<ReadonlyArray<MenuEntry>> = [entries]
  for (const open of path) {
    const entry = levels.at(-1)?.[open.index]
    if (!entry || entry === "-" || !entry.items) break
    levels.push(entry.items)
  }

  const openSub = (level: number, index: number, el: HTMLElement, focus: boolean) => {
    cancel()
    if (focus) focusFirst.current = level + 1
    setPath((p) => [...p.slice(0, level), { index, anchor: el.getBoundingClientRect() }])
  }

  const panelAt = (level: number) => root.current?.querySelector<HTMLElement>(`[data-menu-level="${level}"]`)
  const rowsOf = (panel: HTMLElement | null | undefined) => [...(panel?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const panel = (e.target as Element).closest<HTMLElement>("[data-menu-level]")
    if (!panel) return
    const level = Number(panel.dataset.menuLevel)
    const rows = rowsOf(panel)
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    const go = (i: number) => rows[(i + rows.length) % rows.length]?.focus({ preventScroll: false })
    const back = () => {
      cancel()
      const trigger = panelAt(level - 1)?.querySelector<HTMLElement>(`[data-menu-index="${path[level - 1]?.index}"]`)
      setPath((p) => p.slice(0, level - 1))
      trigger?.focus()
    }
    const handled = () => e.preventDefault()
    switch (e.key) {
      case "ArrowDown":
        return handled(), go(at + 1)
      case "ArrowUp":
        return handled(), go(at < 0 ? -1 : at - 1)
      case "Home":
        return handled(), go(0)
      case "End":
        return handled(), go(-1)
      case "ArrowRight": {
        handled()
        const row = rows[at]
        if (row?.getAttribute("aria-haspopup")) openSub(level, Number(row.dataset.menuIndex), row, true)
        return
      }
      case "ArrowLeft":
        handled()
        if (level > 0) back()
        return
      case "Escape":
        handled()
        // A submenu opened by hovering leaves focus on its row: one level at a time, however it was opened.
        if (path.length > level) {
          cancel()
          return setPath((p) => p.slice(0, level))
        }
        return level > 0 ? back() : onClose()
      case "Tab":
        handled()
        return onClose()
    }
    // Typing a letter jumps to the next row starting with it, as native menus do.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
      const key = e.key.toLowerCase()
      const from = at + 1
      const next = [...rows.slice(from), ...rows.slice(0, from)].find((r) => r.dataset.menuLabel?.toLowerCase().startsWith(key))
      if (next) (handled(), next.focus())
    }
  }

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

  return createPortal(
    <div
      ref={root}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onDoubleClick={stop}
      onKeyDown={(e) => (stop(e), onKeyDown(e))}
      onKeyUp={stop}
      onPaste={stop}
      onCopy={stop}
      onCut={stop}
      onContextMenu={(e) => (e.preventDefault(), stop(e))}
    >
      {levels.map((items, level) => (
        <Panel
          key={level === 0 ? "root" : `${level}:${path[level - 1]?.index}`}
          level={level}
          items={items}
          label={label}
          x={x}
          y={y}
          anchor={level > 0 ? path[level - 1]?.anchor : undefined}
          openIndex={path[level]?.index}
          focusFirst={focusFirst}
          onEnter={cancel}
          onRowMove={(index, el, hasItems) => {
            if (document.activeElement !== el) el.focus({ preventScroll: true })
            const current = path[level]?.index
            if (hasItems) {
              if (current === index) {
                cancel()
                if (path.length > level + 1) setPath((p) => p.slice(0, level + 1))
              } else later(current === undefined ? OPEN_MS : SWITCH_MS, () => openSub(level, index, el, false))
            } else if (current !== undefined) later(SWITCH_MS, () => setPath((p) => p.slice(0, level)))
          }}
          onRowClick={(entry, index, el, fromKeyboard) => {
            if (entry.items) return openSub(level, index, el, fromKeyboard)
            onClose()
            entry.run?.()
          }}
        />
      ))}
    </div>,
    document.body,
  )
}

function Panel({
  level,
  items,
  label,
  x,
  y,
  anchor,
  openIndex,
  focusFirst,
  onEnter,
  onRowMove,
  onRowClick,
}: {
  level: number
  items: ReadonlyArray<MenuEntry>
  label: string
  x: number
  y: number
  /** The row this submenu opened from. */
  anchor: DOMRect | undefined
  openIndex: number | undefined
  focusFirst: React.RefObject<number | null>
  onEnter: () => void
  onRowMove: (index: number, el: HTMLElement, hasItems: boolean) => void
  onRowClick: (entry: MenuItem, index: number, el: HTMLElement, fromKeyboard: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const maxLeft = window.innerWidth - w - MARGIN
    const maxTop = window.innerHeight - h - MARGIN
    if (anchor) {
      // Beside the row, its first item level with it; on the other side if there's no room.
      const right = anchor.right - 2
      setAt({
        left: Math.max(MARGIN, right <= maxLeft ? right : anchor.left - w + 2),
        top: Math.max(MARGIN, Math.min(anchor.top - 5, maxTop)),
      })
    } else setAt({ left: Math.max(MARGIN, Math.min(x, maxLeft)), top: Math.max(MARGIN, Math.min(y, maxTop)) })
  }, [x, y, anchor, items.length])

  // Once it's placed, so focusing doesn't scroll an unpositioned panel. The panel itself holds focus until a row is current.
  useEffect(() => {
    if (!at) return
    if (focusFirst.current === level) {
      focusFirst.current = null
      ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
    } else if (level === 0 && !ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at === null])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-menu-level={level}
      onPointerEnter={onEnter}
      style={at ?? { top: 0, left: 0, visibility: "hidden" }}
      className={`fixed z-50 max-h-[calc(100vh-16px)] w-56 overflow-y-auto rounded-lg border border-border bg-bg p-1 text-text shadow-lg outline-none ${level === 0 ? "palette-in" : ""}`}
    >
      {items.map((entry, i) =>
        entry === "-" ? (
          <div key={i} role="separator" className="-mx-1 my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            type="button"
            role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={entry.checked}
            aria-haspopup={entry.items ? "menu" : undefined}
            aria-expanded={entry.items ? openIndex === i : undefined}
            data-menu-index={i}
            data-menu-label={entry.label}
            disabled={entry.disabled}
            onPointerMove={(e) => e.pointerType === "mouse" && onRowMove(i, e.currentTarget, !!entry.items)}
            onPointerLeave={(e) => {
              // Off the row, onto nothing: no row is current (a pointer leaving a native menu clears its highlight too).
              if (document.activeElement === e.currentTarget) ref.current?.focus({ preventScroll: true })
            }}
            // A keyboard "click" has no pointer behind it, so that's how to tell whether to move focus into a submenu.
            onClick={(e) => onRowClick(entry, i, e.currentTarget, e.detail === 0)}
            className={`flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus:bg-hover aria-expanded:bg-hover disabled:pointer-events-none disabled:text-faint ${entry.danger ? "text-danger" : ""}`}
          >
            <span className={`grid size-4 shrink-0 place-items-center ${entry.danger ? "" : "text-muted"}`}>{entry.icon}</span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint && (
              <span aria-hidden className="shrink-0 text-[11px] text-faint">
                {entry.hint}
              </span>
            )}
            {entry.checked && <CheckIcon size={13} weight="bold" className="shrink-0 text-accent" />}
            {entry.items && <CaretRightIcon size={11} weight="bold" className="shrink-0 text-muted" />}
          </button>
        ),
      )}
    </div>
  )
}
