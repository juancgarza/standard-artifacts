import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter, useRouterState } from "@tanstack/react-router"
import { actorKey, kinds, type ArtifactKind, type DesktopBridge } from "@standard-artifacts/protocol"
import { useWorkspace } from "./workspace"
import * as model from "./tabs-model"
import type { SavedTab, Tab, TabRoute, TabsState } from "./tabs-model"
import { ContextMenu, type MenuEntry } from "./components/context-menu"
import { folderDeleteMessage } from "./components/folder-menu"
import { artifactDeleteMessage } from "./components/header-menu"

/**
 * Tabs in the shell. The URL is always the active tab, so sharing and reload work
 * as they did. The set belongs to the viewer and to this browser window (session
 * storage); a new window starts from the last set saved by any window (local
 * storage). Only hrefs are stored. Share-link guests have one artifact, so no tabs.
 */

const FLASH_MS = 700

export type TabMeta = { readonly title: string; readonly kind: ArtifactKind | "home" | "archived" | "settings" | "folder" | "gone" }

type Tabs = {
  /** Off for share-link guests and until the workspace has loaded. */
  readonly enabled: boolean
  readonly tabs: ReadonlyArray<Tab>
  readonly activeId: string | null
  /** Tabs whose artifact pages stay mounted, hidden, so they come back as they were left. */
  readonly kept: ReadonlyArray<Tab>
  readonly flashId: string | null
  readonly isOpen: (href: string) => boolean
  readonly meta: (href: string) => TabMeta
  readonly select: (id: string) => void
  readonly closeTab: (id: string) => void
  readonly togglePin: (id: string) => void
  readonly swapTabs: (a: string, b: string) => void
  /** Opens beside the current tab without leaving it (⌘-click). A page already open just flashes its tab. */
  readonly openInBackground: (href: string) => void
  readonly openAndGo: (href: string) => void
  readonly showTabMenu: (tab: Tab, x: number, y: number) => void
  readonly showMenu: (x: number, y: number, entries: ReadonlyArray<MenuEntry>) => void
}

const Ctx = createContext<Tabs | null>(null)

export function useTabs() {
  const tabs = useContext(Ctx)
  if (!tabs) throw new Error("useTabs outside TabsProvider")
  return tabs
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform)

/** Label for a tab shortcut: ⌥W on a Mac, Alt+W elsewhere. */
export const altKey = (key: string) => (isMac() ? `⌥${key}` : `Alt+${key}`)

/**
 * Whether ⌥ here produces a real character on this keyboard: on a Spanish Mac, the
 * key we'd read as ⌥[ types "[". US Macs produce symbols like † and “ that nobody
 * reaches for mid-sentence, but ASCII and dead keys are how people type, so they win.
 */
const typesCharacter = (e: KeyboardEvent) => isMac() && (e.key === "Dead" || (e.key.length === 1 && e.key.charCodeAt(0) < 128))

const isSaved = (v: unknown): v is SavedTab[] =>
  Array.isArray(v) && v.every((t) => typeof t === "object" && t !== null && typeof (t as SavedTab).href === "string" && (t as SavedTab).href.startsWith("/") && typeof (t as SavedTab).pinned === "boolean")

function readSaved(storage: () => Storage, key: string): SavedTab[] | null {
  try {
    const raw = storage().getItem(key)
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    return isSaved(v) ? v : null
  } catch {
    return null
  }
}

function writeSaved(storage: () => Storage, key: string, value: string) {
  try {
    storage().setItem(key, value)
  } catch {
    // Per-viewer convenience only.
  }
}

const session = () => sessionStorage
const local = () => localStorage

/** An in-app page behind this anchor, as an href, or null for anything the browser should handle itself. */
function appHref(a: HTMLAnchorElement): string | null {
  if (a.origin !== window.location.origin || a.hasAttribute("download")) return null
  if (a.target && a.target !== "_self") return null
  if (a.pathname.startsWith("/api/")) return null
  return normalize(a.pathname + a.search + a.hash)
}

const normalize = (href: string) => (href.length > 1 ? href.replace(/\/(?=$|[?#])/, "") : href)

const anchorAt = (target: EventTarget | null) => {
  // A button inside a link (the star on a card) keeps its own click.
  if (!(target instanceof Element) || target.closest("button")) return null
  return target.closest<HTMLAnchorElement>("a[href]")
}

const openInBrowser = (href: string) => void window.open(href, "_blank", "noopener")

/** Inside the desktop app, whose menus can have the ⌘T and ⌘W a browser keeps for itself. */
const desktop = (window as { standardArtifactsDesktop?: DesktopBridge }).standardArtifactsDesktop

export function TabsProvider({ children }: { children: ReactNode }) {
  const { status, principal, artifacts, folders, editable, archive, remove, removeFolder, fail } = useWorkspace()
  const router = useRouter()
  const location = useRouterState({ select: (s) => s.location.href })
  const href = normalize(location)

  const viewer = principal ? `${principal.orgId}:${actorKey(principal.actor)}` : null
  const enabled = status === "ready" && !!principal && !principal.scope

  const [state, setState] = useState<TabsState>(model.noTabs)
  const latest = useRef(state)
  const apply = useCallback((next: TabsState) => {
    latest.current = next
    setState(next)
    return next
  }, [])

  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flash = useCallback((id: string) => {
    setFlashId(id)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashId(null), FLASH_MS)
  }, [])
  useEffect(() => () => clearTimeout(flashTimer.current), [])

  const [menu, setMenu] = useState<{ x: number; y: number; entries: ReadonlyArray<MenuEntry> } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  // Load this viewer's tabs. Layout effects, so the strip never paints the previous viewer's set.
  const seen = useRef(href)
  const key = enabled && viewer ? `standard-artifacts:tabs:${viewer}` : null
  const restored = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (status !== "ready") return
    const inWindow = key ? readSaved(session, key) : null
    const saved = inWindow ?? (key ? readSaved(local, key) : null) ?? []
    seen.current = href
    apply(model.restore(saved, href, inWindow !== null))
    restored.current = key
    // `href` is the address at load; later changes go through the rule below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, key, apply])

  // The one rule. Compared against the last address the router showed, not the active tab, so
  // closing a tab (which moves "active" before the router catches up) can't reopen it.
  useLayoutEffect(() => {
    if (status !== "ready" || href === seen.current) return
    seen.current = href
    apply(model.arrive(latest.current, href))
  }, [href, status, apply])

  useEffect(() => {
    // `latest` differs for the one commit where a viewer's tabs were just restored, before they render.
    if (!key || restored.current !== key || latest.current !== state) return
    const value = JSON.stringify(state.tabs.map(({ id, href, pinned }): SavedTab => ({ href, pinned, ...(id === state.activeId && { active: true }) })))
    writeSaved(session, key, value)
    writeSaved(local, key, value)
  }, [key, state])

  // Deleted or archived in this session: its tab goes. The active one waits for the navigation that follows.
  const known = useMemo(() => new Set([...artifacts.map((a) => a.id), ...folders.map((f) => f.id)]), [artifacts, folders])
  const previous = useRef<{ viewer: string | null; known: ReadonlySet<string> } | null>(null)
  const gone = useRef(new Set<string>())
  useEffect(() => {
    if (status !== "ready") return
    if (previous.current?.viewer === viewer) {
      for (const id of previous.current.known) if (!known.has(id)) gone.current.add(id)
    } else gone.current.clear()
    for (const id of known) gone.current.delete(id)
    previous.current = { viewer, known }
    if (gone.current.size === 0) return
    const next = model.prune(latest.current, (h) => {
      const r = model.routeOf(h)
      return (r.type === "artifact" || r.type === "folder") && gone.current.has(r.id)
    })
    if (next !== latest.current) apply(next)
  }, [known, status, viewer, state.activeId, apply])

  const go = useCallback((to: string, replace = false) => {
    if (to === normalize(router.state.location.href)) return
    if (replace) router.history.replace(to)
    else router.history.push(to)
  }, [router])

  /** After closing: if the active tab changed, the address follows, without leaving a closed page in Back. */
  const settle = useCallback(
    (next: TabsState) => {
      const active = next.tabs.find((t) => t.id === next.activeId)
      if (active) go(active.href, true)
    },
    [go],
  )

  const select = useCallback(
    (id: string) => {
      const tab = latest.current.tabs.find((t) => t.id === id)
      if (tab) go(tab.href)
    },
    [go],
  )

  const closeTab = useCallback((id: string) => settle(apply(model.close(latest.current, [id]))), [apply, settle])

  const togglePin = useCallback(
    (id: string) => {
      const tab = latest.current.tabs.find((t) => t.id === id)
      if (tab) apply(model.setPinned(latest.current, id, !tab.pinned))
    },
    [apply],
  )

  const swapTabs = useCallback((a: string, b: string) => void apply(model.swap(latest.current, a, b)), [apply])

  const openInBackground = useCallback(
    (to: string) => {
      const { state: next, id } = model.open(latest.current, normalize(to), false)
      apply(next)
      flash(id)
    },
    [apply, flash],
  )

  const openAndGo = useCallback(
    (to: string) => {
      const target = normalize(to)
      apply(model.open(latest.current, target, true).state)
      go(target)
    },
    [apply, go],
  )

  const showMenu = useCallback((x: number, y: number, entries: ReadonlyArray<MenuEntry>) => setMenu({ x, y, entries }), [])

  const showTabMenu = useCallback(
    (tab: Tab, x: number, y: number) => {
      const { tabs } = latest.current
      const others = tabs.some((t) => t.id !== tab.id && !t.pinned)
      const right = tabs.slice(tabs.findIndex((t) => t.id === tab.id) + 1).some((t) => !t.pinned)
      showMenu(x, y, [
        { label: tab.pinned ? "Unpin tab" : "Pin tab", run: () => togglePin(tab.id) },
        "-",
        { label: "Close", hint: altKey("W"), disabled: tabs.length < 2, run: () => closeTab(tab.id) },
        { label: "Close others", disabled: !others, run: () => settle(apply(model.closeOthers(latest.current, tab.id))) },
        { label: "Close to the right", disabled: !right, run: () => settle(apply(model.closeToRight(latest.current, tab.id))) },
        "-",
        { label: "Copy link", run: () => void navigator.clipboard?.writeText(window.location.origin + tab.href).catch(() => {}) },
        { label: "Open in browser tab", run: () => openInBrowser(tab.href) },
      ])
    },
    [apply, closeTab, settle, showMenu, togglePin],
  )

  /**
   * Archive and delete for the page behind a link, for people who can edit. Archive is
   * one click because the Archived page undoes it; folders have no archive, and deleting
   * one only moves its contents up. Leaving the page goes where the header's menu does.
   */
  const pageActions = useRef<(to: string) => ReadonlyArray<MenuEntry>>(() => [])
  pageActions.current = (to) => {
    if (!editable) return []
    const route = model.routeOf(to)
    const here = model.routeOf(normalize(window.location.pathname))
    if (route.type === "artifact" && !route.item) {
      const artifact = artifacts.find((a) => a.id === route.id)
      if (!artifact) return []
      const onIt = () => here.type === "artifact" && here.id === artifact.id
      const singular = kinds[artifact.kind].singular.toLowerCase()
      return [
        "-",
        { label: `Archive ${singular}`, run: () => void archive(artifact.id).then((done) => done && onIt() && go("/")) },
        {
          label: `Delete ${singular}…`,
          danger: true,
          confirm: {
            title: `Delete this ${singular}?`,
            message: artifactDeleteMessage(artifact.title),
            action: "Delete",
            run: async () => {
              if ((await remove(artifact.id)) && onIt()) go("/")
            },
          },
        },
      ]
    }
    if (route.type === "folder") {
      const folder = folders.find((f) => f.id === route.id)
      if (!folder) return []
      return [
        "-",
        {
          label: "Delete folder…",
          danger: true,
          confirm: {
            title: "Delete this folder?",
            message: folderDeleteMessage(folder, folders, artifacts),
            action: "Delete folder",
            run: async () => {
              try {
                await removeFolder(folder.id)
                if (here.type === "folder" && here.id === folder.id) go(folder.parentId ? `/folders/${folder.parentId}` : "/")
              } catch (e) {
                fail((e as Error).message)
              }
            },
          },
        },
      ]
    }
    return []
  }

  const stepTab = useCallback(
    (by: number) => {
      const { tabs, activeId } = latest.current
      const at = tabs.findIndex((t) => t.id === activeId)
      const tab = tabs[(at + by + tabs.length) % tabs.length]
      if (tab) select(tab.id)
    },
    [select],
  )

  useEffect(() => {
    if (!enabled) return
    // Capture: a Link would otherwise step aside and let the browser open its own tab. Stopped
    // here too, so a ⌘-click in the sidebar's peek leaves it open for the next one.
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      const a = anchorAt(e.target)
      const to = a && appHref(a)
      if (!to) return
      e.preventDefault()
      e.stopPropagation()
      openInBackground(to)
    }
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return
      const a = anchorAt(e.target)
      const to = a && appHref(a)
      if (!to) return
      e.preventDefault()
      e.stopPropagation()
      openInBackground(to)
    }
    // Only where it's marked: links inside a doc or a board keep the browser's own menu.
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const a = anchorAt(e.target)
      const to = a?.closest("[data-tab-links]") && appHref(a)
      if (!to) return
      e.preventDefault()
      showMenu(e.clientX, e.clientY, [
        { label: "Open", run: () => go(to) },
        { label: "Open in new tab", hint: isMac() ? "⌘-click" : "Ctrl-click", run: () => openInBackground(to) },
        { label: "Open in browser tab", run: () => openInBrowser(to) },
        ...pageActions.current(to),
      ])
    }
    // Browsers keep ⌘T and ⌘W for themselves. Capture, so an editor doesn't type a † first.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.isComposing || typesCharacter(e)) return
      const { activeId } = latest.current
      if (e.code === "KeyT") openAndGo("/")
      else if (e.code === "KeyW") {
        if (activeId) closeTab(activeId)
      } else if (e.code === "BracketRight") stepTab(1)
      else if (e.code === "BracketLeft") stepTab(-1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener("click", onClick, true)
    document.addEventListener("auxclick", onAuxClick, true)
    document.addEventListener("contextmenu", onContextMenu)
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("auxclick", onAuxClick, true)
      document.removeEventListener("contextmenu", onContextMenu)
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [enabled, closeTab, go, openAndGo, openInBackground, showMenu, stepTab])

  useEffect(
    () =>
      desktop?.onCommand((command) => {
        const { tabs, activeId } = latest.current
        // Without tabs (a share link, or still loading), the window is the only thing to open or close.
        if (command.type === "open") {
          if (enabled) openAndGo(command.href)
          else window.location.assign(command.href)
        } else if (command.type === "close-tab") {
          if (enabled && activeId && tabs.length > 1) closeTab(activeId)
          else window.close()
        } else if (!enabled) return
        else if (command.type === "new-tab") openAndGo("/")
        else if (command.type === "next-tab") stepTab(1)
        else if (command.type === "previous-tab") stepTab(-1)
        else if (command.type === "select-tab") {
          const tab = command.index < 0 ? tabs.at(-1) : tabs[command.index]
          if (tab) select(tab.id)
        }
      }),
    [enabled, closeTab, openAndGo, select, stepTab],
  )

  const meta = useCallback(
    (to: string): TabMeta => {
      const route = model.routeOf(to)
      const missing: TabMeta = { title: "Not found", kind: "gone" }
      switch (route.type) {
        case "home":
          return { title: "Home", kind: "home" }
        case "archived":
          return { title: "Archived", kind: "archived" }
        case "settings":
          return { title: "Settings", kind: "settings" }
        case "folder": {
          const folder = folders.find((f) => f.id === route.id)
          return folder ? { title: folder.name, kind: "folder" } : missing
        }
        case "artifact": {
          const artifact = artifacts.find((a) => a.id === route.id && kinds[a.kind].slug === route.slug)
          if (!artifact) return missing
          return { title: route.item ? `${artifact.title} #${route.item}` : artifact.title, kind: artifact.kind }
        }
        case "other":
          return missing
      }
    },
    [artifacts, folders],
  )

  const value = useMemo<Tabs>(() => {
    const hrefs = new Set(state.tabs.map((t) => t.href))
    return {
      enabled,
      tabs: state.tabs,
      activeId: state.activeId,
      kept: state.tabs.filter((t) => state.recent.includes(t.id) && isArtifact(model.routeOf(t.href))),
      flashId,
      isOpen: (h) => hrefs.has(h),
      meta,
      select,
      closeTab,
      togglePin,
      swapTabs,
      openInBackground,
      openAndGo,
      showTabMenu,
      showMenu,
    }
  }, [state, enabled, flashId, meta, select, closeTab, togglePin, swapTabs, openInBackground, openAndGo, showTabMenu, showMenu])

  return (
    <Ctx.Provider value={value}>
      {children}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} />}
    </Ctx.Provider>
  )
}

export const isArtifact = (route: TabRoute): route is Extract<TabRoute, { type: "artifact" }> => route.type === "artifact"
