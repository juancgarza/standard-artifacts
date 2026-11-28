/**
 * The workspaces the desktop app can show: Standard Artifacts Cloud, the Solo
 * server on this computer, and servers people host themselves. Each one is a
 * server; a Cloud workspace's orgs are switched by the page itself.
 *
 * Kept free of Electron so it can be tested on its own. Each workspace gets its
 * own session (cookies, storage), so signing in to Cloud never reaches the local
 * server, and switching never signs anyone out.
 */
import { createHash } from "node:crypto"
import type { DesktopWorkspace, DesktopWorkspaceKind } from "@standard-artifacts/protocol"

export interface Workspace {
  readonly id: string
  readonly kind: DesktopWorkspaceKind
  readonly label: string
  /** Where its pages load from. Only ever from this list, never from a page. */
  readonly origin: string
}

export const CLOUD_ID = "cloud"
export const LOCAL_ID = "local"
/** `stdartifacts serve`'s default port (DEFAULT_PORT in @standard-artifacts/server). */
export const LOCAL_ORIGIN = "http://localhost:4747"

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

export function builtInWorkspaces(cloudOrigin: string): ReadonlyArray<Workspace> {
  return [
    { id: CLOUD_ID, kind: "cloud", label: "Standard Artifacts Cloud", origin: cloudOrigin },
    { id: LOCAL_ID, kind: "local", label: "This computer", origin: LOCAL_ORIGIN },
  ]
}

/**
 * The origin of a server address someone typed, or null. `acme.example.com` means https.
 * Plain http is only for this computer: anywhere else it would send the session in the clear.
 */
export function serverOrigin(input: string): string | null {
  const text = input.trim()
  if (!text || /\s/.test(text)) return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    if (url.username || url.password) return null
    if (url.protocol === "https:") return url.origin
    if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.origin
    return null
  } catch {
    return null
  }
}

/** A stable id for a server, from its origin. */
export const serverId = (origin: string) => `server-${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`

export const serverWorkspace = (origin: string): Workspace => ({ id: serverId(origin), kind: "server", label: new URL(origin).host, origin })

/** What's saved in workspaces.json: the servers someone added, and the workspace they used last. */
export interface SavedWorkspaces {
  readonly servers: ReadonlyArray<Workspace>
  readonly last: string | null
}

/** Reads a saved file defensively: anything that isn't a valid server is dropped. */
export function parseSaved(json: unknown): SavedWorkspaces {
  const value = typeof json === "object" && json !== null ? (json as { servers?: unknown; last?: unknown }) : {}
  const origins = Array.isArray(value.servers) ? value.servers.filter((s): s is string => typeof s === "string") : []
  const servers = [...new Set(origins.map(serverOrigin).filter((o): o is string => o !== null))].map(serverWorkspace)
  return { servers, last: typeof value.last === "string" ? value.last : null }
}

export const serializeSaved = (saved: SavedWorkspaces) => JSON.stringify({ servers: saved.servers.map((s) => s.origin), last: saved.last })

/** Every workspace, built-ins first. A saved server at a built-in's address is the built-in. */
export function allWorkspaces(cloudOrigin: string, saved: SavedWorkspaces): ReadonlyArray<Workspace> {
  const builtIns = builtInWorkspaces(cloudOrigin)
  const taken = new Set(builtIns.map((w) => w.origin))
  return [...builtIns, ...saved.servers.filter((s) => !taken.has(s.origin))]
}

/** Adds a server by origin; if it's already there (or is a built-in), returns that one. */
export function addServer(cloudOrigin: string, saved: SavedWorkspaces, origin: string): { readonly saved: SavedWorkspaces; readonly workspace: Workspace } {
  const existing = allWorkspaces(cloudOrigin, saved).find((w) => w.origin === origin)
  if (existing) return { saved, workspace: existing }
  const workspace = serverWorkspace(origin)
  return { saved: { ...saved, servers: [...saved.servers, workspace] }, workspace }
}

/** What the page may see: no addresses, so it has nothing to send back but an id. */
export const toPublic = (w: Workspace): DesktopWorkspace => (w.kind === "server" ? { id: w.id, kind: w.kind, label: w.label, detail: w.label } : { id: w.id, kind: w.kind, label: w.label })

/** The session partition a workspace's windows use. */
export const partitionOf = (w: Workspace) => `persist:workspace-${w.id}`

// --- The app's own screens (data: pages) ----------------------------------------------------

/**
 * Where the app's own screens (the workspace chooser, the can't-connect page) send their
 * choices. `.invalid` never resolves, and a navigation there is always stopped: the app
 * acts on it only when one of those screens made it, never when a server's page did.
 * (A custom-scheme link would go out to the OS and come back as an ordinary deep link.)
 */
export const SCREEN_ORIGIN = "https://desktop.stdartifacts.invalid"

export type ScreenAction =
  | { readonly type: "open"; readonly id: string }
  | { readonly type: "add"; readonly address: string }
  | { readonly type: "choose" }

/** True for any navigation to SCREEN_ORIGIN, honoured or not. */
export function isScreenUrl(url: string): boolean {
  try {
    return new URL(url).origin === SCREEN_ORIGIN
  } catch {
    return false
  }
}

export function screenAction(url: string): ScreenAction | null {
  if (!isScreenUrl(url)) return null
  const link = new URL(url)
  const action = link.pathname.replace(/^\/+|\/+$/g, "")
  if (action === "open") {
    const id = link.searchParams.get("workspace")
    return id ? { type: "open", id } : null
  }
  if (action === "add") return { type: "add", address: link.searchParams.get("address") ?? "" }
  if (action === "choose") return { type: "choose" }
  return null
}
