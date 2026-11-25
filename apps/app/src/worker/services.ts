import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  BoardState,
  DocState,
  Forbidden,
  Invalid,
  NotFound,
  TableState,
  TrackerState,
  assetPath,
  boardToText,
  canEdit,
  docToMarkdown,
  searchArtifacts,
  searchSnippet,
  tableToText,
  trackerToText,
  type AgentPresence,
  type ApiToken,
  type CreatedApiToken,
  type Artifact,
  type ArtifactAccess,
  type ArtifactKind,
  type Reindexed,
  type SearchHit,
  type SearchResults,
  type ShareLink,
  type CreateArtifact,
  type CreateFolder,
  type CreateMention,
  type Folder,
  type Mention,
  type OpsApplied,
  type OrgDirectory,
  type Principal,
  type RoomContent,
  type UpdateArtifact,
  type UpdateFolder,
} from "@standard-artifacts/protocol"
import { ARTIFACT_HEADER, PRINCIPAL_HEADER, type ApplyOutcome, type PresenceOutcome } from "./cells/room"
import type { Asset, PutAsset } from "./cells/asset-cell"
import { SCOPE_HEADER, type CellResult, type FolderResult } from "./cells/workspace-cell"
import { Bindings } from "./env"
import { queryItems, searchConfig } from "./search-index"
import { hashApiToken, newApiToken } from "./session"

/**
 * Await a cell RPC call with its declared result type. (TypeScript widens a
 * stub's union return into a union of promises; awaiting collapses it.)
 */
const rpc = <T>(call: () => Promise<T>): Effect.Effect<T> => Effect.promise(async () => await call())

const fromCell = <T>(r: CellResult<T>): Effect.Effect<T, Forbidden | NotFound> =>
  r.ok
    ? Effect.succeed(r.value)
    : r.reason === "forbidden"
      ? Effect.fail(new Forbidden({ message: r.error }))
      : Effect.fail(new NotFound({ message: r.error }))

const fromFolderCell = <T>(r: FolderResult<T>): Effect.Effect<T, Forbidden | NotFound | Invalid> =>
  r.ok
    ? Effect.succeed(r.value)
    : r.reason === "forbidden"
      ? Effect.fail(new Forbidden({ message: r.error }))
      : r.reason === "invalid"
        ? Effect.fail(new Invalid({ message: r.error }))
        : Effect.fail(new NotFound({ message: r.error }))

/** A share-link guest sees one artifact and nothing of how the org files it. */
const withoutFolder = ({ folderId: _, ...artifact }: Artifact): Artifact => artifact

/** The org's artifact index (one WorkspaceCell per org). */
export class Workspaces extends Context.Service<
  Workspaces,
  {
    readonly list: (p: Principal) => Effect.Effect<ReadonlyArray<Artifact>>
    readonly get: (p: Principal, id: string) => Effect.Effect<Artifact, NotFound>
    readonly create: (p: Principal, input: CreateArtifact) => Effect.Effect<Artifact, Forbidden | NotFound>
    readonly update: (p: Principal, id: string, input: UpdateArtifact) => Effect.Effect<Artifact, Forbidden | NotFound>
    readonly remove: (p: Principal, id: string) => Effect.Effect<Artifact, Forbidden | NotFound>
    readonly archived: (p: Principal) => Effect.Effect<ReadonlyArray<Artifact>, Forbidden | NotFound>
    readonly archive: (p: Principal, id: string) => Effect.Effect<Artifact, Forbidden | NotFound>
    readonly restore: (p: Principal, id: string) => Effect.Effect<Artifact, Forbidden | NotFound>
    readonly moveArtifact: (p: Principal, id: string, folderId: string | null) => Effect.Effect<Artifact, Forbidden | NotFound | Invalid>
    readonly folders: (p: Principal) => Effect.Effect<ReadonlyArray<Folder>>
    readonly createFolder: (p: Principal, input: CreateFolder) => Effect.Effect<Folder, Forbidden | NotFound | Invalid>
    readonly updateFolder: (p: Principal, id: string, input: UpdateFolder) => Effect.Effect<Folder, Forbidden | NotFound | Invalid>
    readonly deleteFolder: (p: Principal, id: string) => Effect.Effect<Folder, Forbidden | NotFound | Invalid>
    readonly mentions: (p: Principal, artifactId?: string) => Effect.Effect<ReadonlyArray<Mention>>
    readonly resolveMention: (p: Principal, id: string) => Effect.Effect<ReadonlyArray<Mention>, Forbidden | NotFound>
    readonly claimMention: (p: Principal, runner: string, artifactId?: string) => Effect.Effect<Mention | null, Forbidden | NotFound>
    readonly completeMention: (p: Principal, id: string, status: "done" | "error", result: string) => Effect.Effect<Mention, Forbidden | NotFound>
    readonly createMention: (p: Principal, input: CreateMention) => Effect.Effect<Mention, Forbidden | NotFound>
    readonly cancelMention: (p: Principal, id: string) => Effect.Effect<Mention, Forbidden | NotFound>
    /** Remember an org member or agent in the org's directory (for "Who has access"). */
    readonly touch: (p: Principal) => Effect.Effect<void>
    readonly access: (p: Principal, id: string) => Effect.Effect<ArtifactAccess, Forbidden | NotFound>
    readonly directory: (p: Principal) => Effect.Effect<OrgDirectory, Forbidden | NotFound>
    readonly createLink: (p: Principal, id: string) => Effect.Effect<ShareLink, Forbidden | NotFound>
    readonly deleteLink: (p: Principal, id: string) => Effect.Effect<void, Forbidden | NotFound>
    /** A socket that says when the index changed, so open pages can read it again. */
    readonly connect: (p: Principal, request: Request) => Effect.Effect<Response>
    /** The caller's personal access tokens in this org. */
    readonly listTokens: (p: Principal) => Effect.Effect<ReadonlyArray<ApiToken>, Forbidden | NotFound>
    /** A new token. The only time its value is shown. */
    readonly createToken: (p: Principal, name: string) => Effect.Effect<CreatedApiToken, Forbidden | NotFound>
    readonly revokeToken: (p: Principal, id: string) => Effect.Effect<void, Forbidden | NotFound>
    /** Someone left the org: their tokens stop working. */
    readonly revokeUserTokens: (p: Principal, userId: string) => Effect.Effect<void>
  }
>()("@standard-artifacts/Workspaces") {
  static readonly layer = Layer.effect(
    Workspaces,
    Effect.gen(function* () {
      const env = yield* Bindings
      const cell = (p: Principal) => env.WORKSPACE.get(env.WORKSPACE.idFromName(p.orgId))

      return Workspaces.of({
        // A share-link guest (p.scope) sees only the artifact it was shared; the rest of the org reads as not found.
        list: Effect.fn("Workspaces.list")(function* (p) {
          const all = yield* rpc((): Promise<ReadonlyArray<Artifact>> => cell(p).list())
          return p.scope ? all.filter((a) => a.id === p.scope).map(withoutFolder) : all
        }),
        get: Effect.fn("Workspaces.get")(function* (p, id) {
          if (p.scope && p.scope !== id) return yield* new NotFound({ message: "Not found" })
          const artifact = yield* rpc((): Promise<Artifact | null> => cell(p).get(id))
          if (!artifact) return yield* new NotFound({ message: "Not found" })
          return p.scope ? withoutFolder(artifact) : artifact
        }),
        create: Effect.fn("Workspaces.create")(function* (p, input) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Artifact>> => cell(p).create(input, p)))
        }),
        update: Effect.fn("Workspaces.update")(function* (p, id, input) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Artifact>> => cell(p).update(id, input, p)))
        }),
        mentions: Effect.fn("Workspaces.mentions")(function* (p, artifactId) {
          // A share-link guest only ever sees the artifact the link is for.
          if (p.scope && artifactId && artifactId !== p.scope) return []
          const all = yield* rpc((): Promise<ReadonlyArray<Mention>> => cell(p).mentions(p.scope ?? artifactId))
          return p.scope ? all.filter((m) => m.artifactId === p.scope) : all
        }),
        resolveMention: Effect.fn("Workspaces.resolveMention")(function* (p, id) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Array<Mention>>> => cell(p).resolveMention(id, p)))
        }),
        claimMention: Effect.fn("Workspaces.claimMention")(function* (p, runner, artifactId) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Mention | null>> => cell(p).claimMention(runner, p, artifactId)))
        }),
        completeMention: Effect.fn("Workspaces.completeMention")(function* (p, id, status, result) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Mention>> => cell(p).completeMention(id, status, result, p)))
        }),
        createMention: Effect.fn("Workspaces.createMention")(function* (p, input) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Mention>> => cell(p).createMention(input, p)))
        }),
        cancelMention: Effect.fn("Workspaces.cancelMention")(function* (p, id) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Mention>> => cell(p).cancelMention(id, p)))
        }),
        touch: Effect.fn("Workspaces.touch")(function* (p) {
          if (p.actor.type === "guest") return
          yield* rpc((): Promise<void> => cell(p).touch(p))
        }),
        access: Effect.fn("Workspaces.access")(function* (p, id) {
          if (p.scope) return yield* new Forbidden({ message: "Guests can't see who has access" })
          return yield* fromCell(yield* rpc((): Promise<CellResult<ArtifactAccess>> => cell(p).access(id, p)))
        }),
        directory: Effect.fn("Workspaces.directory")(function* (p) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<OrgDirectory>> => cell(p).directory(p)))
        }),
        createLink: Effect.fn("Workspaces.createLink")(function* (p, id) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<ShareLink>> => cell(p).createLink(id, p)))
        }),
        deleteLink: Effect.fn("Workspaces.deleteLink")(function* (p, id) {
          yield* fromCell(yield* rpc((): Promise<CellResult<null>> => cell(p).deleteLink(id, p)))
        }),
        remove: Effect.fn("Workspaces.remove")(function* (p, id) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Artifact>> => cell(p).remove(id, p)))
        }),
        archived: Effect.fn("Workspaces.archived")(function* (p) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Array<Artifact>>> => cell(p).archived(p)))
        }),
        archive: Effect.fn("Workspaces.archive")(function* (p, id) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Artifact>> => cell(p).archive(id, p)))
        }),
        restore: Effect.fn("Workspaces.restore")(function* (p, id) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Artifact>> => cell(p).restore(id, p)))
        }),
        moveArtifact: Effect.fn("Workspaces.moveArtifact")(function* (p, id, folderId) {
          return yield* fromFolderCell(yield* rpc((): Promise<FolderResult<Artifact>> => cell(p).moveArtifact(id, folderId, p)))
        }),
        folders: Effect.fn("Workspaces.folders")(function* (p) {
          return p.scope ? [] : yield* rpc((): Promise<ReadonlyArray<Folder>> => cell(p).folders())
        }),
        createFolder: Effect.fn("Workspaces.createFolder")(function* (p, input) {
          return yield* fromFolderCell(yield* rpc((): Promise<FolderResult<Folder>> => cell(p).createFolder(input, p)))
        }),
        updateFolder: Effect.fn("Workspaces.updateFolder")(function* (p, id, input) {
          return yield* fromFolderCell(yield* rpc((): Promise<FolderResult<Folder>> => cell(p).updateFolder(id, input, p)))
        }),
        deleteFolder: Effect.fn("Workspaces.deleteFolder")(function* (p, id) {
          return yield* fromFolderCell(yield* rpc((): Promise<FolderResult<Folder>> => cell(p).deleteFolder(id, p)))
        }),
        connect: Effect.fn("Workspaces.connect")(function* (p, request) {
          const headers = new Headers(request.headers)
          if (p.scope) headers.set(SCOPE_HEADER, p.scope)
          else headers.delete(SCOPE_HEADER)
          return yield* rpc((): Promise<Response> => cell(p).fetch(new Request(request.url, { headers })))
        }),
        listTokens: Effect.fn("Workspaces.listTokens")(function* (p) {
          return yield* fromCell(yield* rpc((): Promise<CellResult<Array<ApiToken>>> => cell(p).listTokens(p)))
        }),
        createToken: Effect.fn("Workspaces.createToken")(function* (p, name) {
          const token = newApiToken(p.orgId)
          const hash = yield* Effect.promise(() => hashApiToken(token))
          const id = `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`
          const stored = yield* fromCell(yield* rpc((): Promise<CellResult<ApiToken>> => cell(p).createToken(p, { id, hash, name })))
          return { ...stored, token }
        }),
        revokeToken: Effect.fn("Workspaces.revokeToken")(function* (p, id) {
          yield* fromCell(yield* rpc((): Promise<CellResult<null>> => cell(p).revokeToken(p, id)))
        }),
        revokeUserTokens: Effect.fn("Workspaces.revokeUserTokens")(function* (p, userId) {
          yield* rpc((): Promise<number> => cell(p).revokeUserTokens(userId))
        }),
      })
    }),
  )
}

type RoomError = Forbidden | NotFound | Invalid

type Snapshot = { readonly state: unknown; readonly seq: number }

/**
 * Artifact cells (table, board, doc). Every call first checks the artifact
 * exists in the caller's org, then routes to the cell type for its kind.
 */
export class Rooms extends Context.Service<
  Rooms,
  {
    readonly content: (p: Principal, id: string) => Effect.Effect<RoomContent, RoomError>
    readonly applyOps: (p: Principal, id: string, ops: ReadonlyArray<unknown>) => Effect.Effect<OpsApplied, RoomError>
    readonly agentPresence: (p: Principal, id: string, body: AgentPresence) => Effect.Effect<void, RoomError>
    readonly connect: (p: Principal, id: string, request: Request) => Effect.Effect<Response, RoomError>
    readonly destroy: (p: Principal, artifact: Artifact) => Effect.Effect<void>
    readonly putAsset: (p: Principal, id: string, bytes: ArrayBuffer, mime: string) => Effect.Effect<{ id: string; url: string }, RoomError>
    readonly getAsset: (p: Principal, id: string, assetId: string) => Effect.Effect<Asset, RoomError>
    readonly reindex: (p: Principal) => Effect.Effect<Reindexed, RoomError>
  }
>()("@standard-artifacts/Rooms") {
  static readonly layer = Layer.effect(
    Rooms,
    Effect.gen(function* () {
      const env = yield* Bindings
      const workspaces = yield* Workspaces

      /** Cells are named by org + artifact, so one org can never address another's cell. */
      const stub = (p: Principal, artifact: Artifact) => {
        const name = `${p.orgId}:${artifact.id}`
        switch (artifact.kind) {
          case "table":
            return env.TABLE.get(env.TABLE.idFromName(name))
          case "board":
            return env.BOARD.get(env.BOARD.idFromName(name))
          case "doc":
            return env.DOC.get(env.DOC.idFromName(name))
          case "tracker":
            return env.TRACKER.get(env.TRACKER.idFromName(name))
        }
      }

      /** The cell holding an artifact's images, for the kinds that have any. */
      const assetCell = (p: Principal, artifact: Artifact) => {
        const name = `${p.orgId}:${artifact.id}`
        if (artifact.kind === "board") return env.BOARD.get(env.BOARD.idFromName(name))
        if (artifact.kind === "doc") return env.DOC.get(env.DOC.idFromName(name))
        return null
      }

      const resolve = Effect.fn("Rooms.resolve")(function* (p: Principal, id: string) {
        const artifact = yield* workspaces.get(p, id)
        return { artifact, cell: stub(p, artifact) }
      })

      return Rooms.of({
        content: Effect.fn("Rooms.content")(function* (p, id) {
          const { artifact, cell } = yield* resolve(p, id)
          const snap = yield* rpc((): Promise<Snapshot> => cell.snapshot())
          const base = { artifact, seq: snap.seq }
          // The cell's state is ours; decoding it here doubles as a contract check before it leaves the worker.
          switch (artifact.kind) {
            case "table": {
              const state = yield* decode(TableState, snap.state)
              return { kind: "table" as const, state, text: tableToText(state), ...base }
            }
            case "board": {
              const state = yield* decode(BoardState, snap.state)
              return { kind: "board" as const, state, text: boardToText(state), ...base }
            }
            case "doc": {
              const state = yield* decode(DocState, snap.state)
              return { kind: "doc" as const, state, text: docToMarkdown(state), ...base }
            }
            case "tracker": {
              const state = yield* decode(TrackerState, snap.state)
              return { kind: "tracker" as const, state, text: trackerToText(state), ...base }
            }
          }
        }),
        applyOps: Effect.fn("Rooms.applyOps")(function* (p, id, ops) {
          const { cell } = yield* resolve(p, id)
          if (p.actor.type === "agent") yield* workspaces.touch(p)
          const r = yield* rpc((): Promise<ApplyOutcome> => cell.agentApply(ops, p, id))
          if (r.ok) return { applied: r.applied, seq: r.seq }
          return yield* r.error === "Read-only" ? new Forbidden({ message: r.error }) : new Invalid({ message: r.error })
        }),
        agentPresence: Effect.fn("Rooms.agentPresence")(function* (p, id, body) {
          const { cell } = yield* resolve(p, id)
          if (p.actor.type === "agent" && body.ttl > 0) yield* workspaces.touch(p)
          const r = yield* rpc((): Promise<PresenceOutcome> => cell.agentPresence(p, body.runId, body.presence, body.ttl))
          if (!r.ok) return yield* new Forbidden({ message: r.error })
        }),
        connect: Effect.fn("Rooms.connect")(function* (p, id, request) {
          const { cell } = yield* resolve(p, id)
          const headers = new Headers(request.headers)
          headers.set(PRINCIPAL_HEADER, JSON.stringify(p))
          headers.set(ARTIFACT_HEADER, id)
          return yield* rpc((): Promise<Response> => cell.fetch(new Request(request.url, { headers })))
        }),
        putAsset: Effect.fn("Rooms.putAsset")(function* (p, id, bytes, mime) {
          if (!canEdit(p)) return yield* new Forbidden({ message: "Read-only" })
          const artifact = yield* workspaces.get(p, id)
          const cell = assetCell(p, artifact)
          if (!cell) return yield* new Invalid({ message: "Images can only be added to boards and docs" })
          const r = yield* rpc((): Promise<PutAsset> => cell.putAsset(bytes, mime))
          if (!r.ok) return yield* new Invalid({ message: r.error })
          return { id: r.id, url: assetPath(id, r.id) }
        }),
        getAsset: Effect.fn("Rooms.getAsset")(function* (p, id, assetId) {
          const artifact = yield* workspaces.get(p, id)
          const cell = assetCell(p, artifact)
          if (!cell) return yield* new NotFound({ message: "Not found" })
          const asset = yield* rpc((): Promise<Asset | null> => cell.getAsset(assetId))
          return asset ?? (yield* new NotFound({ message: "Not found" }))
        }),
        destroy: Effect.fn("Rooms.destroy")(function* (p, artifact) {
          yield* rpc((): Promise<void> => stub(p, artifact).destroy())
        }),
        reindex: Effect.fn("Rooms.reindex")(function* (p) {
          if (p.role !== "owner") return yield* new Forbidden({ message: "Only an owner can reindex the workspace" })
          if (!searchConfig(env)) return yield* new Invalid({ message: "Content search isn't configured (TURBOPUFFER_API_KEY)" })
          const all = [...(yield* workspaces.list(p)), ...(yield* workspaces.archived(p))]
          yield* Effect.forEach(all, (a) => rpc((): Promise<void> => stub(p, a).reindex(p.orgId, a.id)), { concurrency: 10 })
          return { queued: all.length }
        }),
      })
    }),
  )
}

/**
 * Workspace search: titles from the workspace cell, content from the index.
 * The workspace cell has the last word on what a caller can see: anything
 * deleted, archived or out of a guest's scope is dropped from the index's
 * answer, however stale that answer is.
 */
export class Search extends Context.Service<
  Search,
  { readonly query: (p: Principal, input: { readonly q: string; readonly kind?: ArtifactKind | undefined; readonly limit?: number | undefined }) => Effect.Effect<SearchResults> }
>()("@standard-artifacts/Search") {
  static readonly layer = Layer.effect(
    Search,
    Effect.gen(function* () {
      const env = yield* Bindings
      const workspaces = yield* Workspaces
      const config = searchConfig(env)

      return Search.of({
        query: Effect.fn("Search.query")(function* (p, { q, kind, limit: wanted }) {
          const limit = Math.max(1, Math.min(50, Math.floor(wanted ?? 20)))
          const visible = (yield* workspaces.list(p)).filter((a) => !kind || a.kind === kind)
          const byTitle = searchArtifacts(visible, q, 5).map((artifact): SearchHit => ({ artifact }))
          if (!config) return { hits: byTitle.slice(0, limit), mode: "title" as const }

          const byId = new Map(visible.map((a) => [a.id, a]))
          const rows = yield* Effect.tryPromise(() =>
            // Some rows may get dropped below, so ask for more than we'll show.
            queryItems(config, p.orgId, { query: q, limit: limit * 2, kind, artifactId: p.scope }),
          ).pipe(
            Effect.tapError((e) => Effect.logError("Content search failed; falling back to titles", e)),
            Effect.option,
          )
          if (Option.isNone(rows)) return { hits: byTitle.slice(0, limit), mode: "title" as const }
          const inContent = rows.value.flatMap(({ artifactId, item, text }): Array<SearchHit> => {
            const artifact = byId.get(artifactId)
            return artifact ? [{ artifact, item, text: searchSnippet(text) }] : []
          })
          return { hits: [...byTitle, ...inContent].slice(0, limit), mode: "hybrid" as const }
        }),
      })
    }),
  )
}

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.orDie)
