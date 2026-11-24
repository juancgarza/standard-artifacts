import { useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { ArrowsLeftRightIcon, FolderIcon, RobotIcon } from "@phosphor-icons/react"
import { actorKey, folderPath, kinds, type Artifact, type Folder, type Principal } from "@standard-artifacts/protocol"
import { BrandTile, brandOf } from "@standard-artifacts/tracker"
import { useWorkspace } from "../workspace"
import { KindIcon, KindTile } from "./kind-icon"
import { StarButton } from "./sidebar-star"
import { Preview } from "./home-preview"
import { useDragItem, useDropTarget } from "./folder-dnd"
import { FolderMenu } from "./folder-menu"
import { FolderNameInput } from "./folder-name-input"
import { MoveDialog } from "./move-dialog"
import { timeAgo } from "../time"

/** The artifact cards and rows shared by Home and folder pages. */

export type Layout = "grid" | "list"

const LAYOUT_KEY = "standard-artifacts:home-layout"
export const PAGE = { grid: 12, list: 25 }

const readLayout = (): Layout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"
  } catch {
    return "grid"
  }
}

/** Grid or list, remembered per browser. */
export function useLayout() {
  const [layout, setLayoutState] = useState<Layout>(readLayout)
  const setLayout = (l: Layout) => {
    setLayoutState(l)
    try {
      localStorage.setItem(LAYOUT_KEY, l)
    } catch {
      // per-viewer convenience only
    }
  }
  return [layout, setLayout] as const
}

export function LayoutButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`grid size-7 place-items-center rounded ${active ? "bg-active text-text" : "text-muted hover:text-text"}`}
    >
      {children}
    </button>
  )
}

/**
 * Who made it, from the viewer's side: "You", a teammate, or an agent with
 * the mark of the app it came from (Claude Code, ChatGPT, Codex).
 */
function Creator({ artifact, principal }: { artifact: Artifact; principal: Principal | null }) {
  const { createdBy, createdByName, client } = artifact
  if (createdBy.startsWith("agt_")) {
    const name = client ?? createdByName ?? "Agent"
    const brand = brandOf(client) ?? brandOf(createdByName)
    return (
      <span className="inline-flex min-w-0 items-center gap-1" title={`Created by ${createdByName ?? "an agent"}${client && client !== createdByName ? ` in ${client}` : ""}`} data-creator-brand={brand ?? undefined}>
        {brand ? <BrandTile brand={brand} size={14} /> : <RobotIcon size={13} weight="duotone" className="shrink-0 text-accent" />}
        <span className="truncate">{name}</span>
      </span>
    )
  }
  if (principal && createdBy === actorKey(principal.actor)) return <span>You</span>
  return <span>{createdByName ?? "Teammate"}</span>
}

/** The hover "move" action. Its dialog is the caller's to render, outside any link, so clicks in it don't navigate. */
function MoveButton({ title, onMove, className = "" }: { title: string; onMove: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onMove()
      }}
      aria-label="Move to folder"
      title={`Move ${title} to folder`}
      className={`grid size-6 place-items-center rounded text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-active hover:text-text focus-visible:opacity-100 max-md:opacity-100 ${className}`}
    >
      <ArrowsLeftRightIcon size={14} weight="bold" />
    </button>
  )
}

export function ArtifactCard({ artifact, principal, time }: { artifact: Artifact; principal: Principal | null; time: string }) {
  const { editable } = useWorkspace()
  const drag = useDragItem()
  const [moving, setMoving] = useState(false)
  return (
    <>
      <div className="group relative" {...drag({ type: "artifact", id: artifact.id })}>
        <Link
          to="/$kind/$id/{-$item}"
          params={{ kind: kinds[artifact.kind].slug, id: artifact.id, item: undefined }}
          className="block overflow-hidden rounded-lg border border-border bg-bg transition-[border-color,box-shadow] hover:border-faint/70 hover:shadow-[0_2px_10px_-2px_rgba(0,0,0,0.08)] focus-visible:outline-2 focus-visible:outline-accent"
        >
          <div className="relative h-[108px] border-b border-border bg-surface sm:h-[132px]">
            <Preview artifact={artifact} />
            <StarButton id={artifact.id} title={artifact.title} className="absolute top-1.5 right-1.5 bg-bg/90 shadow-sm" />
          </div>
          <div className="flex items-start gap-2.5 px-3 py-2.5">
            <KindIcon kind={artifact.kind} size={16} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{artifact.title}</div>
              <div className="mt-0.5 flex items-center gap-1 truncate text-[12px] text-faint">
                <Creator artifact={artifact} principal={principal} />
                <span aria-hidden>·</span>
                <span>{timeAgo(time)}</span>
              </div>
            </div>
          </div>
        </Link>
        {editable && <MoveButton title={artifact.title} onMove={() => setMoving(true)} className="absolute top-1.5 right-8 bg-bg/90 shadow-sm" />}
      </div>
      {moving && <MoveDialog item={{ type: "artifact", id: artifact.id, title: artifact.title }} onClose={() => setMoving(false)} />}
    </>
  )
}

function ArtifactRow({
  artifact,
  principal,
  time,
  showLocation,
}: {
  artifact: Artifact
  principal: Principal | null
  time: string
  showLocation: boolean
}) {
  const { folders, editable } = useWorkspace()
  const drag = useDragItem()
  const [moving, setMoving] = useState(false)
  const location = showLocation && artifact.folderId ? folderPath(folders, artifact.folderId) : ""
  return (
    <li className="group relative" {...drag({ type: "artifact", id: artifact.id })}>
      <Link
        to="/$kind/$id/{-$item}"
        params={{ kind: kinds[artifact.kind].slug, id: artifact.id, item: undefined }}
        className="flex h-12 items-center gap-3 rounded-md px-2 hover:bg-surface"
      >
        <KindTile kind={artifact.kind} size={28} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate font-medium">{artifact.title}</span>
          {location && <span className="hidden min-w-0 shrink-[2] truncate text-[12px] text-faint sm:inline">{location}</span>}
        </span>
        <span className="hidden w-16 text-[13px] text-muted sm:block">{kinds[artifact.kind].singular}</span>
        <span className="hidden w-28 truncate text-[13px] text-muted sm:block">
          <Creator artifact={artifact} principal={principal} />
        </span>
        <span className="w-24 text-right text-[13px] text-faint">{timeAgo(time)}</span>
        <span className="w-14" />
      </Link>
      <span className="absolute top-1/2 right-2 flex -translate-y-1/2 gap-1">
        {editable && <MoveButton title={artifact.title} onMove={() => setMoving(true)} />}
        <StarButton id={artifact.id} title={artifact.title} />
      </span>
      {moving && <MoveDialog item={{ type: "artifact", id: artifact.id, title: artifact.title }} onClose={() => setMoving(false)} />}
    </li>
  )
}

export function ArtifactList({
  items,
  folders = [],
  principal,
  timeFor,
  timeLabel,
  showLocation = false,
}: {
  items: ReadonlyArray<Artifact>
  folders?: ReadonlyArray<Folder>
  principal: Principal | null
  timeFor: (a: Artifact) => string
  timeLabel: string
  showLocation?: boolean
}) {
  return (
    <div>
      <ListHeader timeLabel={timeLabel} />
      <ul className="divide-y divide-border">
        {folders.map((f) => (
          <FolderEntry key={f.id} folder={f} layout="list" />
        ))}
        {items.map((a) => (
          <ArtifactRow key={a.id} artifact={a} principal={principal} time={timeFor(a)} showLocation={showLocation} />
        ))}
      </ul>
    </div>
  )
}

function ListHeader({ timeLabel }: { timeLabel: string }) {
  return (
    <div className="hidden h-8 items-center gap-3 border-b border-border px-2 text-[12px] text-faint sm:flex">
      <span className="flex-1 pl-10">Name</span>
      <span className="w-16">Type</span>
      <span className="w-28">Created by</span>
      <span className="w-24 text-right">{timeLabel}</span>
      <span className="w-14" />
    </div>
  )
}

/** Folders on their own: a row of tiles, or list rows. */
export function FolderGrid({ folders, layout }: { folders: ReadonlyArray<Folder>; layout: Layout }) {
  if (layout === "list") {
    return (
      <div>
        <ListHeader timeLabel="Updated" />
        <ul className="divide-y divide-border">
          {folders.map((f) => (
            <FolderEntry key={f.id} folder={f} layout="list" />
          ))}
        </ul>
      </div>
    )
  }
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))] sm:gap-4">
      {folders.map((f) => (
        <FolderEntry key={f.id} folder={f} layout="grid" />
      ))}
    </ul>
  )
}

/** A folder as a tile or list row. Open it, drop things on it, drag it, rename it in place. */
function FolderEntry({ folder, layout }: { folder: Folder; layout: Layout }) {
  const { folders, artifacts, editable, updateFolder } = useWorkspace()
  const drag = useDragItem()
  const drop = useDropTarget(folder.id)
  const [renaming, setRenaming] = useState(false)
  const subfolders = folders.filter((f) => f.parentId === folder.id).length
  const count = subfolders + artifacts.filter((a) => a.folderId === folder.id).length
  const countLabel = count === 0 ? "Empty" : `${count} item${count === 1 ? "" : "s"}`
  const highlight = drop.over ? "bg-accent/10 ring-2 ring-accent/50" : ""
  const rename = (
    <FolderNameInput
      initial={folder.name}
      label={`Rename ${folder.name}`}
      className={layout === "grid" ? "h-[58px] rounded-lg border border-accent px-3" : "h-12 px-2"}
      onCancel={() => setRenaming(false)}
      onSubmit={async (name) => {
        if (name !== folder.name) await updateFolder(folder.id, { name })
        setRenaming(false)
      }}
    />
  )

  if (layout === "grid") {
    return (
      <li {...drop.props} {...drag({ type: "folder", id: folder.id })} className={`group relative rounded-lg ${highlight}`}>
        {renaming ? (
          rename
        ) : (
          <>
            <Link
              to="/folders/$id"
              params={{ id: folder.id }}
              className="flex h-[58px] items-center gap-2.5 rounded-lg border border-border bg-bg pr-8 pl-3 transition-[border-color,box-shadow] hover:border-faint/70 hover:shadow-[0_2px_10px_-2px_rgba(0,0,0,0.08)] focus-visible:outline-2 focus-visible:outline-accent"
            >
              <FolderIcon size={22} weight="duotone" className="shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{folder.name}</span>
                <span className="block text-[12px] text-faint">{countLabel}</span>
              </span>
            </Link>
            {editable && (
              <span className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 max-md:opacity-100">
                <FolderMenu folder={folder} onRename={() => setRenaming(true)} />
              </span>
            )}
          </>
        )}
      </li>
    )
  }

  return (
    <li {...drop.props} {...drag({ type: "folder", id: folder.id })} className={`group relative ${highlight}`}>
      {renaming ? (
        rename
      ) : (
        <>
          <Link to="/folders/$id" params={{ id: folder.id }} className="flex h-12 items-center gap-3 rounded-md px-2 hover:bg-surface">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-active/70" aria-hidden>
              <FolderIcon size={17} weight="duotone" className="text-muted" />
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="min-w-0 truncate font-medium">{folder.name}</span>
              <span className="shrink-0 text-[12px] text-faint">{countLabel}</span>
            </span>
            <span className="hidden w-16 text-[13px] text-muted sm:block">Folder</span>
            <span className="hidden w-28 sm:block" />
            <span className="w-24 text-right text-[13px] text-faint">{timeAgo(folder.updatedAt)}</span>
            <span className="w-14" />
          </Link>
          {editable && (
            <span className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 max-md:opacity-100">
              <FolderMenu folder={folder} onRename={() => setRenaming(true)} />
            </span>
          )}
        </>
      )}
    </li>
  )
}
