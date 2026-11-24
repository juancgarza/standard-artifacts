import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArchiveIcon, CaretDownIcon, FolderIcon, GearSixIcon, HouseIcon, PlusIcon, ProhibitIcon, XIcon } from "@phosphor-icons/react"
import { altKey, useTabs, type TabMeta } from "../tabs"
import type { Tab } from "../tabs-model"
import { useWorkspace } from "../workspace"
import { KindIcon } from "./kind-icon"

export function TabIcon({ kind, size = 15 }: { kind: TabMeta["kind"]; size?: number }) {
  switch (kind) {
    case "home":
      return <HouseIcon size={size} className="shrink-0 text-muted" />
    case "archived":
      return <ArchiveIcon size={size} className="shrink-0 text-muted" />
    case "settings":
      return <GearSixIcon size={size} className="shrink-0 text-muted" />
    case "folder":
      return <FolderIcon size={size} weight="duotone" className="shrink-0 text-muted" />
    case "gone":
      return <ProhibitIcon size={size} className="shrink-0 text-faint" />
    default:
      return <KindIcon kind={kind} size={size} />
  }
}

const DRAG_THRESHOLD = 4

/**
 * The strip over the page. Always there, even with one tab, because it's how people
 * find out tabs exist and its + is how a mouse opens one. Share-link guests have one
 * artifact, so no strip. It's in place while loading, so the page doesn't shift down
 * after. Tabs select on press, like a browser's, and a press that travels becomes a
 * drag that trades places with its neighbours.
 */
export function TabStrip() {
  const { enabled, tabs, activeId, meta, select, closeTab, swapTabs, openAndGo, showTabMenu, showMenu } = useTabs()
  const { status, principal } = useWorkspace()
  const show = status !== "error" && !principal?.scope
  const scroller = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  // Closing with the pointer on the strip keeps widths, so the next × lands under it. Released on leaving.
  const [frozen, setFrozen] = useState<number | null>(null)
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])

  const order = useRef(tabs)
  order.current = tabs

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs.length, frozen, show])

  // Keep the active tab in view, moving only the strip: scrollIntoView could also scroll the page.
  useLayoutEffect(() => {
    const el = scroller.current
    const tab = el?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)
    if (!el || !tab) return
    const box = el.getBoundingClientRect()
    const t = tab.getBoundingClientRect()
    if (t.left < box.left) el.scrollLeft -= box.left - t.left
    else if (t.right > box.right) el.scrollLeft += t.right - box.right
  }, [activeId, tabs.length, show])

  const beginDrag = (e: React.PointerEvent, tab: Tab) => {
    if (e.button !== 0) return
    select(tab.id)
    const startX = e.clientX
    const el = e.currentTarget as HTMLElement
    const grab = startX - el.getBoundingClientRect().left
    const group = el.parentElement!
    let moving = false

    const onMove = (m: PointerEvent) => {
      if (!moving && Math.abs(m.clientX - startX) < DRAG_THRESHOLD) return
      if (!moving) {
        moving = true
        el.dataset.dragging = "true"
      }
      // Trade places once the pointer passes a neighbour's middle. The element survives, keyed by id.
      const peers = order.current.filter((t) => t.pinned === tab.pinned)
      const at = peers.findIndex((t) => t.id === tab.id)
      const centre = (id: string | undefined) => {
        const r = id ? group.querySelector(`[data-tab-id="${id}"]`)?.getBoundingClientRect() : undefined
        return r ? r.left + r.width / 2 : null
      }
      const next = centre(peers[at + 1]?.id)
      const prev = centre(peers[at - 1]?.id)
      if (next !== null && m.clientX > next) swapTabs(tab.id, peers[at + 1]!.id)
      else if (prev !== null && m.clientX < prev) swapTabs(tab.id, peers[at - 1]!.id)

      requestAnimationFrame(() => {
        if (!el.dataset.dragging) return
        el.style.transform = ""
        const home = el.getBoundingClientRect()
        const bounds = group.getBoundingClientRect()
        const left = Math.max(bounds.left, Math.min(m.clientX - grab, bounds.right - home.width))
        el.style.transform = `translateX(${left - home.left}px)`
      })
    }
    const stop = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      stopDrag.current = null
      delete el.dataset.dragging
      el.style.transform = ""
    }
    stopDrag.current = stop
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
  }

  const onArrowKeys = (e: React.KeyboardEvent, tab: Tab) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const at = tabs.findIndex((t) => t.id === tab.id)
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]!
    select(next.id)
    document.querySelector<HTMLElement>(`[data-tab-id="${next.id}"] [role="tab"]`)?.focus()
  }

  const closeWithPointer = (e: React.MouseEvent, tab: Tab) => {
    e.stopPropagation()
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-tab-id]")
    if (row && !tab.pinned) setFrozen(row.getBoundingClientRect().width)
    closeTab(tab.id)
  }

  const renderTab = (tab: Tab) => {
    const info = meta(tab.href)
    const active = tab.id === activeId
    return <TabItem key={tab.id} tab={tab} info={info} active={active} closable={tabs.length > 1} frozen={frozen} onPointerDown={beginDrag} onArrowKeys={onArrowKeys} onClose={closeWithPointer} onMenu={showTabMenu} onMiddleClose={closeTab} />
  }

  const pinned = tabs.filter((t) => t.pinned)
  const rest = tabs.filter((t) => !t.pinned)

  return (
    <div
      data-tab-strip={show ? "open" : "closed"}
      inert={!enabled}
      onPointerLeave={() => setFrozen(null)}
      className={`hidden shrink-0 items-end gap-0.5 overflow-hidden border-border bg-surface px-1.5 md:flex ${show ? "h-9 border-b" : "h-0 border-b-0"}`}
    >
      {pinned.length > 0 && (
        <>
          <div role="tablist" aria-label="Pinned tabs" className="flex h-full shrink-0 items-end gap-0.5">
            {pinned.map(renderTab)}
          </div>
          <div aria-hidden className="mx-1 mb-2.5 h-4 w-px shrink-0 bg-border" />
        </>
      )}
      <div
        ref={scroller}
        role="tablist"
        aria-label="Open tabs"
        onWheel={(e) => {
          if (scroller.current && e.deltaY !== 0 && e.deltaX === 0) scroller.current.scrollLeft += e.deltaY
        }}
        className="flex h-full min-w-0 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {rest.map(renderTab)}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title={`New tab (${altKey("T")})`}
        onClick={() => openAndGo("/")}
        className="mb-[3px] ml-0.5 grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
      >
        <PlusIcon size={14} />
      </button>
      <div className="min-w-0 flex-1" />
      {overflowing && (
        <button
          type="button"
          aria-label="All open tabs"
          title="All open tabs"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            showMenu(
              r.right - 240,
              r.bottom + 4,
              tabs.map((t) => {
                const info = meta(t.href)
                return { label: info.title, icon: <TabIcon kind={info.kind} />, ...(t.id === activeId && { hint: "Current" }), run: () => select(t.id) }
              }),
            )
          }}
          className="mb-[3px] flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
        >
          {tabs.length}
          <CaretDownIcon size={10} weight="bold" />
        </button>
      )}
    </div>
  )
}

function TabItem({
  tab,
  info,
  active,
  closable,
  frozen,
  onPointerDown,
  onArrowKeys,
  onClose,
  onMenu,
  onMiddleClose,
}: {
  tab: Tab
  info: TabMeta
  active: boolean
  /** The last tab stays: closing it would leave no page. */
  closable: boolean
  frozen: number | null
  onPointerDown: (e: React.PointerEvent, tab: Tab) => void
  onArrowKeys: (e: React.KeyboardEvent, tab: Tab) => void
  onClose: (e: React.MouseEvent, tab: Tab) => void
  onMenu: (tab: Tab, x: number, y: number) => void
  onMiddleClose: (id: string) => void
}) {
  const { flashId, select } = useTabs()
  const flash = flashId === tab.id
  const gone = info.kind === "gone"

  return (
    <div
      data-tab-id={tab.id}
      data-active={active || undefined}
      data-pinned={tab.pinned || undefined}
      title={info.title}
      onPointerDown={(e) => onPointerDown(e, tab)}
      onAuxClick={(e) => {
        if (e.button === 1 && !tab.pinned && closable) onMiddleClose(tab.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(tab, e.clientX, e.clientY)
      }}
      style={frozen !== null && !tab.pinned ? { flex: "none", width: frozen } : undefined}
      className={`group relative -mb-px flex touch-none items-center rounded-t-[7px] border border-b-0 text-[13px] select-none data-[dragging]:z-10 data-[dragging]:cursor-grabbing data-[dragging]:rounded-[7px] data-[dragging]:bg-bg data-[dragging]:text-text data-[dragging]:shadow-lg ${
        tab.pinned ? "w-[34px] shrink-0 justify-center" : "w-[200px] min-w-[120px] flex-[0_1_200px] pr-1.5"
      } ${active ? "z-[1] h-8 border-border bg-bg text-text" : `h-[31px] border-transparent hover:bg-hover hover:text-text ${gone ? "text-faint" : "text-muted"}`} ${flash ? "tab-flash" : ""}`}
    >
      {/* Selected on press (see the strip); a click with no pointer press behind it is the keyboard. */}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={info.title}
        tabIndex={active ? 0 : -1}
        onClick={(e) => {
          if (e.detail === 0) select(tab.id)
        }}
        onKeyDown={(e) => onArrowKeys(e, tab)}
        className={`flex h-full min-w-0 flex-1 cursor-default items-center gap-[7px] rounded-t-[7px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${tab.pinned ? "justify-center" : "pl-2.5"}`}
      >
        <TabIcon kind={info.kind} />
        {!tab.pinned && <span className="min-w-0 flex-1 truncate text-left">{info.title}</span>}
      </button>
      {!tab.pinned && closable && (
        <button
          type="button"
          aria-label={`Close ${info.title}`}
          title={`Close (${altKey("W")})`}
          tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => onClose(e, tab)}
          className={`size-5 shrink-0 place-items-center rounded-[5px] text-muted hover:bg-active hover:text-text ${active ? "grid" : "hidden group-hover:grid"}`}
        >
          <XIcon size={11} weight="bold" />
        </button>
      )}
    </div>
  )
}
