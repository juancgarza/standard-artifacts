import { Context, Schema, SchemaIssue } from "effect"

/**
 * Shared contract between the web app, the cells, and (soon) the MCP server.
 * Every write is decoded with these schemas whether it arrives over HTTP, a
 * WebSocket op, or an MCP tool call.
 */

export const ArtifactKind = Schema.Literals(["board", "table", "doc", "tracker"])
export type ArtifactKind = typeof ArtifactKind.Type

/** Display metadata per kind. `slug` is the URL segment (/boards/:id); `prefix` starts its ids (b_…). */
export const kinds: Record<ArtifactKind, { slug: string; label: string; singular: string; prefix: string }> = {
  board: { slug: "boards", label: "Boards", singular: "Board", prefix: "b" },
  table: { slug: "tables", label: "Tables", singular: "Table", prefix: "t" },
  doc: { slug: "docs", label: "Docs", singular: "Doc", prefix: "d" },
  tracker: { slug: "issues", label: "Issues", singular: "Tracker", prefix: "i" },
}
export const kindOrder: ReadonlyArray<ArtifactKind> = ["board", "table", "doc", "tracker"]
export const kindFromSlug = (slug: string): ArtifactKind | undefined => kindOrder.find((k) => kinds[k].slug === slug)

/** Ids are short, URL-safe tokens. */
export const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64), Schema.isPattern(/^[\w-]+$/))

/** Trims, then requires 1–200 characters. */
export const Title = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))

export const Artifact = Schema.Struct({
  id: Id,
  kind: ArtifactKind,
  title: Schema.String,
  createdBy: Schema.String,
  /** The creator's display name when it's known ("JC", "Claude"). */
  createdByName: Schema.optionalKey(Schema.String),
  /** The app an agent created it from ("Claude Code", "ChatGPT", "Codex"), when it said. */
  client: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Set while archived: hidden everywhere, content kept, until it's restored. */
  archivedAt: Schema.optionalKey(Schema.String),
  /** The folder it's in; absent at the workspace root. */
  folderId: Schema.optionalKey(Id),
})
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

/** One path segment of a namespace, so it can't hold a slash. */
export const FolderName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80), Schema.isPattern(/^[^/]+$/))

/**
 * A place for artifacts in the UI and a namespace in the API: its path
 * ("Marketing/Launch") names it for the CLI and agents. Folders organize; they
 * don't control access, which stays org-wide.
 */
export const Folder = Schema.Struct({
  id: Id,
  name: Schema.String,
  /** Null at the workspace root. */
  parentId: Schema.NullOr(Id),
  createdBy: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export interface Folder extends Schema.Schema.Type<typeof Folder> {}

export const CreateFolder = Schema.Struct({ name: FolderName, parentId: Schema.optionalKey(Schema.NullOr(Id)) })
export interface CreateFolder extends Schema.Schema.Type<typeof CreateFolder> {}

/** Rename, move, or both. `parentId: null` moves it to the root. */
export const UpdateFolder = Schema.Struct({ name: Schema.optionalKey(FolderName), parentId: Schema.optionalKey(Schema.NullOr(Id)) })
export interface UpdateFolder extends Schema.Schema.Type<typeof UpdateFolder> {}

export const MoveArtifact = Schema.Struct({ folderId: Schema.NullOr(Id) })
export interface MoveArtifact extends Schema.Schema.Type<typeof MoveArtifact> {}

export const maxFolderDepth = 6

/** A folder and its ancestors, root first. Empty if it doesn't exist. */
export const folderTrail = (folders: ReadonlyArray<Folder>, id: string | null | undefined): Array<Folder> => {
  const trail: Array<Folder> = []
  for (let f = folders.find((x) => x.id === id); f && !trail.includes(f); f = folders.find((x) => x.id === f!.parentId)) trail.unshift(f)
  return trail
}

/** "Marketing/Launch", the folder's namespace. Empty at the root. */
export const folderPath = (folders: ReadonlyArray<Folder>, id: string | null | undefined) =>
  folderTrail(folders, id).map((f) => f.name).join("/")

export const parseFolderPath = (path: string) => path.split("/").map((s) => s.trim()).filter(Boolean)

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The folder at a path (ignoring case). Undefined if any segment is missing or the path is empty. */
export const findFolderByPath = (folders: ReadonlyArray<Folder>, segments: ReadonlyArray<string>) => {
  let parentId: string | null = null
  let found: Folder | undefined
  for (const name of segments) {
    found = folders.find((f) => f.parentId === parentId && sameName(f.name, name))
    if (!found) return undefined
    parentId = found.id
  }
  return found
}

/** Levels in a folder's subtree, counting itself. */
const subtreeHeight = (folders: ReadonlyArray<Folder>, id: string): number =>
  1 + Math.max(0, ...folders.filter((f) => f.parentId === id).map((f) => subtreeHeight(folders, f.id)))

/**
 * Why a folder can't have this name and parent, or null if it can. The cell
 * enforces it; the move dialog uses it to rule out destinations. `id` is the
 * folder being changed, absent for a new one.
 */
export const folderProblem = (
  folders: ReadonlyArray<Folder>,
  next: { readonly id?: string; readonly name: string; readonly parentId: string | null },
): string | null => {
  const above = folderTrail(folders, next.parentId)
  if (next.id && above.some((f) => f.id === next.id)) return "A folder can't move inside itself"
  if (above.length + (next.id ? subtreeHeight(folders, next.id) : 1) > maxFolderDepth) return `Folders can nest up to ${maxFolderDepth} levels`
  const taken = folders.some((f) => f.id !== next.id && f.parentId === next.parentId && sameName(f.name, next.name))
  return taken ? `A folder named "${next.name}" is already here` : null
}

/** `name`, or "name 2", "name 3"… if a sibling already has it. */
export const uniqueFolderName = (folders: ReadonlyArray<Folder>, name: string, parentId: string | null) => {
  const taken = (candidate: string) => folders.some((f) => f.parentId === parentId && sameName(f.name, candidate))
  let candidate = name
  for (let n = 2; taken(candidate); n++) candidate = `${name} ${n}`
  return candidate
}

/**
 * A reference from one artifact to another, or to one item inside it (a row,
 * a shape, a block, an issue). Any surface can hold these; an artifact may
 * reference itself (an issue linking another issue in the same tracker).
 */
export const ArtifactRef = Schema.Struct({
  artifactId: Id,
  item: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
})
export interface ArtifactRef extends Schema.Schema.Type<typeof ArtifactRef> {}
export const sameRef = (a: ArtifactRef, b: ArtifactRef) => a.artifactId === b.artifactId && (a.item ?? null) === (b.item ?? null)

/**
 * The artifact (and item) an app URL points at, or null for anything else:
 * folders, Home, plain text, and other sites when `origin` says whose links count.
 */
export function parseArtifactUrl(text: string, origin?: string): ArtifactRef | null {
  const raw = text.trim()
  if (!/^https?:\/\//.test(raw) || /\s/.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const m = url.pathname.match(/^\/(\w+)\/([\w-]{1,64})(?:\/([\w-]{1,64}))?\/?$/)
  if ((origin !== undefined && url.origin !== origin) || !m?.[1] || !m[2] || !kindFromSlug(m[1])) return null
  return { artifactId: m[2], ...(m[3] && { item: m[3] }) }
}

export const CreateArtifact = Schema.Struct({
  kind: ArtifactKind,
  title: Schema.optionalKey(Title),
  /** The app creating it, for attribution ("Claude Code"). MCP fills this in from the session. */
  client: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
  /** The folder to put it in; the workspace root when absent. */
  folderId: Schema.optionalKey(Id),
})
export interface CreateArtifact extends Schema.Schema.Type<typeof CreateArtifact> {}

export const UpdateArtifact = Schema.Struct({ title: Title })
export interface UpdateArtifact extends Schema.Schema.Type<typeof UpdateArtifact> {}

/**
 * Who is acting. Agents always act on behalf of a user, and that user is what
 * shows up in attribution ("Agent for JC"). Agents are not seats.
 */
export const UserActor = Schema.Struct({ type: Schema.tag("user"), id: Schema.String, name: Schema.String })
export const GuestActor = Schema.Struct({ type: Schema.tag("guest"), id: Schema.String })
export const AgentActor = Schema.Struct({
  type: Schema.tag("agent"),
  id: Schema.String,
  onBehalfOf: Schema.String,
  /** Display name, e.g. "Claude". Optional: older tickets don't carry one. */
  name: Schema.optionalKey(Schema.String),
})
export const Actor = Schema.Union([UserActor, GuestActor, AgentActor])
export type Actor = typeof Actor.Type

export const Role = Schema.Literals(["viewer", "editor", "owner"])
export type Role = typeof Role.Type

/** free = one human who edits (plus agents, plus read-only guest links); team = multiplayer, billed per Owner and Editor. */
export const Plan = Schema.Literals(["free", "team"])
export type Plan = typeof Plan.Type

/**
 * The claims a cell trusts. In production these arrive in a short-lived ticket
 * signed (HMAC) by the account service, because celld can only verify HMAC.
 */
export const Principal = Schema.Struct({
  orgId: Schema.String,
  orgName: Schema.String,
  actor: Actor,
  role: Role,
  plan: Plan,
  /**
   * Set for share-link guests: the one artifact this principal may open.
   * Everything else in the org reads as not found.
   */
  scope: Schema.optionalKey(Id),
})
export interface Principal extends Schema.Schema.Type<typeof Principal> {}

export const Ticket = Principal.pipe(Schema.fieldsAssign({ exp: Schema.Int }))
export interface Ticket extends Schema.Schema.Type<typeof Ticket> {}

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()("@standard-artifacts/CurrentPrincipal") {}

export const canEdit = (p: Principal) => p.role !== "viewer" && p.actor.type !== "guest"

export const WorkspaceSnapshot = Schema.Struct({
  principal: Principal,
  artifacts: Schema.Array(Artifact),
  folders: Schema.Array(Folder),
  /** "dev": a local server with no sign-in (`stdartifacts serve`, `pnpm dev`), where agents connect without a token. */
  authMode: Schema.optionalKey(Schema.Literals(["dev", "live"])),
  /** True when this server bills (Standard Artifacts Cloud): Settings shows Billing. */
  billing: Schema.optionalKey(Schema.Boolean),
})
export interface WorkspaceSnapshot extends Schema.Schema.Type<typeof WorkspaceSnapshot> {}

// --- Sharing ----------------------------------------------------------------------

/**
 * A read-only share link. Opening `path` in a browser sets a cookie and lands
 * on the artifact as a guest scoped to it; the token also works as a bearer
 * token for the CLI and scripts. One active link per artifact; deleting it
 * turns the link off for everyone who has it.
 */
export const ShareLink = Schema.Struct({
  token: Schema.String,
  path: Schema.String,
  role: Schema.Literal("viewer"),
  createdBy: Schema.String,
  createdAt: Schema.String,
})
export interface ShareLink extends Schema.Schema.Type<typeof ShareLink> {}

export const sharePath = (token: string) => `/api/v1/share/${token}`

/** A person in the org who has opened it. Roles come from the account service (tickets), not from here. */
export const AccessPerson = Schema.Struct({ id: Schema.String, name: Schema.String, role: Role, lastSeenAt: Schema.String })
export interface AccessPerson extends Schema.Schema.Type<typeof AccessPerson> {}

/** An agent that has acted in the org. It acts for `onBehalfOf` with that person's access and takes no seat. */
export const AccessAgent = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  name: Schema.String,
  onBehalfOf: Schema.String,
  onBehalfOfName: Schema.NullOr(Schema.String),
  role: Role,
  lastSeenAt: Schema.String,
})
export interface AccessAgent extends Schema.Schema.Type<typeof AccessAgent> {}

/**
 * Who can open an artifact. Access is org-wide (every member reaches every
 * artifact with their org role), so `people` and `agents` are the org's
 * members and agents that have shown up, plus the artifact's share link.
 */
export const ArtifactAccess = Schema.Struct({
  artifactId: Id,
  orgName: Schema.String,
  plan: Plan,
  createdBy: Schema.String,
  people: Schema.Array(AccessPerson),
  agents: Schema.Array(AccessAgent),
  link: Schema.NullOr(ShareLink),
  /** Whether the caller can turn the link on or off. */
  canManage: Schema.Boolean,
})
export interface ArtifactAccess extends Schema.Schema.Type<typeof ArtifactAccess> {}

/** The org's members and agents that have shown up, most recently active first. */
export const OrgDirectory = Schema.Struct({
  people: Schema.Array(AccessPerson),
  agents: Schema.Array(AccessAgent),
})
export interface OrgDirectory extends Schema.Schema.Type<typeof OrgDirectory> {}

/** Flattens a schema failure into one readable line for API errors. */
export const formatIssue = SchemaIssue.makeFormatterDefault()
