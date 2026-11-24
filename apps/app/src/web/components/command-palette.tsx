import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "@tanstack/react-router"
import { ArrowElbowDownLeftIcon, FolderIcon, GearSixIcon, MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react"
import { Effect } from "effect"
import { folderPath, kindOrder, kinds, uniqueFolderName, type Artifact, type ArtifactKind, type Folder, type SearchHit } from "@standard-artifacts/protocol"
import { api } from "../api"
import { useTabs } from "../tabs"
import { recency, useWorkspace } from "../workspace"
import { KindIcon } from "./kind-icon"
import { timeAgo } from "../time"

/** Subsequence match: every query character in order. Rewards word starts and runs; returns matched indices. */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return { score: 0, hits: [] }
  const direct = t.indexOf(q)
  if (direct >= 0) {
    const atWord = direct === 0 || isBoundary(t[direct - 1]!)
    return { score: 100 + q.length * 4 + (atWord ? 40 : 0) - direct * 0.5, hits: Array.from(q, (_, i) => direct + i) }
  }
  // Greedy from each place the first letter appears; keep the best run. Letters
  // scattered across a long title aren't a match anyone meant, so runs are capped.
  const maxSpan = Math.max(q.length * 3, q.length + 6)
  let best: { score: number; hits: number[] } | null = null
  for (let start = t.indexOf(q[0]!); start >= 0; start = t.indexOf(q[0]!, start + 1)) {
    const hits = [start]
    let score = start === 0 || isBoundary(t[start - 1]!) ? 8 : 0
    for (let i = 1; i < q.length && hits.length === i; i++) {
      const prev = hits[i - 1]!
      const found = t.indexOf(q[i]!, prev + 1)
      if (found < 0 || found - start >= maxSpan) break
      if (found === prev + 1) score += 6
      if (isBoundary(t[found - 1]!)) score += 8
      score -= Math.min(found - prev - 1, 8) * 0.5
      hits.push(found)
    }
    if (hits.length === q.length && (!best || score > best.score)) best = { score, hits }
  }
  return best
}

const isBoundary = (ch: string) => /[\s\-_/·—:]/.test(ch)

/** Every whitespace-separated token must match the title, the kind name, or the folder it's in. */
function matchArtifact(query: string, a: Artifact, path: string) {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  let score = 0
  const hits = new Set<number>()
  for (const token of tokens) {
    const title = fuzzy(token, a.title)
    // Kind names match by prefix only ("tab", "docs"), so short tokens don't pull in every artifact.
    const kind = token.length >= 2 && kinds[a.kind].label.toLowerCase().startsWith(token.toLowerCase())
    const inPath = path.toLowerCase().includes(token.toLowerCase())
    if (!title && !kind && !inPath) return null
    if (title) {
      score += title.score
      for (const h of title.hits) hits.add(h)
    } else score += kind ? 60 : 40
  }
  return { score, hits }
}

/** Folders match on their whole path, so "launch" finds Marketing/Launch and what's under it. */
function matchFolder(query: string, path: string, name: string) {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  const offset = path.length - name.length
  let score = 0
  const hits = new Set<number>()
  for (const token of tokens) {
    const m = fuzzy(token, path)
    if (!m) return null
    score += m.score
    for (const h of m.hits) if (h >= offset) hits.add(h - offset)
  }
  return { score, hits }
}

type Item =
  | { type: "artifact"; artifact: Artifact; hits: Set<number> }
  | { type: "content"; hit: SearchHit; hits: Set<number> }
  | { type: "folder"; folder: Folder; hits: Set<number> }
  | { type: "settings"; hits: Set<number> }
  | { type: "create"; kind: ArtifactKind; hits: Set<number> }
  | { type: "create-folder"; hits: Set<number> }

const MAX_RESULTS = 30

/**
 * Matches inside artifacts, from the server. Titles and folders are matched
 * right here as you type, so this only adds to them: if it's slow or fails,
 * the palette still works and just shows no content matches.
 */
function useContentSearch(query: string, devAs: string): Item[] {
  const [found, setFound] = useState<Item[]>([])
  const q = query.trim()
  useEffect(() => {
    if (q.length < 3) {
      setFound([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      Effect.runPromise(api(devAs).pipe(Effect.flatMap((client) => client.search.query({ query: { q } }))))
        .then((r) => {
          if (live) setFound(r.hits.filter((hit) => hit.item !== undefined).map((hit) => ({ type: "content", hit, hits: new Set<number>() })))
        })
        .catch(() => {
          if (live) setFound([])
        })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [q, devAs])
  return found
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { artifacts, folders, editable, create, createFolder, fail, visits, devAs } = useWorkspace()
  const tabs = useTabs()
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const { results, actions } = useMemo(() => {
    const q = query.trim()
    let results: Item[]
    if (!q) {
      results = [...artifacts]
        .sort((a, b) => recency(b, visits) - recency(a, visits))
        .slice(0, 6)
        .map((artifact) => ({ type: "artifact", artifact, hits: new Set<number>() }))
    } else {
      const found: Array<{ item: Item; score: number; at: number }> = []
      for (const artifact of artifacts) {
        const m = matchArtifact(q, artifact, folderPath(folders, artifact.folderId))
        if (m) found.push({ item: { type: "artifact", artifact, hits: m.hits }, score: m.score, at: recency(artifact, visits) })
      }
      for (const folder of folders) {
        const m = matchFolder(q, folderPath(folders, folder.id), folder.name)
        if (m) found.push({ item: { type: "folder", folder, hits: m.hits }, score: m.score, at: Date.parse(folder.updatedAt) || 0 })
      }
      const settings = fuzzy(q, "Settings")
      if (settings && settings.score > 0) found.push({ item: { type: "settings", hits: new Set(settings.hits) }, score: settings.score, at: 0 })
      results = found
        .sort((a, b) => b.score - a.score || b.at - a.at)
        .slice(0, MAX_RESULTS)
        .map((x) => x.item)
    }
    const offer = (label: string): Set<number> | null => {
      if (!q) return new Set()
      const m = fuzzy(q, label)
      return m && m.score > 0 ? new Set(m.hits) : null
    }
    const actions: Item[] = !editable
      ? []
      : [
          ...kindOrder.flatMap((kind): Item[] => {
            const hits = offer(`New ${kinds[kind].singular.toLowerCase()}`)
            return hits ? [{ type: "create", kind, hits }] : []
          }),
          ...((): Item[] => {
            const hits = offer("New folder")
            return hits ? [{ type: "create-folder", hits }] : []
          })(),
        ]
    return { results, actions }
  }, [query, artifacts, folders, editable, visits])

  // A query that reads like a command ("new t") puts the actions first.
  const commandFirst = /^\s*(new|create)\b/i.test(query)
  const content = useContentSearch(query, devAs)
  const items = commandFirst ? [...actions, ...results, ...content] : [...results, ...content, ...actions]

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])
  // Focus the input; on a plain close (not a navigation), hand focus back to wherever it was.
  const navigated = useRef(false)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      if (!navigated.current && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  /** Close and go there, or with ⌘ held, open it in a tab behind the current page. */
  const leave = (href: string, inNewTab: boolean) => {
    navigated.current = !inNewTab
    onClose()
    if (inNewTab && tabs.enabled) tabs.openInBackground(href)
    else void router.history.push(href)
  }

  const run = async (item: Item | undefined, inNewTab = false) => {
    if (!item || busy) return
    if (item.type === "artifact") return leave(`/${kinds[item.artifact.kind].slug}/${item.artifact.id}`, inNewTab)
    if (item.type === "content") return leave(`/${kinds[item.hit.artifact.kind].slug}/${item.hit.artifact.id}/${item.hit.item}`, inNewTab)
    if (item.type === "folder") return leave(`/folders/${item.folder.id}`, inNewTab)
    if (item.type === "settings") return leave("/settings", inNewTab)
    if (item.type === "create-folder") {
      setBusy(true)
      try {
        const folder = await createFolder(uniqueFolderName(folders, "New folder", null), null)
        leave(`/folders/${folder.id}`, inNewTab)
      } catch (e) {
        fail((e as Error).message)
      }
      setBusy(false)
      return
    }
    setBusy(true)
    const artifact = await create(item.kind)
    setBusy(false)
    if (artifact) leave(`/${kinds[item.kind].slug}/${artifact.id}`, inNewTab)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault()
      setActive((i) => (items.length ? (i + 1) % items.length : 0))
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault()
      setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      void run(items[active], e.metaKey || e.ctrlKey)
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === "Tab") {
      e.preventDefault()
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`
  const option = (item: Item, i: number) => (
    <div
      key={item.type === "content" ? `${item.hit.artifact.id}/${item.hit.item}` : item.type === "artifact" ? item.artifact.id : item.type === "folder" ? item.folder.id : item.type === "settings" ? "settings" : item.type === "create" ? `new-${item.kind}` : "new-folder"}
      id={optionId(i)}
      role="option"
      aria-selected={i === active}
      data-index={i}
      onMouseMove={() => i !== active && setActive(i)}
      onClick={(e) => void run(item, e.metaKey || e.ctrlKey)}
      className={`flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 ${i === active ? "bg-hover" : ""}`}
    >
      {item.type === "content" ? (
        <>
          <KindIcon kind={item.hit.artifact.kind} size={18} />
          <span className="min-w-0 flex-1 truncate">{item.hit.text}</span>
          <span className="max-w-[35%] shrink-0 truncate text-[12px] text-faint">{item.hit.artifact.title}</span>
        </>
      ) : item.type === "artifact" ? (
        <>
          <KindIcon kind={item.artifact.kind} size={18} />
          <span className="min-w-0 flex-1 truncate">
            <Highlight text={item.artifact.title} hits={item.hits} />
          </span>
          <span className="max-w-[45%] shrink-0 truncate text-[12px] text-faint">
            {item.artifact.folderId ? `${folderPath(folders, item.artifact.folderId)} · ` : ""}
            {kinds[item.artifact.kind].singular} · {timeAgo(item.artifact.updatedAt)}
          </span>
        </>
      ) : item.type === "folder" ? (
        <>
          <FolderIcon size={18} weight="duotone" className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">
            <Highlight text={item.folder.name} hits={item.hits} />
          </span>
          <span className="max-w-[45%] shrink-0 truncate text-[12px] text-faint">
            {item.folder.parentId ? `${folderPath(folders, item.folder.parentId)} · ` : ""}Folder
          </span>
        </>
      ) : item.type === "settings" ? (
        <>
          <GearSixIcon size={18} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">
            <Highlight text="Settings" hits={item.hits} />
          </span>
        </>
      ) : (
        <>
          <span className="grid size-[18px] shrink-0 place-items-center rounded bg-active text-muted">
            <PlusIcon size={11} weight="bold" />
          </span>
          <span className="min-w-0 flex-1 truncate">
            <Highlight text={item.type === "create" ? `New ${kinds[item.kind].singular.toLowerCase()}` : "New folder"} hits={item.hits} />
          </span>
          {item.type === "create" ? <KindIcon kind={item.kind} size={16} className="opacity-70" /> : <FolderIcon size={16} weight="duotone" className="shrink-0 text-muted" />}
        </>
      )}
      {i === active && <ArrowElbowDownLeftIcon size={14} className="shrink-0 text-faint" aria-hidden />}
    </div>
  )

  const groups: Array<{ label: string; items: Item[]; offset: number }> = []
  const resultsGroup = { label: query.trim() ? "Results" : "Recent", items: results }
  const contentGroup = { label: "In content", items: content }
  const actionsGroup = { label: "Create", items: actions }
  let offset = 0
  for (const g of commandFirst ? [actionsGroup, resultsGroup, contentGroup] : [resultsGroup, contentGroup, actionsGroup]) {
    if (g.items.length) groups.push({ ...g, offset })
    offset += g.items.length
  }

  return (
    <div className="fixed inset-0 z-50" onKeyDown={onKeyDown}>
      <button type="button" aria-label="Close search" tabIndex={-1} className="absolute inset-0 cursor-default bg-black/25 dark:bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="palette-in absolute top-[12vh] left-1/2 flex max-h-[min(580px,76vh)] w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-[0_24px_64px_-12px_rgba(0,0,0,0.28),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
          <MagnifyingGlassIcon size={18} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={editable ? "Search boards, tables, docs and folders, or create one…" : "Search boards, tables, docs and folders…"}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items.length ? optionId(active) : undefined}
            aria-autocomplete="list"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <kbd className="rounded border border-border px-1.5 py-px font-sans text-[11px] text-faint">Esc</kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label} className="pb-1">
              <div className="px-3 pt-2 pb-1 text-[12px] font-medium text-faint">{g.label}</div>
              {g.items.map((item, j) => option(item, g.offset + j))}
            </div>
          ))}
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-muted">
              No matches for “{query.trim()}”
            </div>
          )}
        </div>

        <div className="flex h-9 shrink-0 items-center gap-4 border-t border-border bg-surface px-4 text-[12px] text-faint">
          <Hint keys={["↑", "↓"]}>to navigate</Hint>
          <Hint keys={["↵"]}>to open</Hint>
          {tabs.enabled && <Hint keys={[shortcutLabel().startsWith("⌘") ? "⌘" : "Ctrl", "↵"]}>in a new tab</Hint>}
          <Hint keys={["esc"]}>to close</Hint>
        </div>
      </div>
    </div>
  )
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className="grid h-[18px] min-w-[18px] place-items-center rounded border border-border bg-bg px-1 font-sans text-[11px]">
          {k}
        </kbd>
      ))}
      <span className="ml-0.5">{children}</span>
    </span>
  )
}

function Highlight({ text, hits }: { text: string; hits: Set<number> }) {
  if (hits.size === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let run = ""
  let on = false
  const flush = (key: number) => {
    if (!run) return
    parts.push(on ? <mark key={key} className="bg-transparent font-semibold text-text">{run}</mark> : run)
    run = ""
  }
  text.split("").forEach((ch, i) => {
    const hit = hits.has(i)
    if (hit !== on) {
      flush(i)
      on = hit
    }
    run += ch
  })
  flush(text.length)
  return <>{parts}</>
}

/** Platform label for the shortcut: ⌘K on Apple devices, Ctrl K elsewhere. */
export const shortcutLabel = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K"
