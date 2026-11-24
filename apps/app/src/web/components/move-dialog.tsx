import { useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { FolderIcon, FolderPlusIcon, HouseIcon, MagnifyingGlassIcon } from "@phosphor-icons/react"
import { folderPath, folderProblem, uniqueFolderName, type Folder } from "@standard-artifacts/protocol"
import { useWorkspace } from "../workspace"
import { FolderNameInput } from "./folder-name-input"

export type Movable = { type: "artifact" | "folder"; id: string; title: string }

type Option = { id: string | null; label: string; depth: number; path: string; blocked: string | null }

/** Every destination in tree order, with why a folder can't go there (itself, too deep, a taken name). */
function destinations(folders: ReadonlyArray<Folder>, item: Movable): Option[] {
  const moving = item.type === "folder" ? folders.find((f) => f.id === item.id) : undefined
  const blocked = (parentId: string | null) => (moving ? folderProblem(folders, { id: moving.id, name: moving.name, parentId }) : null)
  const out: Option[] = [{ id: null, label: "Workspace", depth: 0, path: "", blocked: blocked(null) }]
  const walk = (parentId: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parentId)) {
      out.push({ id: f.id, label: f.name, depth, path: folderPath(folders, f.id), blocked: blocked(f.id) })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 1)
  return out
}

/** Move an artifact or folder: filter, pick a folder in the tree, or make one here. */
export function MoveDialog({ item, onClose }: { item: Movable; onClose: () => void }) {
  const { folders, artifacts, moveArtifact, updateFolder, createFolder } = useWorkspace()
  const current =
    (item.type === "artifact" ? artifacts.find((a) => a.id === item.id)?.folderId : folders.find((f) => f.id === item.id)?.parentId) ?? null
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string | null>(current)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const options = useMemo(() => {
    const all = destinations(folders, item)
    const q = query.trim().toLowerCase()
    return q ? all.filter((o) => o.id !== null && o.path.toLowerCase().includes(q)) : all
  }, [folders, item, query])

  // Filtering picks the first match, so typing then Enter moves it.
  useEffect(() => {
    if (!query.trim()) return
    setSelected(options.find((o) => !o.blocked)?.id ?? current)
  }, [query])

  // Focus the filter; hand focus back to wherever it was on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" })
  }, [selected])

  const target = options.find((o) => o.id === selected)
  const unchanged = selected === current
  const canMove = !!target && !target.blocked && !unchanged && !busy

  const onMove = async () => {
    if (!canMove) return
    setBusy(true)
    setError(null)
    try {
      if (item.type === "artifact") await moveArtifact(item.id, selected)
      else await updateFolder(item.id, { parentId: selected })
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const step = (by: number) => {
    const open = options.filter((o) => !o.blocked)
    if (!open.length) return
    const at = open.findIndex((o) => o.id === selected)
    const next = at < 0 ? (by > 0 ? 0 : open.length - 1) : (at + by + open.length) % open.length
    setSelected(open[next]!.id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      if (creating) setCreating(false)
      else onClose()
    }
    if (creating) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      step(1)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      step(-1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      void onMove()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="presentation" onKeyDown={onKeyDown}>
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 cursor-default bg-black/25 dark:bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${item.title}`}
        className="palette-in relative flex max-h-[min(520px,76vh)] w-[440px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-[0_24px_64px_-12px_rgba(0,0,0,0.28),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <h2 className="truncate px-4 pt-4 pb-2.5 font-semibold">Move “{item.title}” to folder</h2>
        <div className="mx-4 flex h-9 shrink-0 items-center gap-2 rounded-md border border-border px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
          <MagnifyingGlassIcon size={15} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter folders"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Folders" className="mt-2 min-h-[160px] flex-1 space-y-px overflow-y-auto px-3 pb-2">
          {options.map((o) => {
            const on = o.id === selected
            return (
              <div
                key={o.id ?? "root"}
                role="option"
                aria-selected={on}
                aria-disabled={!!o.blocked}
                title={o.blocked ?? o.path}
                onClick={() => !o.blocked && setSelected(o.id)}
                onDoubleClick={() => {
                  if (!o.blocked && o.id !== current) void onMove()
                }}
                style={query.trim() ? undefined : { paddingLeft: 8 + Math.max(0, o.depth - 1) * 18 }}
                className={`flex h-8 items-center gap-2 rounded-md px-2 text-[13px] ${
                  o.blocked ? "cursor-not-allowed text-faint" : on ? "cursor-pointer bg-active font-medium" : "cursor-pointer hover:bg-hover"
                }`}
              >
                {o.id === null ? <HouseIcon size={15} className="shrink-0 text-muted" /> : <FolderIcon size={15} weight="duotone" className="shrink-0 text-muted" />}
                <span className="min-w-0 flex-1 truncate">{query.trim() ? o.path : o.label}</span>
                {o.id === current && <span className="shrink-0 rounded-full border border-border px-1.5 text-[11px] font-normal text-muted">Current</span>}
              </div>
            )
          })}
          {options.length === 0 && <div className="px-2 py-6 text-center text-[13px] text-muted">No folders match “{query.trim()}”</div>}
          {creating && (
            <FolderNameInput
              initial={uniqueFolderName(folders, "New folder", selected)}
              label="New folder name"
              className="h-8 rounded-md bg-hover px-2"
              onCancel={() => setCreating(false)}
              onSubmit={async (name) => {
                const folder = await createFolder(name, selected)
                setCreating(false)
                setQuery("")
                setSelected(folder.id)
              }}
            />
          )}
        </div>

        {error && <p className="px-4 pb-2 text-[12px] text-danger">{error}</p>}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2.5">
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={creating}
            title={target ? `New folder in ${target.path || "Workspace"}` : "New folder"}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted hover:bg-hover hover:text-text disabled:opacity-50"
          >
            <FolderPlusIcon size={15} /> New folder
          </button>
          <div className="flex gap-1.5">
            <button type="button" onClick={onClose} className="h-8 rounded-md px-3 text-[13px] text-muted hover:bg-hover hover:text-text">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onMove()}
              disabled={!canMove}
              className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-text transition-[filter] hover:brightness-110 active:brightness-95 disabled:opacity-40"
            >
              {busy ? "Moving…" : "Move here"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
