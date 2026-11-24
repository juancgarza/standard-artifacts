import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "@tanstack/react-router"
import { ArrowsLeftRightIcon, DotsThreeIcon, FolderPlusIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react"
import { folderPath, type Artifact, type Folder } from "@standard-artifacts/protocol"
import { useWorkspace } from "../workspace"
import { MoveDialog } from "./move-dialog"

/** What deleting a folder does to what's in it. */
export function folderDeleteMessage(folder: Folder, folders: ReadonlyArray<Folder>, artifacts: ReadonlyArray<Artifact>) {
  const inside = folders.filter((f) => f.parentId === folder.id).length + artifacts.filter((a) => a.folderId === folder.id).length
  const destination = folderPath(folders, folder.parentId) || "the workspace root"
  return inside > 0 ? `The ${inside === 1 ? "item" : `${inside} items`} in “${folder.name}” will move to ${destination}. Nothing else is deleted.` : `“${folder.name}” is empty.`
}

/**
 * A folder's overflow menu. It renders in a portal, positioned from its button,
 * because the sidebar clips overflow and its peek panel would capture fixed
 * positioning. Delete asks once, inline, and says where the contents will go.
 */
export function FolderMenu({
  folder,
  onRename,
  onNewSubfolder,
  className = "",
}: {
  folder: Folder
  onRename: () => void
  onNewSubfolder?: () => void
  className?: string
}) {
  const { folders, artifacts, removeFolder, fail } = useWorkspace()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [moving, setMoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const close = () => {
    setOpen(false)
    setConfirming(false)
  }

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node
      if (!panel.current?.contains(t) && !button.current?.contains(t)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopPropagation()
      close()
      button.current?.focus()
    }
    document.addEventListener("pointerdown", onPointer, true)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("pointerdown", onPointer, true)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])

  // Sits under the button, kept inside the window; re-measured when the confirm step changes its height.
  useLayoutEffect(() => {
    if (!open || !button.current || !panel.current) return
    const b = button.current.getBoundingClientRect()
    const p = panel.current.getBoundingClientRect()
    const margin = 8
    const below = b.bottom + 4
    const top = below + p.height > window.innerHeight - margin ? Math.max(margin, b.top - p.height - 4) : below
    setAt({ top, left: Math.min(Math.max(margin, b.left), window.innerWidth - p.width - margin) })
  }, [open, confirming])

  const item = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"
  const pick = (run: () => void) => () => {
    close()
    run()
  }

  const onDelete = async () => {
    setBusy(true)
    const onPage = window.location.pathname === `/folders/${folder.id}`
    try {
      await removeFolder(folder.id)
      close()
      if (onPage) void (folder.parentId ? navigate({ to: "/folders/$id", params: { id: folder.parentId } }) : navigate({ to: "/" }))
    } catch (e) {
      fail((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (open) close()
          else setOpen(true)
        }}
        aria-label={`${folder.name} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        className={`grid size-6 place-items-center rounded text-muted hover:bg-active hover:text-text focus-visible:opacity-100 ${open ? "bg-active text-text opacity-100" : ""} ${className}`}
      >
        <DotsThreeIcon size={16} weight="bold" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={`${folder.name} actions`}
            style={at ? { top: at.top, left: at.left } : { top: 0, left: 0, visibility: "hidden" }}
            className="fixed z-50 w-60 rounded-lg border border-border bg-bg p-1 shadow-lg"
          >
            {confirming ? (
              <div className="p-2">
                <div className="text-[13px] font-medium">Delete this folder?</div>
                <p className="mt-1 text-[12px] leading-snug text-muted">
                  {folderDeleteMessage(folder, folders, artifacts)}
                </p>
                <div className="mt-3 flex justify-end gap-1.5">
                  <button type="button" onClick={() => setConfirming(false)} className="h-7 rounded-md px-2.5 text-[13px] text-muted hover:bg-hover hover:text-text">
                    Cancel
                  </button>
                  <button
                    type="button"
                    autoFocus
                    disabled={busy}
                    onClick={() => void onDelete()}
                    className="h-7 rounded-md bg-danger px-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-60"
                  >
                    {busy ? "Deleting…" : "Delete folder"}
                  </button>
                </div>
              </div>
            ) : (
              <div role="menu">
                {onNewSubfolder && (
                  <button type="button" role="menuitem" onClick={pick(onNewSubfolder)} className={item}>
                    <FolderPlusIcon size={16} className="text-muted" /> New subfolder
                  </button>
                )}
                <button type="button" role="menuitem" onClick={pick(onRename)} className={item}>
                  <PencilSimpleIcon size={16} className="text-muted" /> Rename
                </button>
                <button type="button" role="menuitem" onClick={pick(() => setMoving(true))} className={item}>
                  <ArrowsLeftRightIcon size={16} className="text-muted" /> Move to folder…
                </button>
                <div className="my-1 h-px bg-border" />
                <button type="button" role="menuitem" onClick={() => setConfirming(true)} className={`${item} text-danger`}>
                  <TrashIcon size={16} /> Delete folder…
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
      {moving && <MoveDialog item={{ type: "folder", id: folder.id, title: folder.name }} onClose={() => setMoving(false)} />}
    </>
  )
}
