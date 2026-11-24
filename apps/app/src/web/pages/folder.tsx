import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import { CaretDownIcon, FolderOpenIcon, FolderPlusIcon, PlusIcon, RowsIcon, SquaresFourIcon } from "@phosphor-icons/react"
import { folderPath, folderTrail, kindOrder, kinds, maxFolderDepth, uniqueFolderName, type ArtifactKind, type Folder } from "@standard-artifacts/protocol"
import { useWorkspace } from "../workspace"
import { SidebarToggle } from "../components/sidebar-collapse"
import { KindIcon, KindTile } from "../components/kind-icon"
import { Popover, useDismiss } from "../components/header-popover"
import { ArtifactCard, ArtifactList, FolderGrid, LayoutButton, useLayout } from "../components/artifact-list"
import { FolderMenu } from "../components/folder-menu"
import { FolderNameInput } from "../components/folder-name-input"

/** A folder: the breadcrumb is its title, subfolders come first, and everything can be created right here. */
export function FolderPage() {
  const { id } = useParams({ from: "/folders/$id" })
  const { folders, artifacts, editable, status, principal, create, createFolder } = useWorkspace()
  const navigate = useNavigate()
  const folder = folders.find((f) => f.id === id)
  const [layout, setLayout] = useLayout()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setAdding(false)
    setRenaming(false)
  }, [id])

  const items = useMemo(
    () => artifacts.filter((a) => a.folderId === id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [artifacts, id],
  )
  const subfolders = useMemo(() => folders.filter((f) => f.parentId === id), [folders, id])

  if (status === "loading") return null
  if (!folder) {
    return (
      <div className="p-8 text-muted">
        Not found. <Link to="/" className="text-accent">Go home</Link>
      </div>
    )
  }

  const canNest = folderTrail(folders, folder.id).length < maxFolderDepth

  const onCreate = async (kind: ArtifactKind) => {
    setBusy(true)
    const a = await create(kind, folder.id)
    setBusy(false)
    if (a) void navigate({ to: "/$kind/$id/{-$item}", params: { kind: kinds[kind].slug, id: a.id, item: undefined } })
  }

  const empty = items.length === 0 && subfolders.length === 0 && !adding

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <SidebarToggle placement="page" className="-ml-1.5 -mr-1" />
        <Breadcrumb folder={folder} orgName={principal?.orgName ?? "Home"} renaming={renaming} onRenamingChange={setRenaming} />
        {editable && (
          <div className="flex shrink-0 items-center gap-2">
            {canNest && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                aria-label="New folder"
                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] font-medium hover:bg-hover max-sm:w-8 max-sm:justify-center max-sm:px-0"
              >
                <FolderPlusIcon size={15} />
                <span className="max-sm:hidden">New folder</span>
              </button>
            )}
            <NewMenu disabled={busy} onCreate={onCreate} />
            <FolderMenu folder={folder} onRename={() => setRenaming(true)} className="size-8 rounded-md hover:bg-hover" />
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1080px] px-4 py-6 md:px-10">
          {adding && (
            <FolderNameInput
              initial={uniqueFolderName(folders, "New folder", folder.id)}
              label="New folder name"
              className="mb-4 h-10 max-w-sm rounded-lg border border-accent px-3"
              onCancel={() => setAdding(false)}
              onSubmit={async (name) => {
                await createFolder(name, folder.id)
                setAdding(false)
              }}
            />
          )}

          {empty ? (
            <div className="flex flex-col items-center gap-1.5 py-16 text-center">
              <FolderOpenIcon size={26} weight="duotone" className="text-faint" />
              <div className="font-medium">This folder is empty</div>
              {editable ? (
                <>
                  <p className="text-[13px] text-muted">Create something here, or drag items in from the sidebar.</p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {kindOrder.map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        disabled={busy}
                        onClick={() => void onCreate(kind)}
                        className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-[13px] hover:bg-hover disabled:opacity-60"
                      >
                        <KindTile kind={kind} size={22} />
                        New {kinds[kind].singular.toLowerCase()}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-[13px] text-muted">Nothing has been added yet.</p>
              )}
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-[13px] text-muted" data-folder-count>
                  {describe(subfolders.length, items.length)}
                </p>
                <div className="flex shrink-0 rounded-md border border-border p-0.5">
                  <LayoutButton active={layout === "grid"} onClick={() => setLayout("grid")} label="Grid view">
                    <SquaresFourIcon size={15} />
                  </LayoutButton>
                  <LayoutButton active={layout === "list"} onClick={() => setLayout("list")} label="List view">
                    <RowsIcon size={15} />
                  </LayoutButton>
                </div>
              </div>

              {layout === "list" ? (
                <ArtifactList items={items} folders={subfolders} principal={principal} timeFor={(a) => a.updatedAt} timeLabel="Updated" />
              ) : (
                <div className="space-y-4">
                  {subfolders.length > 0 && <FolderGrid folders={subfolders} layout="grid" />}
                  {items.length > 0 && (
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))] sm:gap-4">
                      {items.map((a) => (
                        <li key={a.id}>
                          <ArtifactCard artifact={a} principal={principal} time={a.updatedAt} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const describe = (subfolders: number, items: number) =>
  [subfolders ? `${subfolders} folder${subfolders === 1 ? "" : "s"}` : "", items ? `${items} item${items === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")

/** Home / … / Parent / Name. The last crumb is the title: rename in place, Enter saves and Escape reverts. */
function Breadcrumb({
  folder,
  orgName,
  renaming,
  onRenamingChange,
}: {
  folder: Folder
  orgName: string
  renaming: boolean
  onRenamingChange: (on: boolean) => void
}) {
  const { folders, editable, updateFolder, fail } = useWorkspace()
  const [name, setName] = useState(folder.name)
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  useEffect(() => setName(folder.name), [folder.id, folder.name])
  useEffect(() => {
    if (!renaming) return
    input.current?.focus()
    input.current?.select()
  }, [renaming])

  const ancestors = folderTrail(folders, folder.parentId)
  const shown = ancestors.slice(-2)
  const commit = async () => {
    onRenamingChange(false)
    // Escape blurs too, and this closure still holds the abandoned text.
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const next = name.trim()
    if (!next || next === folder.name) return setName(folder.name)
    if (next.includes("/")) {
      setName(folder.name)
      return fail("Folder names can't contain a slash")
    }
    try {
      await updateFolder(folder.id, { name: next })
    } catch (e) {
      setName(folder.name)
      fail((e as Error).message)
    }
  }

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2" title={folderPath(folders, folder.id)}>
      <Crumb to={null}>{orgName}</Crumb>
      {ancestors.length > shown.length && (
        <>
          <Slash />
          <span className="hidden text-muted sm:inline">…</span>
        </>
      )}
      {shown.map((f) => (
        <span key={f.id} className="contents">
          <Slash />
          <Crumb to={f.id}>{f.name}</Crumb>
        </span>
      ))}
      <Slash />
      {editable ? (
        <input
          ref={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
            if (e.key === "Escape") {
              cancelled.current = true
              setName(folder.name)
              e.currentTarget.blur()
            }
          }}
          maxLength={80}
          aria-label="Folder name"
          title="Rename"
          spellCheck={false}
          className="field-sizing-content max-w-full min-w-[3ch] truncate rounded-md bg-transparent px-1.5 py-0.5 font-medium outline-none hover:bg-hover focus:bg-hover focus:ring-2 focus:ring-accent/25"
        />
      ) : (
        <h1 className="min-w-0 truncate px-1 font-medium">{folder.name}</h1>
      )}
    </nav>
  )
}

function Slash() {
  return <span className="hidden text-faint sm:inline">/</span>
}

function Crumb({ to, children }: { to: string | null; children: ReactNode }) {
  const className = "hidden max-w-[160px] truncate rounded px-0.5 text-muted hover:text-text sm:inline"
  return to ? (
    <Link to="/folders/$id" params={{ id: to }} className={className}>
      {children}
    </Link>
  ) : (
    <Link to="/" className={className}>
      {children}
    </Link>
  )
}

/** Create a board, table, doc or tracker in this folder. */
function NewMenu({ disabled, onCreate }: { disabled: boolean; onCreate: (kind: ArtifactKind) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 items-center gap-1 rounded-md bg-accent px-2.5 text-[13px] font-medium text-accent-text transition-[filter] hover:brightness-110 active:brightness-95 disabled:opacity-60"
      >
        <PlusIcon size={14} weight="bold" /> New <CaretDownIcon size={11} weight="bold" className="opacity-80" />
      </button>
      {open && (
        <Popover label="Create in this folder" className="w-44 p-1">
          <div role="menu">
            {kindOrder.map((kind) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  void onCreate(kind)
                }}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"
              >
                <KindIcon kind={kind} size={16} /> {kinds[kind].singular}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}
