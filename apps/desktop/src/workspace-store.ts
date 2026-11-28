import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { addServer, allWorkspaces, parseSaved, serializeSaved, type SavedWorkspaces, type Workspace } from "./workspaces"

/** The workspace list, kept in userData/workspaces.json. */
export interface WorkspaceStore {
  readonly all: () => ReadonlyArray<Workspace>
  readonly get: (id: string) => Workspace | undefined
  /** The workspace used last, or undefined before anyone has picked one. */
  readonly last: () => Workspace | undefined
  readonly setLast: (id: string) => void
  /** Adds a server by origin (already checked by `serverOrigin`), or returns the one at that address. */
  readonly add: (origin: string) => Workspace
  /** Called after the list or the last workspace changes. */
  readonly onChange: (listener: () => void) => void
}

export function createWorkspaceStore(cloudOrigin: string): WorkspaceStore {
  const file = join(app.getPath("userData"), "workspaces.json")
  let saved: SavedWorkspaces
  try {
    saved = parseSaved(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    saved = { servers: [], last: null }
  }
  const listeners = new Set<() => void>()
  const save = (next: SavedWorkspaces) => {
    saved = next
    try {
      writeFileSync(file, serializeSaved(saved))
    } catch {
      // Kept for this run; the next launch asks again.
    }
    for (const listener of listeners) listener()
  }
  const all = () => allWorkspaces(cloudOrigin, saved)
  const get = (id: string) => all().find((w) => w.id === id)
  return {
    all,
    get,
    last: () => (saved.last ? get(saved.last) : undefined),
    setLast: (id) => {
      if (saved.last !== id && get(id)) save({ ...saved, last: id })
    },
    add: (origin) => {
      const { saved: next, workspace } = addServer(cloudOrigin, saved, origin)
      if (next !== saved) save(next)
      return workspace
    },
    onChange: (listener) => void listeners.add(listener),
  }
}
