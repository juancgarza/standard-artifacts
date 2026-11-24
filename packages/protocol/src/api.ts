import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint as E, HttpApiGroup, HttpApiMiddleware } from "effect/http-api"
import { BoardState } from "./board.ts"
import { Artifact, ArtifactAccess, CreateArtifact, CreateFolder, CurrentPrincipal, Folder, Id, MoveArtifact, OrgDirectory, ShareLink, UpdateArtifact, UpdateFolder, WorkspaceSnapshot } from "./core.ts"
import { DocState } from "./doc.ts"
import { ClaimMention, CompleteMention, CreateMention, Mention } from "./mention.ts"
import { AgentPresence, OpsApplied, OpsBatch } from "./room.ts"
import { Reindexed, SearchQuery, SearchResults } from "./search.ts"
import { TableState } from "./table.ts"
import { TrackerState } from "./tracker.ts"

/**
 * The HTTP contract. The worker implements it with HttpApiBuilder; the browser
 * and agents call it with HttpApiClient. WebSocket upgrades (/api/v1/rooms/:id)
 * sit outside it because they hand a raw socket to a cell.
 */

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { message: Schema.String }, { httpApiStatus: 401 }) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { message: Schema.String }, { httpApiStatus: 403 }) {}
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String }, { httpApiStatus: 404 }) {}
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", { message: Schema.String }, { httpApiStatus: 400 }) {}

export const ApiErrors = [Forbidden, NotFound, Invalid]
export type ApiError = Forbidden | NotFound | Invalid

/** Resolves the caller from a ticket (or the dev fallback) and provides CurrentPrincipal. */
export class Authentication extends HttpApiMiddleware.Service<Authentication, { provides: CurrentPrincipal }>()(
  "@standard-artifacts/Authentication",
  { error: [Unauthorized] },
) {}

/** Turns request decoding failures into `Invalid` with a readable message (default is an empty 400). */
export class ValidationErrors extends HttpApiMiddleware.Service<ValidationErrors>()("@standard-artifacts/ValidationErrors", {
  error: [Invalid],
}) {}

const params = { id: Id }

const contentFields = { artifact: Artifact, seq: Schema.Int, text: Schema.String }

/**
 * An artifact's live content plus a compact text rendering for agents
 * (table rows, board shapes, or the doc as markdown).
 */
export const RoomContent = Schema.Union([
  Schema.Struct({ kind: Schema.tag("table"), state: TableState, ...contentFields }),
  Schema.Struct({ kind: Schema.tag("board"), state: BoardState, ...contentFields }),
  Schema.Struct({ kind: Schema.tag("doc"), state: DocState, ...contentFields }),
  Schema.Struct({ kind: Schema.tag("tracker"), state: TrackerState, ...contentFields }),
])
export type RoomContent = typeof RoomContent.Type

export const WorkspaceGroup = HttpApiGroup.make("workspace")
  .add(
    E.get("snapshot", "/workspace", { success: WorkspaceSnapshot, error: ApiErrors }),
    /** Who has shown up in the org. Roles come from the account service, so this only reads. Not for guests. */
    E.get("members", "/members", { success: OrgDirectory, error: ApiErrors }),
    E.post("createArtifact", "/artifacts", { payload: CreateArtifact, success: Artifact, error: ApiErrors }),
    E.patch("updateArtifact", "/artifacts/:id", { params, payload: UpdateArtifact, success: Artifact, error: ApiErrors }),
    E.delete("deleteArtifact", "/artifacts/:id", { params, success: Artifact, error: ApiErrors }),
    E.get("archivedArtifacts", "/artifacts/archived", { success: Schema.Array(Artifact), error: ApiErrors }),
    E.post("archiveArtifact", "/artifacts/:id/archive", { params, success: Artifact, error: ApiErrors }),
    E.post("restoreArtifact", "/artifacts/:id/restore", { params, success: Artifact, error: ApiErrors }),
    E.post("moveArtifact", "/artifacts/:id/move", { params, payload: MoveArtifact, success: Artifact, error: ApiErrors }),
    E.post("createFolder", "/folders", { payload: CreateFolder, success: Folder, error: ApiErrors }),
    E.patch("updateFolder", "/folders/:id", { params, payload: UpdateFolder, success: Folder, error: ApiErrors }),
    /** Deletes only the folder: what's inside moves up to its parent. */
    E.delete("deleteFolder", "/folders/:id", { params, success: Folder, error: ApiErrors }),
  )
  .middleware(ValidationErrors)
  .middleware(Authentication)

/** The same three calls work on every surface; ops are decoded by the artifact's own cell. */
export const RoomsGroup = HttpApiGroup.make("rooms")
  .add(
    E.get("content", "/artifacts/:id/content", { params, success: RoomContent, error: ApiErrors }),
    E.post("applyOps", "/artifacts/:id/ops", { params, payload: OpsBatch, success: OpsApplied, error: ApiErrors }),
    E.post("agentPresence", "/artifacts/:id/presence", { params, payload: AgentPresence, error: ApiErrors }),
  )
  .middleware(ValidationErrors)
  .middleware(Authentication)

/** One artifact's requests (newest first), or the org's 50 newest. */
export const MentionsQuery = Schema.Struct({ artifactId: Schema.optionalKey(Id) })

/** The @-mention inbox: people's mentions wait here until an agent runner claims and completes them. */
export const MentionsGroup = HttpApiGroup.make("mentions")
  .add(
    E.get("list", "/mentions", { query: MentionsQuery, success: Schema.Array(Mention), error: ApiErrors }),
    E.post("create", "/mentions", { payload: CreateMention, success: Mention, error: ApiErrors }),
    E.post("cancel", "/mentions/:id/cancel", { params, success: Mention, error: ApiErrors }),
    /** Resolve the mention's whole thread (every request on the same target); active ones are cancelled. */
    E.post("resolve", "/mentions/:id/resolve", { params, success: Schema.Array(Mention), error: ApiErrors }),
    E.post("claim", "/mentions/claim", { payload: ClaimMention, success: Schema.NullOr(Mention), error: ApiErrors }),
    E.post("complete", "/mentions/:id/complete", { params, payload: CompleteMention, success: Mention, error: ApiErrors }),
  )
  .middleware(ValidationErrors)
  .middleware(Authentication)

/**
 * Who has access to an artifact, and its read-only share link. Opening a link
 * (GET /api/v1/share/:token) is a browser navigation that sets a cookie, so it
 * sits outside the HttpApi like room sockets.
 */
export const SharingGroup = HttpApiGroup.make("sharing")
  .add(
    E.get("access", "/artifacts/:id/access", { params, success: ArtifactAccess, error: ApiErrors }),
    E.post("createLink", "/artifacts/:id/link", { params, success: ShareLink, error: ApiErrors }),
    E.delete("deleteLink", "/artifacts/:id/link", { params, error: ApiErrors }),
  )
  .middleware(ValidationErrors)
  .middleware(Authentication)

/** Search across the workspace's content. A share-link guest searches only the artifact it was shared. */
export const SearchGroup = HttpApiGroup.make("search")
  .add(
    E.get("query", "/search", { query: SearchQuery, success: SearchResults, error: ApiErrors }),
    /** Owners only. Re-embeds everything: for a new embedding model, or content from before search was on. */
    E.post("reindex", "/search/reindex", { success: Reindexed, error: ApiErrors }),
  )
  .middleware(ValidationErrors)
  .middleware(Authentication)

export const Api = HttpApi.make("StandardArtifacts")
  .add(WorkspaceGroup)
  .add(RoomsGroup)
  .add(MentionsGroup)
  .add(SharingGroup)
  .add(SearchGroup)
  .prefix("/api/v1")
