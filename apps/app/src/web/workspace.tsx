import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Effect } from "effect"
import { actorKey, canEdit, type Artifact, type ArtifactKind, type Folder, type OrgDirectory, type Principal, type RoomContent, type UpdateFolder } from "@standard-artifacts/protocol"
import { api, errorMessage } from "./api"

export type DevAs = "owner" | "viewer" | "guest"

type Workspace = {
  status: "loading" | "error" | "ready"
  error: string | null
  principal: Principal | null
  /** What the server says about sign-in: "dev" is a local server with none. Undefined until the first read. */
  authMode: "dev" | "live" | undefined
  editable: boolean
  artifacts: Artifact[]
  folders: Folder[]
  create: (kind: ArtifactKind, folderId?: string) => Promise<Artifact | null>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<boolean>
  archive: (id: string) => Promise<boolean>
  restore: (id: string) => Promise<boolean>
  loadArchived: () => Promise<ReadonlyArray<Artifact>>
  loadDirectory: () => Promise<OrgDirectory>
  /** These reject with a readable message, so forms can show it where the person is looking. */
  createFolder: (name: string, parentId: string | null) => Promise<Folder>
  updateFolder: (id: string, change: UpdateFolder) => Promise<void>
  removeFolder: (id: string) => Promise<void>
  moveArtifact: (id: string, folderId: string | null) => Promise<void>
  /** Show a failure with nowhere of its own to appear (a drop, say) in the banner for a few seconds. */
  fail: (message: string) => void
  /** Folders this viewer has open in the sidebar (per viewer, in localStorage). */
  openFolders: ReadonlySet<string>
  toggleFolder: (id: string) => void
  expandFolders: (ids: ReadonlyArray<string>) => void
  devAs: DevAs
  setDevAs: (as: DevAs) => void
  /** Ids this viewer starred, most recently starred first (per viewer, in localStorage). */
  starred: string[]
  toggleStar: (id: string) => void
  /** When this viewer last opened each artifact (ms), for "recent" ordering. */
  visits: Record<string, number>
  recordVisit: (id: string) => void
  /** An artifact's live content, cached briefly so previews don't refetch on every render. Pass `updatedAt` to skip a copy older than that. */
  loadContent: (id: string, updatedAt?: string) => Promise<RoomContent>
}

const Ctx = createContext<Workspace | null>(null)

export function useWorkspace() {
  const ws = useContext(Ctx)
  if (!ws) throw new Error("useWorkspace outside WorkspaceProvider")
  return ws
}

const DEV_AS_KEY = "standard-artifacts:dev-as"
const readDevAs = (): DevAs => {
  try {
    const v = sessionStorage.getItem(DEV_AS_KEY)
    return v === "viewer" || v === "guest" ? v : "owner"
  } catch {
    return "owner"
  }
}

/** Read and write a JSON value in localStorage; storage can be missing or throw (private windows, previews). */
function readStored<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const v: unknown = JSON.parse(raw)
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}
function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // per-viewer convenience only
  }
}
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")
const isVisits = (v: unknown): v is Record<string, number> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "number")

const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

const MAX_VISITS = 50
const CONTENT_TTL = 30_000
/** One read of the index per burst of changes, however many artifacts are being edited. */
const LIVE_GATHER_MS = 500
/** How often to look anyway while the live socket is down (a proxy may never let it connect). */
const LIVE_POLL_MS = 30_000
const LIVE_STABLE_MS = 30_000

/** The org's "the index changed" socket. In dev, `as` switches the caller (honored only with AUTH_MODE=dev). */
function liveUrl(devAs: DevAs) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws"
  const as = import.meta.env.DEV && devAs !== "owner" ? `?as=${devAs}` : ""
  return `${proto}://${window.location.host}/api/v1/workspace/live${as}`
}

/** Keep the current value when nothing changed, so a read that found nothing new re-renders nothing. */
const unlessSame = <T,>(next: T) => (prev: T) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)

const idleSync = () => ({ writing: 0, writes: 0, reading: false, again: false })

/** Recency for "Recent" lists: the later of this viewer's last visit and the artifact's last update. */
export const recency = (a: Artifact, visits: Record<string, number>) => Math.max(visits[a.id] ?? 0, Date.parse(a.updatedAt) || 0)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [devAs, setDevAsState] = useState<DevAs>(readDevAs)
  const [status, setStatus] = useState<Workspace["status"]>("loading")
  const [error, setError] = useState<string | null>(null)
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [authMode, setAuthMode] = useState<"dev" | "live" | undefined>(undefined)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [openFolderIds, setOpenFolderIds] = useState<string[]>([])
  const viewer = principal ? `${principal.orgId}:${actorKey(principal.actor)}` : null
  const [starred, setStarred] = useState<string[]>([])
  const [visits, setVisits] = useState<Record<string, number>>({})
  const contentCache = useRef(new Map<string, { at: number; updatedAt: string | undefined; promise: Promise<RoomContent> }>())
  const sync = useRef(idleSync())
  // For rolling back a failed write, without the write callbacks (and the views they're handed to) changing with every update.
  const latest = useRef(artifacts)
  latest.current = artifacts

  /** Run a typed API call; failures surface as a readable message. */
  const call = useCallback(
    <A,>(f: (client: Effect.Success<ReturnType<typeof api>>) => Effect.Effect<A, unknown>) =>
      Effect.runPromise(api(devAs).pipe(Effect.flatMap(f), Effect.mapError(errorMessage), Effect.mapError((m) => new Error(m)))),
    [devAs],
  )

  /**
   * Read the index again. A read that overlaps a write of ours could undo its
   * optimistic result (or, for one that just created an artifact, close the page
   * it navigated to), so it waits for the write and is dropped if one slipped in.
   */
  const refresh = useCallback(
    async function run(): Promise<void> {
      const s = sync.current
      if (s.reading || s.writing) {
        s.again = true
        return
      }
      s.reading = true
      const writes = s.writes
      try {
        const snap = await call((c) => c.workspace.snapshot())
        if (s !== sync.current) return
        if (s.writes !== writes) {
          s.again = true
        } else {
          setPrincipal(unlessSame<Principal | null>(snap.principal))
          setArtifacts(unlessSame([...snap.artifacts]))
          setFolders(unlessSame([...snap.folders]))
        }
      } catch {
        // Stale until the next change; a failed background read isn't worth interrupting anyone.
      }
      s.reading = false
      if (s.again && !s.writing) {
        s.again = false
        void run()
      }
    },
    [call],
  )

  /** Run a call that changes the index. */
  const write: typeof call = useCallback(
    async (f) => {
      const s = sync.current
      s.writing++
      s.writes++
      try {
        return await call(f)
      } finally {
        s.writing--
        if (s.again && !s.writing && !s.reading) {
          s.again = false
          void refresh()
        }
      }
    },
    [call, refresh],
  )

  useEffect(() => {
    let cancelled = false
    sync.current = idleSync()
    setStatus("loading")
    call((c) => c.workspace.snapshot())
      .then((snap) => {
        if (cancelled) return
        setPrincipal(snap.principal)
        setAuthMode(snap.authMode)
        setArtifacts([...snap.artifacts])
        setFolders([...snap.folders])
        // Here, not in the viewer effect below: the sidebar expands the open folder as soon as it
        // sees folders, and a later read of what's stored would undo that.
        setOpenFolderIds(readStored(`standard-artifacts:folders-open:${snap.principal.orgId}:${actorKey(snap.principal.actor)}`, [], isIdList))
        setStatus("ready")
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message)
        setStatus("error")
      })
    return () => {
      cancelled = true
    }
  }, [call])

  // Stay current with what others (and agents) do: the socket says when, and reads go through the API.
  const ready = status === "ready"
  useEffect(() => {
    if (!ready) return
    let socket: WebSocket | null = null
    let stopped = false
    let attempts = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let gather: ReturnType<typeof setTimeout> | undefined
    const changed = () => {
      // A hidden tab reads when it's shown again.
      if (gather || document.visibilityState !== "visible") return
      gather = setTimeout(() => {
        gather = undefined
        void refresh()
      }, LIVE_GATHER_MS)
    }
    const connect = () => {
      const ws = new WebSocket(liveUrl(devAs))
      socket = ws
      let openedAt = 0
      ws.onmessage = changed
      ws.onopen = () => {
        openedAt = Date.now()
        // Whatever happened before this socket was listening.
        changed()
      }
      ws.onclose = () => {
        if (stopped) return
        // Only a socket that lasted earns a quick retry: one that opens and drops mustn't turn into a stream of reads.
        if (openedAt && Date.now() - openedAt > LIVE_STABLE_MS) attempts = 0
        retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempts++) * (0.75 + Math.random() * 0.5))
      }
    }
    connect()
    const poll = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) changed()
    }, LIVE_POLL_MS)
    document.addEventListener("visibilitychange", changed)
    return () => {
      stopped = true
      clearTimeout(retry)
      clearTimeout(gather)
      clearInterval(poll)
      document.removeEventListener("visibilitychange", changed)
      socket?.close(1000)
    }
  }, [ready, refresh, devAs])

  // Stars and visits belong to the viewer (org + actor), so switching "View as" swaps them.
  useEffect(() => {
    setStarred(viewer ? readStored(`standard-artifacts:starred:${viewer}`, [], isIdList) : [])
    setVisits(viewer ? readStored(`standard-artifacts:visits:${viewer}`, {}, isVisits) : {})
  }, [viewer])

  const storeOpenFolders = useCallback(
    (update: (ids: string[]) => string[]) => {
      setOpenFolderIds((ids) => {
        const next = update(ids)
        if (next === ids) return ids
        if (viewer) writeStored(`standard-artifacts:folders-open:${viewer}`, next)
        return next
      })
    },
    [viewer],
  )
  const toggleFolder = useCallback(
    (id: string) => storeOpenFolders((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])),
    [storeOpenFolders],
  )
  const expandFolders = useCallback(
    (more: ReadonlyArray<string>) =>
      storeOpenFolders((ids) => {
        const missing = more.filter((id) => !ids.includes(id))
        return missing.length ? [...ids, ...missing] : ids
      }),
    [storeOpenFolders],
  )
  const openFolders = useMemo(() => new Set(openFolderIds), [openFolderIds])

  const toggleStar = useCallback(
    (id: string) => {
      setStarred((list) => {
        const next = list.includes(id) ? list.filter((x) => x !== id) : [id, ...list]
        if (viewer) writeStored(`standard-artifacts:starred:${viewer}`, next)
        return next
      })
    },
    [viewer],
  )

  const recordVisit = useCallback(
    (id: string) => {
      setVisits((prev) => {
        const entries = Object.entries({ ...prev, [id]: Date.now() })
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_VISITS)
        const next = Object.fromEntries(entries)
        if (viewer) writeStored(`standard-artifacts:visits:${viewer}`, next)
        return next
      })
    },
    [viewer],
  )

  useEffect(() => contentCache.current.clear(), [call])

  const loadContent = useCallback(
    (id: string, updatedAt?: string) => {
      const hit = contentCache.current.get(id)
      if (hit && Date.now() - hit.at < CONTENT_TTL && (!updatedAt || hit.updatedAt === updatedAt)) return hit.promise
      const promise = call((c) => c.rooms.content({ params: { id } }))
      contentCache.current.set(id, { at: Date.now(), updatedAt, promise })
      promise.catch(() => contentCache.current.delete(id))
      return promise
    },
    [call],
  )

  const create = useCallback(
    async (kind: ArtifactKind, folderId?: string) => {
      try {
        const artifact = await write((c) => c.workspace.createArtifact({ payload: { kind, ...(folderId && { folderId }) } }))
        setArtifacts((list) => [artifact, ...list])
        return artifact
      } catch (e) {
        setError((e as Error).message)
        return null
      }
    },
    [write],
  )

  const rename = useCallback(
    async (id: string, title: string) => {
      const prev = latest.current
      setArtifacts((list) => list.map((a) => (a.id === id ? { ...a, title } : a)))
      try {
        const updated = await write((c) => c.workspace.updateArtifact({ params: { id }, payload: { title } }))
        setArtifacts((list) => [updated, ...list.filter((a) => a.id !== id)])
      } catch (e) {
        setArtifacts(prev)
        setError((e as Error).message)
      }
    },
    [write],
  )

  const remove = useCallback(
    async (id: string) => {
      const prev = latest.current
      setArtifacts((list) => list.filter((a) => a.id !== id))
      try {
        await write((c) => c.workspace.deleteArtifact({ params: { id } }))
        return true
      } catch (e) {
        setArtifacts(prev)
        setError((e as Error).message)
        return false
      }
    },
    [write],
  )

  const archive = useCallback(
    async (id: string) => {
      const prev = latest.current
      setArtifacts((list) => list.filter((a) => a.id !== id))
      try {
        await write((c) => c.workspace.archiveArtifact({ params: { id } }))
        return true
      } catch (e) {
        setArtifacts(prev)
        setError((e as Error).message)
        return false
      }
    },
    [write],
  )

  const restore = useCallback(
    async (id: string) => {
      try {
        const restored = await write((c) => c.workspace.restoreArtifact({ params: { id } }))
        setArtifacts((list) => [restored, ...list])
        return true
      } catch (e) {
        setError((e as Error).message)
        return false
      }
    },
    [write],
  )

  const loadArchived = useCallback(() => call((c) => c.workspace.archivedArtifacts()), [call])
  const loadDirectory = useCallback(() => call((c) => c.workspace.members()), [call])

  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const fail = useCallback((message: string) => {
    setError(message)
    clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => setError((current) => (current === message ? null : current)), 6000)
  }, [])

  const createFolder = useCallback(
    async (name: string, parentId: string | null) => {
      const folder = await write((c) => c.workspace.createFolder({ payload: { name, parentId } }))
      setFolders((list) => [...list, folder].sort(byName))
      return folder
    },
    [write],
  )

  const updateFolder = useCallback(
    async (id: string, change: UpdateFolder) => {
      const updated = await write((c) => c.workspace.updateFolder({ params: { id }, payload: change }))
      setFolders((list) => list.map((f) => (f.id === id ? updated : f)).sort(byName))
    },
    [write],
  )

  // What was inside moves up (and a subfolder may be renumbered), so read the result back.
  const removeFolder = useCallback(
    async (id: string) => {
      await write((c) => c.workspace.deleteFolder({ params: { id } }))
      const snap = await call((c) => c.workspace.snapshot())
      setArtifacts([...snap.artifacts])
      setFolders([...snap.folders])
    },
    [call, write],
  )

  const moveArtifact = useCallback(
    async (id: string, folderId: string | null) => {
      const moved = await write((c) => c.workspace.moveArtifact({ params: { id }, payload: { folderId } }))
      setArtifacts((list) => list.map((a) => (a.id === id ? moved : a)))
    },
    [write],
  )

  const setDevAs = useCallback((as: DevAs) => {
    try {
      sessionStorage.setItem(DEV_AS_KEY, as)
    } catch {
      // storage unavailable: the switch still applies for this page view
    }
    setDevAsState(as)
  }, [])

  const value = useMemo<Workspace>(
    () => ({
      status,
      error,
      principal,
      authMode,
      editable: principal ? canEdit(principal) : false,
      artifacts,
      folders,
      create,
      rename,
      remove,
      archive,
      restore,
      loadArchived,
      loadDirectory,
      createFolder,
      updateFolder,
      removeFolder,
      moveArtifact,
      fail,
      openFolders,
      toggleFolder,
      expandFolders,
      devAs,
      setDevAs,
      starred,
      toggleStar,
      visits,
      recordVisit,
      loadContent,
    }),
    [status, error, principal, authMode, artifacts, folders, create, rename, remove, archive, restore, loadArchived, loadDirectory, createFolder, updateFolder, removeFolder, moveArtifact, fail, openFolders, toggleFolder, expandFolders, devAs, setDevAs, starred, toggleStar, visits, recordVisit, loadContent],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
