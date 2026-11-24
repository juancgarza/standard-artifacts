import { useEffect, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { CaretRightIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, PlusIcon } from "@phosphor-icons/react"
import { folderTrail, kindOrder, kinds, uniqueFolderName, type Artifact, type Folder } from "@standard-artifacts/protocol"
import { useWorkspace } from "../workspace"
import { KindIcon } from "./kind-icon"
import { useDragItem, useDropTarget } from "./folder-dnd"
import { FolderMenu } from "./folder-menu"
import { FolderNameInput } from "./folder-name-input"
import { Row, SectionHeader, useActiveId } from "./sidebar-parts"

const byTitle = (a: Artifact, b: Artifact) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })

/** Folders and their artifacts in one tree. The kind sections below stay as views across every folder. */
export function Folders({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { folders, editable, principal, status, createFolder, artifacts, expandFolders } = useWorkspace()
  const activeId = useActiveId()
  const [open, setOpen] = useState(true)
  const [adding, setAdding] = useState(false)
  const root = useDropTarget(null)
  const roots = folders.filter((f) => f.parentId === null)

  // The open folder, or the folder of the open artifact, shows in the tree. It can still be collapsed after.
  const activeFolder = folders.some((f) => f.id === activeId) ? activeId : artifacts.find((a) => a.id === activeId)?.folderId
  const known = folders.length > 0
  useEffect(() => {
    if (!known || !activeFolder) return
    expandFolders(folderTrail(folders, activeFolder).map((f) => f.id))
    // Only when the page changes: collapsing the current folder has to stick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolder, known, expandFolders])

  if (principal?.scope) return null
  if (!editable && status === "ready" && folders.length === 0) return null

  return (
    <section aria-label="Folders" {...root.props} className={root.over ? "rounded-md bg-accent/10 ring-2 ring-accent/50" : undefined}>
      <SectionHeader open={open} onToggle={() => setOpen((o) => !o)} label="Folders" count={roots.length}>
        {editable && (
          <button
            type="button"
            onClick={() => {
              setOpen(true)
              setAdding(true)
            }}
            aria-label="New folder"
            title="New folder"
            className="grid size-6 place-items-center rounded text-muted opacity-0 group-hover:opacity-100 hover:bg-active hover:text-text focus-visible:opacity-100 max-md:opacity-100"
          >
            <PlusIcon size={14} weight="bold" />
          </button>
        )}
      </SectionHeader>
      {open && (
        <ul className="mt-0.5 space-y-px">
          {adding && (
            <li>
              <FolderNameInput
                initial={uniqueFolderName(folders, "New folder", null)}
                label="New folder name"
                className="h-8 rounded-md bg-hover px-2"
                onCancel={() => setAdding(false)}
                onSubmit={async (name) => {
                  await createFolder(name, null)
                  setAdding(false)
                }}
              />
            </li>
          )}
          {roots.map((f) => (
            <FolderNode key={f.id} folder={f} onNavigate={onNavigate} />
          ))}
          {status === "ready" && folders.length === 0 && !adding && (
            <li className="px-2 py-1 text-[13px] text-faint">
              <button type="button" onClick={() => setAdding(true)} className="hover:text-muted">
                + New folder
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

function FolderNode({ folder, onNavigate }: { folder: Folder; onNavigate?: (() => void) | undefined }) {
  const { folders, artifacts, editable, openFolders, toggleFolder, expandFolders, createFolder, updateFolder } = useWorkspace()
  const open = openFolders.has(folder.id)
  const [renaming, setRenaming] = useState(false)
  const [adding, setAdding] = useState(false)
  const drop = useDropTarget(folder.id)
  const drag = useDragItem()
  const children = folders.filter((f) => f.parentId === folder.id)
  const items = artifacts.filter((a) => a.folderId === folder.id).sort(byTitle)
  const Icon = open ? FolderOpenIcon : FolderIcon

  const startAdding = () => {
    expandFolders([folder.id])
    setAdding(true)
  }

  return (
    // The whole subtree takes drops, so landing on a row inside a folder files it there. The innermost folder wins.
    <li {...drop.props}>
      <div
        {...drag({ type: "folder", id: folder.id })}
        className={`group relative rounded-md ${drop.over ? "bg-accent/10 ring-2 ring-accent/50" : ""}`}
        data-folder={folder.name}
      >
        {renaming ? (
          <FolderNameInput
            initial={folder.name}
            label={`Rename ${folder.name}`}
            className="h-8 rounded-md bg-hover px-2"
            onCancel={() => setRenaming(false)}
            onSubmit={async (name) => {
              if (name !== folder.name) await updateFolder(folder.id, { name })
              setRenaming(false)
            }}
          />
        ) : (
          <>
            <Link
              to="/folders/$id"
              params={{ id: folder.id }}
              onClick={onNavigate}
              className="flex h-8 items-center gap-1.5 rounded-md pr-2 pl-6 group-focus-within:pr-14 group-hover:pr-14 hover:bg-hover"
              activeProps={{ className: "bg-active font-medium" }}
            >
              <Icon size={16} weight="duotone" className="shrink-0 text-muted" />
              <span className="truncate">{folder.name}</span>
            </Link>
            <button
              type="button"
              onClick={() => toggleFolder(folder.id)}
              aria-label={open ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
              aria-expanded={open}
              className="absolute top-1.5 left-1 grid size-5 place-items-center rounded text-faint hover:bg-active hover:text-text"
            >
              <CaretRightIcon size={11} weight="bold" className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
            </button>
            {editable && (
              <div className="absolute top-1 right-1 flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 max-md:opacity-100">
                <NewInFolder folder={folder} onNewSubfolder={startAdding} onNavigate={onNavigate} />
                <FolderMenu folder={folder} onRename={() => setRenaming(true)} onNewSubfolder={startAdding} />
              </div>
            )}
          </>
        )}
      </div>
      {open && (
        <ul className="mt-px ml-[14px] space-y-px border-l border-border pl-1">
          {adding && (
            <li>
              <FolderNameInput
                initial={uniqueFolderName(folders, "New folder", folder.id)}
                label="New folder name"
                className="h-8 rounded-md bg-hover px-2"
                onCancel={() => setAdding(false)}
                onSubmit={async (name) => {
                  await createFolder(name, folder.id)
                  setAdding(false)
                }}
              />
            </li>
          )}
          {children.map((f) => (
            <FolderNode key={f.id} folder={f} onNavigate={onNavigate} />
          ))}
          {items.map((a) => (
            <Row key={a.id} artifact={a} onNavigate={onNavigate} />
          ))}
          {children.length === 0 && items.length === 0 && !adding && <li className="px-2 py-1 text-[13px] text-faint">Empty</li>}
        </ul>
      )}
    </li>
  )
}

/** The hover "+": a new subfolder or artifact right in this folder. */
function NewInFolder({ folder, onNewSubfolder, onNavigate }: { folder: Folder; onNewSubfolder: () => void; onNavigate?: (() => void) | undefined }) {
  const { create, expandFolders } = useWorkspace()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [open])

  const onCreate = async (kind: (typeof kindOrder)[number]) => {
    setOpen(false)
    const artifact = await create(kind, folder.id)
    if (!artifact) return
    expandFolders([folder.id])
    onNavigate?.()
    void navigate({ to: "/$kind/$id/{-$item}", params: { kind: kinds[kind].slug, id: artifact.id, item: undefined } })
  }

  const item = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`New in ${folder.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="New in this folder"
        className="grid size-6 place-items-center rounded text-muted hover:bg-active hover:text-text focus-visible:opacity-100"
      >
        <PlusIcon size={14} weight="bold" />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div role="menu" aria-label={`New in ${folder.name}`} className="absolute top-full right-0 z-50 mt-1 w-44 rounded-lg border border-border bg-bg p-1 shadow-lg">
            {kindOrder.map((kind) => (
              <button key={kind} type="button" role="menuitem" onClick={() => void onCreate(kind)} className={item}>
                <KindIcon kind={kind} size={16} /> {kinds[kind].singular}
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onNewSubfolder()
              }}
              className={item}
            >
              <FolderPlusIcon size={16} className="text-muted" /> Subfolder
            </button>
          </div>
        </>
      )}
    </>
  )
}
