import { Config, Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api"
import { Api, Authentication, CurrentPrincipal, Invalid, ValidationErrors, formatIssue } from "@standard-artifacts/protocol"
import { Auth, GUEST_COOKIE, SHARE_COOKIE, bearer } from "./auth"
import { Rooms, Search, Workspaces } from "./services"

/** Handlers stay thin: read the principal, call a service, return its result. */

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth
    return Authentication.of(
      Effect.fn("Http.authenticate")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest
        const principal = yield* auth.resolve({
          bearer: bearer(request.headers["authorization"]),
          cookie: request.cookies["standard_artifacts_ticket"],
          devAs: request.headers["x-dev-as"],
          client: request.headers["x-standard-artifacts-client"],
          share: request.cookies[SHARE_COOKIE],
          guest: request.cookies[GUEST_COOKIE],
        })
        return yield* httpEffect.pipe(Effect.provideService(CurrentPrincipal, principal))
      }),
    )
  }),
)

export const ValidationErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(ValidationErrors, (error) =>
  Effect.fail(new Invalid({ message: `${error.kind}: ${formatIssue(error.cause.issue)}` })),
)

export const WorkspaceHandlers = HttpApiBuilder.group(
  Api,
  "workspace",
  Effect.fn("Http.workspace")(function* (handlers) {
    const workspaces = yield* Workspaces
    const rooms = yield* Rooms
    const authMode = (yield* Config.String("AUTH_MODE").pipe(Config.withDefault("live"))) === "dev" ? "dev" : "live"
    return handlers.handleAll({
      snapshot: () =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal
          yield* workspaces.touch(principal)
          return { principal, artifacts: yield* workspaces.list(principal), folders: yield* workspaces.folders(principal), authMode } as const
        }),
      members: () => Effect.flatMap(CurrentPrincipal, (p) => workspaces.directory(p)),
      createArtifact: ({ payload }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.create(p, payload)),
      updateArtifact: ({ params, payload }) =>
        Effect.flatMap(CurrentPrincipal, (p) => workspaces.update(p, params.id, payload)),
      deleteArtifact: ({ params }) =>
        Effect.gen(function* () {
          const p = yield* CurrentPrincipal
          const removed = yield* workspaces.remove(p, params.id)
          yield* rooms.destroy(p, removed)
          return removed
        }),
      archivedArtifacts: () => Effect.flatMap(CurrentPrincipal, (p) => workspaces.archived(p)),
      archiveArtifact: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.archive(p, params.id)),
      restoreArtifact: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.restore(p, params.id)),
      moveArtifact: ({ params, payload }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.moveArtifact(p, params.id, payload.folderId)),
      createFolder: ({ payload }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.createFolder(p, payload)),
      updateFolder: ({ params, payload }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.updateFolder(p, params.id, payload)),
      deleteFolder: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.deleteFolder(p, params.id)),
    })
  }),
)

export const MentionsHandlers = HttpApiBuilder.group(
  Api,
  "mentions",
  Effect.fn("Http.mentions")(function* (handlers) {
    const workspaces = yield* Workspaces
    return handlers.handleAll({
      list: ({ query }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.mentions(p, query.artifactId)),
      resolve: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.resolveMention(p, params.id)),
      create: ({ payload }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.createMention(p, payload)),
      cancel: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.cancelMention(p, params.id)),
      claim: ({ payload }) =>
        Effect.flatMap(CurrentPrincipal, (p) =>
          workspaces.touch(p).pipe(Effect.andThen(workspaces.claimMention(p, payload.runner, payload.artifactId))),
        ),
      complete: ({ params, payload }) =>
        Effect.flatMap(CurrentPrincipal, (p) => workspaces.completeMention(p, params.id, payload.status, payload.result)),
    })
  }),
)

export const RoomsHandlers = HttpApiBuilder.group(
  Api,
  "rooms",
  Effect.fn("Http.rooms")(function* (handlers) {
    const rooms = yield* Rooms
    return handlers.handleAll({
      content: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => rooms.content(p, params.id)),
      applyOps: ({ params, payload }) => Effect.flatMap(CurrentPrincipal, (p) => rooms.applyOps(p, params.id, payload.ops)),
      agentPresence: ({ params, payload }) =>
        Effect.flatMap(CurrentPrincipal, (p) => rooms.agentPresence(p, params.id, payload)),
    })
  }),
)

export const SearchHandlers = HttpApiBuilder.group(
  Api,
  "search",
  Effect.fn("Http.search")(function* (handlers) {
    const search = yield* Search
    const rooms = yield* Rooms
    return handlers.handleAll({
      query: ({ query }) => Effect.flatMap(CurrentPrincipal, (p) => search.query(p, query)),
      reindex: () => Effect.flatMap(CurrentPrincipal, (p) => rooms.reindex(p)),
    })
  }),
)

export const SharingHandlers = HttpApiBuilder.group(
  Api,
  "sharing",
  Effect.fn("Http.sharing")(function* (handlers) {
    const workspaces = yield* Workspaces
    return handlers.handleAll({
      access: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.access(p, params.id)),
      createLink: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.createLink(p, params.id)),
      deleteLink: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.deleteLink(p, params.id)),
    })
  }),
)
