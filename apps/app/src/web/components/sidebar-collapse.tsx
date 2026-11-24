import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { SidebarSimpleIcon } from "@phosphor-icons/react"

/**
 * The desktop sidebar can collapse out of the way (a board gets the whole
 * window), the way Notion, Linear and Attio do it: a panel button in the
 * sidebar's header, ⌘\ from anywhere, and once collapsed, the same button at
 * the page's top-left. Hovering that button or the window's left edge "peeks"
 * the sidebar over the page; it slides away when the pointer leaves.
 * Remembered per browser. Small screens keep their drawer.
 */

const KEY = "standard-artifacts.sidebar"
/** Delay before a peek opens (so passing the edge doesn't flash it) and before it closes (so a sloppy exit doesn't drop it). */
const OPEN_DELAY = 90
const CLOSE_DELAY = 260

type SidebarState = {
  readonly collapsed: boolean
  readonly toggle: () => void
  readonly peeking: boolean
  /** Hover intent on a peek trigger (the left edge, the toggle) or on the peek itself. */
  readonly hoverPeek: (inside: boolean) => void
  readonly closePeek: () => void
}

const Ctx = createContext<SidebarState | null>(null)

export function useSidebar() {
  const s = useContext(Ctx)
  if (!s) throw new Error("useSidebar outside SidebarProvider")
  return s
}

const read = () => {
  try {
    return localStorage.getItem(KEY) === "collapsed"
  } catch {
    return false
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(read)
  const [peeking, setPeeking] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const closePeek = useCallback(() => {
    clearTimeout(timer.current)
    setPeeking(false)
  }, [])

  const toggle = useCallback(() => {
    clearTimeout(timer.current)
    setPeeking(false)
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? "open" : "collapsed")
      } catch {
        // Private mode: it just isn't remembered.
      }
      return !c
    })
  }, [])

  const hoverPeek = useCallback((inside: boolean) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setPeeking(inside), inside ? OPEN_DELAY : CLOSE_DELAY)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  // ⌘\ / Ctrl+\ from anywhere, editors included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === "\\") {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])

  const value = useMemo(() => ({ collapsed, toggle, peeking: collapsed && peeking, hoverPeek, closePeek }), [collapsed, toggle, peeking, hoverPeek, closePeek])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const toggleShortcut = () => (typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘\\" : "Ctrl+\\")

/**
 * The panel button. In the sidebar's header it collapses the sidebar; on the
 * page (only while collapsed, desktop only) it peeks on hover and opens on click.
 */
export function SidebarToggle({ placement, className = "" }: { placement: "sidebar" | "page"; className?: string }) {
  const { collapsed, toggle, hoverPeek } = useSidebar()
  if (placement === "page" && !collapsed) return null
  const label = collapsed ? "Open sidebar" : "Collapse sidebar"
  const hover = placement === "page" ? { onPointerEnter: () => hoverPeek(true), onPointerLeave: () => hoverPeek(false) } : {}
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts="Meta+Backslash Control+Backslash"
      aria-expanded={!collapsed}
      title={`${label} (${toggleShortcut()})`}
      data-sidebar-toggle={placement}
      onClick={toggle}
      {...hover}
      className={`${placement === "page" ? "hidden md:grid" : "grid"} size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text ${className}`}
    >
      <SidebarSimpleIcon size={17} />
    </button>
  )
}
