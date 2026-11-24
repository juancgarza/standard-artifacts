import { Activity, useCallback, useEffect, useState } from "react"
import { Outlet, useRouterState } from "@tanstack/react-router"
import { ListIcon, XIcon } from "@phosphor-icons/react"
import { kindFromSlug } from "@standard-artifacts/protocol"
import { useWorkspace } from "../workspace"
import { isArtifact, TabsProvider, useTabs } from "../tabs"
import { routeOf, type Tab } from "../tabs-model"
import { ArtifactPage } from "../pages/artifact"
import { Sidebar } from "./sidebar"
import { CommandPalette } from "./command-palette"
import { MobileTabs } from "./mobile-tabs"
import { SidebarProvider, SidebarToggle, useSidebar } from "./sidebar-collapse"
import { TabStrip } from "./tab-strip"

export function Shell() {
  return (
    <SidebarProvider>
      <TabsProvider>
        <Layout />
      </TabsProvider>
    </SidebarProvider>
  )
}

/**
 * Artifact pages render here rather than through the router's outlet, one per
 * recently active tab. Hidden ones keep their state (a board's camera, what's
 * scrolled, an open issue) while <Activity> cleans up their effects, which closes
 * their room's socket and clears their presence: nobody sees you on a page you left.
 */
function KeptPage({ tab, active }: { tab: Tab; active: boolean }) {
  const route = routeOf(tab.href)
  if (!isArtifact(route)) return null
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <div className="h-full overflow-y-auto">
        <ArtifactPage slug={route.slug} id={route.id} item={route.item} />
      </div>
    </Activity>
  )
}

function Pages() {
  const { tabs, kept, activeId } = useTabs()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const current = tabs.find((t) => t.id === activeId)
  const onArtifact = current ? isArtifact(routeOf(current.href)) : false
  return (
    <div className="relative min-h-0 flex-1">
      {/* Artifact pages put the toggle in their header; Home has none, so it floats in the corner. */}
      {pathname === "/" && <SidebarToggle placement="page" className="absolute top-3 left-3 z-10" />}
      <div data-tab-links className={onArtifact ? "hidden" : "h-full overflow-y-auto"}>
        <Outlet />
      </div>
      {kept.map((tab) => (
        <KeptPage key={tab.id} tab={tab} active={tab.id === activeId} />
      ))}
    </div>
  )
}

function Layout() {
  const { collapsed, peeking, hoverPeek, closePeek } = useSidebar()
  const [drawer, setDrawer] = useState(false)
  const [palette, setPalette] = useState(false)
  const { status, error, artifacts, recordVisit } = useWorkspace()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // ⌘K / Ctrl+K opens search from anywhere, including inside editors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Remember what this viewer opens, so "Recent" means recent to them.
  const [, slug, id] = pathname.split("/")
  const visited = slug && id && kindFromSlug(slug) && artifacts.some((a) => a.id === id) ? id : null
  useEffect(() => {
    if (visited) recordVisit(visited)
  }, [visited, recordVisit])

  const openSearch = useCallback(() => {
    setDrawer(false)
    closePeek()
    setPalette(true)
  }, [closePeek])

  return (
    <div className="flex h-full">
      {/* The column animates its width; the sidebar inside keeps its own, so its rows don't reflow while it slides. */}
      <aside
        data-sidebar={collapsed ? "collapsed" : "open"}
        inert={collapsed}
        style={{ width: collapsed ? 0 : 248 }}
        className={`hidden shrink-0 overflow-hidden border-border transition-[width,border-width] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none md:block ${collapsed ? "border-r-0" : "border-r"}`}
      >
        <div className="h-full w-[248px]">
          <Sidebar collapsible onSearch={openSearch} />
        </div>
      </aside>

      {collapsed && (
        <>
          {/* Hover the window's left edge to peek (not while dragging something, e.g. on a board). */}
          <div
            aria-hidden
            data-sidebar-edge
            className="fixed inset-y-0 left-0 z-30 hidden w-2 md:block"
            onPointerEnter={(e) => e.buttons === 0 && hoverPeek(true)}
            onPointerLeave={() => hoverPeek(false)}
          />
          <aside
            data-sidebar-peek={peeking ? "open" : "closed"}
            inert={!peeking}
            onPointerEnter={() => hoverPeek(true)}
            onPointerLeave={() => hoverPeek(false)}
            style={{ translate: peeking ? "0 0" : "calc(-100% - 16px) 0", opacity: peeking ? 1 : 0 }}
            className="fixed top-2 bottom-2 left-2 z-40 hidden w-[248px] overflow-hidden rounded-lg border border-border shadow-[0_8px_30px_rgb(0_0_0/0.12)] transition-[translate,opacity] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none md:block"
          >
            <Sidebar collapsible onNavigate={closePeek} onSearch={openSearch} />
          </aside>
        </>
      )}

      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-border shadow-xl">
            <Sidebar onNavigate={() => setDrawer(false)} onSearch={openSearch} />
          </aside>
        </div>
      )}

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center border-b border-border px-4 md:hidden">
          <button
            type="button"
            aria-label={drawer ? "Close menu" : "Open menu"}
            onClick={() => setDrawer((d) => !d)}
            className="-ml-1.5 grid size-8 place-items-center rounded-md hover:bg-hover"
          >
            {drawer ? <XIcon size={18} /> : <ListIcon size={18} />}
          </button>
          <MobileTabs />
        </div>
        {error && status === "ready" && (
          <div className="border-b border-border bg-surface px-4 py-2 text-[13px] text-danger">{error}</div>
        )}
        <TabStrip />
        {status === "error" ? <div className="p-8 text-danger">{error}</div> : <Pages />}
      </main>

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  )
}
