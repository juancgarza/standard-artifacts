import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { LockSimpleIcon, ShareFatIcon } from "@phosphor-icons/react"
import { actorKey, kindFromSlug, kindOfId, kinds, type Artifact, type Principal } from "@standard-artifacts/protocol"
import type { RoomSnapshot } from "@standard-artifacts/room"
import type { AgentRequests } from "@standard-artifacts/room/react"
import { BoardView, useBoardRoom, type BoardLinks } from "@standard-artifacts/board"
import { DocView, useDocRoom, type DocEmbeds } from "@standard-artifacts/doc"
import { TableView, useTableRoom, type TableLinks, type TableViewMode } from "@standard-artifacts/table"
import { TrackerView, useTrackerRoom, type TrackerWorkspace } from "@standard-artifacts/tracker"
import { Effect } from "effect"
import { api, errorMessage } from "../api"
import { useWorkspace } from "../workspace"
import { SidebarToggle } from "../components/sidebar-collapse"
import { KindIcon } from "../components/kind-icon"
import { Preview } from "../components/home-preview"
import { ArtifactChip, ArtifactEmbed } from "../components/artifact-embed"
import { EmbedPicker } from "../components/embed-picker"
import { HeaderMenu } from "../components/header-menu"
import { PresenceStack, presenceKey, type LivePresence } from "../components/presence-stack"
import { ShareDialog } from "../components/share-dialog"
import { MoveDialog } from "../components/move-dialog"
import { FolderTrail } from "../components/folder-trail"

const nobody: LivePresence = { self: null, others: [], status: null }
const STATUS_DELAY = 800

/** A connection state worth mentioning: past the moment it takes to rejoin a room, which happens on every tab switch. */
function useLastingStatus(status: LivePresence["status"]) {
  const [shown, setShown] = useState<LivePresence["status"]>(null)
  useEffect(() => {
    if (!status || status === "open") return setShown(null)
    const timer = setTimeout(() => setShown(status), STATUS_DELAY)
    return () => clearTimeout(timer)
  }, [status])
  return shown
}

export function ArtifactPage({ slug, id, item }: { slug: string; id: string; item: string | undefined }) {
  const { artifacts, editable, rename, remove, archive, status, principal, devAs } = useWorkspace()
  const navigate = useNavigate()
  const kind = kindFromSlug(slug)
  const artifact = artifacts.find((a) => a.id === id && a.kind === kind)
  const [live, setLive] = useState<LivePresence>(nobody)
  const connection = useLastingStatus(live.status)
  const [sharing, setSharing] = useState(false)
  const [moving, setMoving] = useState(false)
  const shareButton = useRef<HTMLButtonElement>(null)

  // The view's room reports who's here; only changes the header shows re-render the page.
  const lastKey = useRef("")
  const onLive = useCallback((next: LivePresence) => {
    const key = presenceKey(next)
    if (key === lastKey.current) return
    lastKey.current = key
    setLive(next)
  }, [])
  useEffect(() => {
    lastKey.current = ""
    setLive(nobody)
    setSharing(false)
  }, [id])

  // Stable for the memoized views: the doc renders the title too and renames through the same call.
  const current = useRef(artifact)
  current.current = artifact
  const renameFromView = useCallback(
    (title: string) => {
      const a = current.current
      const next = title.trim()
      if (a && next && next !== a.title) void rename(a.id, next)
    },
    [rename],
  )

  const closeShare = useCallback(() => {
    setSharing(false)
    shareButton.current?.focus()
  }, [])

  if (status === "loading") return null
  if (!kind || !artifact) {
    return (
      <div className="p-8 text-muted">
        Not found. <Link to="/" className="text-accent">Go home</Link>
      </div>
    )
  }

  const meta = kinds[kind]
  const guest = principal?.actor.type === "guest"
  const linkGuest = !!principal?.scope

  const onDelete = async () => {
    if (await remove(artifact.id)) navigate({ to: "/" })
  }
  const onArchive = async () => {
    if (await archive(artifact.id)) navigate({ to: "/" })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <SidebarToggle placement="page" className="-ml-1.5 -mr-1" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <KindIcon kind={kind} size={18} />
          {linkGuest ? (
            <span className="hidden text-muted sm:inline">{principal?.orgName}</span>
          ) : artifact.folderId ? (
            <FolderTrail folderId={artifact.folderId} />
          ) : (
            <Link to="/" className="hidden rounded px-0.5 text-muted hover:text-text sm:inline">
              {meta.label}
            </Link>
          )}
          <span className="hidden text-faint sm:inline">/</span>
          <TitleField artifact={artifact} editable={editable} />
          {!editable && (
            <span
              className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-border bg-surface px-2 text-[12px] font-medium text-muted"
              title={guest ? "You opened a share link. You can follow along live but not edit." : "Your role in this org can view but not edit."}
            >
              <LockSimpleIcon size={12} weight="bold" /> View only
            </span>
          )}
          {linkGuest && import.meta.env.DEV && (
            <a href="/api/v1/share/exit" className="shrink-0 text-[12px] text-faint hover:text-muted" title="Dev: drop the share cookie">
              Leave link view
            </a>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {connection && (
            <span className="text-[12px] text-muted" role="status">
              {connection === "connecting" ? "Connecting…" : connection === "reconnecting" ? "Reconnecting…" : "Offline"}
            </span>
          )}
          <PresenceStack live={live} kindLabel={meta.singular} />
          {principal && !guest && (
            <button
              ref={shareButton}
              type="button"
              onClick={() => setSharing(true)}
              className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-[filter,background-color] ${
                editable ? "bg-accent text-accent-text hover:brightness-110 active:brightness-95" : "border border-border hover:bg-hover"
              }`}
            >
              <ShareFatIcon size={15} weight="fill" className="max-sm:hidden" />
              Share
            </button>
          )}
          {editable && <HeaderMenu kindLabel={meta.singular} title={artifact.title} onMove={() => setMoving(true)} onArchive={onArchive} onDelete={onDelete} />}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {principal && kind === "table" && <LiveTable key={artifact.id} id={artifact.id} principal={principal} devAs={devAs} onLive={onLive} item={item} />}
        {principal && kind === "board" && <LiveBoard key={artifact.id} id={artifact.id} principal={principal} devAs={devAs} onLive={onLive} item={item} />}
        {principal && kind === "tracker" && (
          <LiveTracker key={artifact.id} id={artifact.id} principal={principal} devAs={devAs} onLive={onLive} title={artifact.title} item={item} />
        )}
        {principal && kind === "doc" && (
          <LiveDoc
            key={artifact.id}
            id={artifact.id}
            principal={principal}
            devAs={devAs}
            onLive={onLive}
            title={artifact.title}
            onTitleChange={editable ? renameFromView : undefined}
          />
        )}
      </div>

      {moving && <MoveDialog item={{ type: "artifact", id: artifact.id, title: artifact.title }} onClose={() => setMoving(false)} />}
      {sharing && principal && <ShareDialog artifact={artifact} principal={principal} devAs={devAs} onClose={closeShare} />}
    </div>
  )
}

/** The breadcrumb's title: rename in place (Enter saves, Escape reverts). Plain text when read-only. */
function TitleField({ artifact, editable }: { artifact: Artifact; editable: boolean }) {
  const { rename } = useWorkspace()
  const [title, setTitle] = useState(artifact.title)
  useEffect(() => setTitle(artifact.title), [artifact.id, artifact.title])

  if (!editable) return <h1 className="min-w-0 truncate px-1 font-medium">{artifact.title}</h1>

  const commit = () => {
    const next = title.trim()
    if (!next) return setTitle(artifact.title)
    if (next !== artifact.title) void rename(artifact.id, next)
  }

  return (
    <input
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        if (e.key === "Escape") {
          setTitle(artifact.title)
          e.currentTarget.blur()
        }
      }}
      aria-label="Title"
      title="Rename"
      spellCheck={false}
      className="field-sizing-content max-w-full min-w-[3ch] truncate rounded-md bg-transparent px-1.5 py-0.5 font-medium outline-none hover:bg-hover focus:bg-hover focus:ring-2 focus:ring-accent/25"
    />
  )
}

const VIEW_KEY = "standard-artifacts:table-view"

type LiveProps = { id: string; principal: Principal; devAs: string; onLive: (live: LivePresence) => void }

/** Hand the room's people, agents and connection status up to the header. */
function useReportLive(snapshot: RoomSnapshot<unknown>, onLive: LiveProps["onLive"]) {
  const { self, others, status } = snapshot
  useEffect(() => onLive({ self, others, status }), [self, others, status, onLive])
}

/** WebSocket address of an artifact's cell. In dev, `as` switches the caller (honored only with AUTH_MODE=dev). */
function roomUrl(id: string, devAs: string) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws"
  const as = import.meta.env.DEV && devAs !== "owner" ? `?as=${devAs}` : ""
  return `${proto}://${window.location.host}/api/v1/rooms/${id}${as}`
}

/** Store an image in a board's or doc's cell and return its URL. */
const imageUploader = (id: string, devAs: string) => async (file: Blob) => {
  const res = await fetch(`/api/v1/artifacts/${id}/assets`, {
    method: "POST",
    headers: { "content-type": file.type, ...(import.meta.env.DEV && devAs !== "owner" ? { "x-dev-as": devAs } : {}) },
    body: file,
  })
  const data = (await res.json().catch(() => ({}))) as { url?: string; message?: string }
  if (!res.ok || !data.url) throw new Error(data.message ?? `Upload failed (${res.status})`)
  return data.url
}

const LiveBoard = memo(function LiveBoard({ id, principal, devAs, onLive, item }: LiveProps & { item: string | undefined }) {
  const { room, snapshot } = useBoardRoom(roomUrl(id, devAs), actorKey(principal.actor))
  useReportLive(snapshot, onLive)
  const uploadImage = useMemo(() => imageUploader(id, devAs), [id, devAs])
  const ai = useMemo(() => agentRequests(id, devAs), [id, devAs])
  const itemLink = useCallback((shapeId: string) => `${window.location.origin}/${kinds.board.slug}/${id}/${shapeId}`, [id])
  const links = useMemo<BoardLinks>(
    () => ({
      embed: (target) => <ArtifactEmbed target={target} fill />,
      chip: (target) => <ArtifactChip target={target} />,
      picker: ({ onPick, onClose }) => <EmbedPicker exclude={id} onPick={onPick} onClose={onClose} />,
    }),
    [id],
  )
  return <BoardView room={room} snapshot={snapshot} uploadImage={uploadImage} ai={ai} focus={item} itemLink={itemLink} links={links} />
})

const LiveDoc = memo(function LiveDoc({
  id,
  principal,
  devAs,
  onLive,
  title,
  onTitleChange,
}: LiveProps & { title: string; onTitleChange: ((title: string) => void) | undefined }) {
  const { room, snapshot } = useDocRoom(roomUrl(id, devAs), actorKey(principal.actor))
  useReportLive(snapshot, onLive)
  const ai = useMemo(() => agentRequests(id, devAs), [id, devAs])
  const uploadImage = useMemo(() => imageUploader(id, devAs), [id, devAs])
  const embeds = useMemo<DocEmbeds>(
    () => ({
      render: (target) => <ArtifactEmbed target={target} />,
      picker: ({ onPick, onClose }) => <EmbedPicker exclude={id} onPick={onPick} onClose={onClose} />,
    }),
    [id],
  )
  return <DocView room={room} snapshot={snapshot} ai={ai} uploadImage={uploadImage} embeds={embeds} title={title} {...(onTitleChange && { onTitleChange })} />
})

/**
 * A doc's or board's line to the agent runner: requests go to the org's
 * mention inbox (the typed API client adds `x-dev-as` in dev), and status comes
 * from polling this artifact's requests.
 */
function agentRequests(artifactId: string, devAs: string): AgentRequests {
  const run = <A,>(f: (client: Effect.Success<ReturnType<typeof api>>) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(api(devAs).pipe(Effect.flatMap(f), Effect.mapError(errorMessage), Effect.mapError((m) => new Error(m))))
  return {
    ask: (request) => run((c) => c.mentions.create({ payload: { artifactId, ...request } })),
    cancel: (id) => run((c) => c.mentions.cancel({ params: { id } })),
    resolve: (id) => run((c) => c.mentions.resolve({ params: { id } })),
    mentions: () => run((c) => c.mentions.list({ query: { artifactId } })),
  }
}

/** A tracker: the list at /issues/:id, one issue's page at /issues/:id/:number. */
const LiveTracker = memo(function LiveTracker({ id, principal, devAs, onLive, title, item }: LiveProps & { title: string; item: string | undefined }) {
  const { room, snapshot } = useTrackerRoom(roomUrl(id, devAs), actorKey(principal.actor))
  useReportLive(snapshot, onLive)
  const { artifacts } = useWorkspace()
  const navigate = useNavigate()
  const workspace = useMemo<TrackerWorkspace>(
    () => ({
      artifacts,
      preview: (a) => <Preview artifact={a} />,
      icon: (kind) => <KindIcon kind={kind} size={14} />,
      open: (artifactId) => {
        const a = artifacts.find((x) => x.id === artifactId)
        const kind = a?.kind ?? kindOfId(artifactId)
        if (kind) void navigate({ to: "/$kind/$id/{-$item}", params: { kind: kinds[kind].slug, id: artifactId, item: undefined } })
      },
    }),
    [artifacts, navigate],
  )
  const number = item && /^\d+$/.test(item) ? Number(item) : undefined
  const onIssuePage = useCallback(
    (n: number | null) => void navigate({ to: "/$kind/$id/{-$item}", params: { kind: kinds.tracker.slug, id, item: n === null ? undefined : String(n) } }),
    [navigate, id],
  )
  return <TrackerView room={room} snapshot={snapshot} trackerId={id} workspace={workspace} issueNumber={number} onIssuePage={onIssuePage} title={title} />
})

const LiveTable = memo(function LiveTable({ id, principal, devAs, onLive, item }: LiveProps & { item: string | undefined }) {
  const { room, snapshot } = useTableRoom(roomUrl(id, devAs), actorKey(principal.actor))
  useReportLive(snapshot, onLive)
  const [view, setView] = useState<TableViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "kanban" ? "kanban" : "grid"
    } catch {
      return "grid"
    }
  })
  const changeView = (v: TableViewMode) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // per-viewer convenience only
    }
  }
  const { artifacts } = useWorkspace()
  const links = useMemo<TableLinks>(
    () => ({
      chip: (target) => <ArtifactChip target={target} />,
      titleOf: (artifactId) => artifacts.find((a) => a.id === artifactId)?.title,
      // Nothing excluded: a row can link another row of its own table.
      picker: ({ initialQuery, onPick, onBackspace, onClose }) => <EmbedPicker keepOpen initialQuery={initialQuery} onPick={onPick} onBackspace={onBackspace} onClose={() => onClose()} />,
    }),
    [artifacts],
  )
  return <TableView room={room} snapshot={snapshot} view={view} onViewChange={changeView} presence={false} openRow={item} links={links} />
})
