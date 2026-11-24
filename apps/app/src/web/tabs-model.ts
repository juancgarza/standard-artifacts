/**
 * What's open in this window, as plain state changes. One rule drives it (see
 * `arrive`): when the location changes, a tab already holding that href becomes
 * active; otherwise the active tab takes the href. So every existing Link and
 * navigate() keeps working, and Back/Forward moves across tabs too.
 */

export type Tab = { readonly id: string; readonly href: string; readonly pinned: boolean }
export type SavedTab = Pick<Tab, "href" | "pinned"> & { readonly active?: boolean }

export type TabsState = {
  readonly tabs: ReadonlyArray<Tab>
  readonly activeId: string | null
  /** Most recently active first, capped: the tabs whose pages stay mounted while hidden. */
  readonly recent: ReadonlyArray<string>
}

export const MAX_KEPT = 5

export const noTabs: TabsState = { tabs: [], activeId: null, recent: [] }

const make = (href: string, pinned = false): Tab => ({ id: crypto.randomUUID(), href, pinned })

/** Pinned tabs always come first; otherwise the order is whatever the person made it. */
const pinnedFirst = (tabs: ReadonlyArray<Tab>) => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]

const activate = (s: TabsState, id: string): TabsState =>
  s.activeId === id && s.recent[0] === id ? s : { ...s, activeId: id, recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, MAX_KEPT) }

/** Next to the active tab, but never inside the pinned group. */
function insert(s: TabsState, tab: Tab): ReadonlyArray<Tab> {
  const pinned = s.tabs.filter((t) => t.pinned).length
  const at = Math.max(s.tabs.findIndex((t) => t.id === s.activeId) + 1, pinned)
  return [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)]
}

/** The location changed. A pinned tab stays on its page, so going elsewhere from one opens a new tab. */
export function arrive(s: TabsState, href: string): TabsState {
  const held = s.tabs.find((t) => t.href === href)
  if (held) return activate(s, held.id)
  const active = s.tabs.find((t) => t.id === s.activeId)
  if (!active || active.pinned) {
    const tab = make(href)
    return activate({ ...s, tabs: insert(s, tab) }, tab.id)
  }
  return activate({ ...s, tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, href } : t)) }, active.id)
}

/**
 * Start from what was stored. In the window that stored it, the address is a
 * reload or a typed URL, so the normal rule applies. A new window keeps every
 * saved tab and opens the address alongside them.
 */
export function restore(saved: ReadonlyArray<SavedTab>, href: string, sameWindow: boolean): TabsState {
  const tabs = pinnedFirst(saved.map((t) => make(t.href, t.pinned)))
  const seen = new Set<string>()
  const unique = tabs.filter((t) => !seen.has(t.href) && seen.add(t.href))
  const wasActive = saved.find((t) => t.active)?.href
  const activeId = sameWindow ? (unique.find((t) => t.href === wasActive)?.id ?? null) : null
  return arrive({ tabs: unique, activeId, recent: [] }, href)
}

/** A new tab, or nothing new if that page is already open. Doesn't change the location. */
export function open(s: TabsState, href: string, focus: boolean): { state: TabsState; id: string } {
  const held = s.tabs.find((t) => t.href === href)
  if (held) return { state: focus ? activate(s, held.id) : s, id: held.id }
  const tab = make(href)
  const next = { ...s, tabs: insert(s, tab) }
  return { state: focus ? activate(next, tab.id) : next, id: tab.id }
}

/** Close tabs; at least one always stays. When the active one goes, `prefer` or its neighbour (right, then left) takes over. */
export function close(s: TabsState, ids: ReadonlyArray<string>, prefer?: string): TabsState {
  const gone = new Set(ids)
  const left = s.tabs.filter((t) => !gone.has(t.id))
  if (left.length === 0) return s
  const next: TabsState = { ...s, tabs: left, recent: s.recent.filter((id) => !gone.has(id)) }
  if (!s.activeId || !gone.has(s.activeId)) return next
  const at = s.tabs.findIndex((t) => t.id === s.activeId)
  const heir = prefer ?? s.tabs.slice(at + 1).find((t) => !gone.has(t.id))?.id ?? s.tabs.slice(0, at).filter((t) => !gone.has(t.id)).at(-1)?.id
  return heir ? activate(next, heir) : next
}

/** Everything else, except pinned tabs. */
export const closeOthers = (s: TabsState, id: string) =>
  close(s, s.tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id), id)

/** Everything after this tab, except pinned tabs. */
export function closeToRight(s: TabsState, id: string) {
  const at = s.tabs.findIndex((t) => t.id === id)
  return close(s, s.tabs.slice(at + 1).filter((t) => !t.pinned).map((t) => t.id), id)
}

export const setPinned = (s: TabsState, id: string, pinned: boolean): TabsState => ({
  ...s,
  tabs: pinnedFirst(s.tabs.map((t) => (t.id === id ? { ...t, pinned } : t))),
})

/** Trade places while dragging. Tabs stay within their own group. */
export function swap(s: TabsState, a: string, b: string): TabsState {
  const i = s.tabs.findIndex((t) => t.id === a)
  const j = s.tabs.findIndex((t) => t.id === b)
  if (i < 0 || j < 0 || s.tabs[i]!.pinned !== s.tabs[j]!.pinned) return s
  const tabs = [...s.tabs]
  tabs[i] = s.tabs[j]!
  tabs[j] = s.tabs[i]!
  return { ...s, tabs }
}

/** Tabs whose page no longer exists. The active one stays: whoever removed it is about to navigate away. */
export function prune(s: TabsState, isGone: (href: string) => boolean): TabsState {
  const ids = s.tabs.filter((t) => t.id !== s.activeId && isGone(t.href)).map((t) => t.id)
  return ids.length ? close(s, ids) : s
}

export type TabRoute =
  | { readonly type: "home" }
  | { readonly type: "archived" }
  | { readonly type: "settings" }
  | { readonly type: "folder"; readonly id: string }
  | { readonly type: "artifact"; readonly slug: string; readonly id: string; readonly item: string | undefined }
  | { readonly type: "other" }

/** What page an href points at, without asking the router: hidden tabs aren't the router's current match. */
export function routeOf(href: string): TabRoute {
  const parts = (href.split(/[?#]/)[0] ?? "").split("/").filter(Boolean).map(decodeURIComponent)
  if (parts.length === 0) return { type: "home" }
  if (parts.length === 1 && parts[0] === "archived") return { type: "archived" }
  if (parts.length <= 2 && parts[0] === "settings") return { type: "settings" }
  if (parts.length === 2 && parts[0] === "folders") return { type: "folder", id: parts[1]! }
  if (parts.length === 2 || parts.length === 3) return { type: "artifact", slug: parts[0]!, id: parts[1]!, item: parts[2] }
  return { type: "other" }
}
