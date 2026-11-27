import { Config, Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api"
import { Api, Authentication, CurrentPrincipal, Forbidden, Invalid, ValidationErrors, formatIssue, type Principal } from "@standard-artifacts/protocol"
import { Accounts } from "./accounts"
import { Auth, GUEST_COOKIE, SHARE_COOKIE, bearer, fromAccessToken } from "./auth"
import { Billing } from "./billing"
import { OAuthServer } from "./oauth-server"
import { SESSION_COOKIE, cookieName, userActorId } from "./session"
import { Rooms, Search, Workspaces } from "./services"

/** Handlers stay thin: read the principal, call a service, return its result. */

/**
 * The principal, unless it came from an access token. Some things only a person
 * at the app may do: managing members, sharing a link outside the org, making
 * tokens. Otherwise a leaked token could invite its finder as an owner, remove
 * the real owners, or outlive its own revocation.
 */
const notViaToken = (message: string) =>
  Effect.flatMap(CurrentPrincipal, (p) => (fromAccessToken.has(p) ? Effect.fail(new Forbidden({ message })) : Effect.succeed(p)))

const MANAGE_BY_TOKEN = "Manage members in the app, not with an access token."

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth
    return Authentication.of(
      Effect.fn("Http.authenticate")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest
        const principal = yield* auth.resolve({
          // No ticket cookie here: API calls send their ticket as a bearer token (see credentialsFromRequest).
          bearer: bearer(request.headers["authorization"]),
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
    const billing = yield* Billing
    const authMode = (yield* Config.String("AUTH_MODE").pipe(Config.withDefault("live"))) === "dev" ? "dev" : "live"
    return handlers.handleAll({
      snapshot: () =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal
          yield* workspaces.touch(principal)
          return {
            principal,
            artifacts: yield* workspaces.list(principal),
            folders: yield* workspaces.folders(principal),
            authMode,
            ...(billing.enabled && { billing: true }),
          } as const
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
      createLink: ({ params }) =>
        Effect.flatMap(notViaToken("Share links are made in the app, not with an access token."), (p) => workspaces.createLink(p, params.id)),
      deleteLink: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.deleteLink(p, params.id)),
    })
  }),
)

export const OrgHandlers = HttpApiBuilder.group(
  Api,
  "org",
  Effect.fn("Http.org")(function* (handlers) {
    const accounts = yield* Accounts
    const workspaces = yield* Workspaces
    const oauth = yield* OAuthServer
    return handlers.handleAll({
      members: () => Effect.flatMap(CurrentPrincipal, (p) => accounts.members(p)),
      // Listing is fine with a token; every change needs a person at the app.
      invite: ({ payload }) => Effect.flatMap(notViaToken(MANAGE_BY_TOKEN), (p) => accounts.invite(p, payload)),
      resendInvitation: ({ params }) => Effect.flatMap(notViaToken(MANAGE_BY_TOKEN), (p) => accounts.resendInvitation(p, params.id)),
      revokeInvitation: ({ params }) => Effect.flatMap(notViaToken(MANAGE_BY_TOKEN), (p) => accounts.revokeInvitation(p, params.id)),
      updateMember: ({ params, payload }) => Effect.flatMap(notViaToken(MANAGE_BY_TOKEN), (p) => accounts.updateMember(p, params.id, payload.role)),
      // Whoever leaves takes their access tokens with them, and their connected agents are refused until they're back.
      removeMember: ({ params }) =>
        Effect.gen(function* () {
          const p = yield* notViaToken(MANAGE_BY_TOKEN)
          const userId = yield* accounts.removeMember(p, params.id)
          yield* workspaces.revokeUserTokens(p, userId)
          yield* oauth.memberRemoved(p, userId)
        }),
    })
  }),
)

export const BillingHandlers = HttpApiBuilder.group(
  Api,
  "billing",
  Effect.fn("Http.billing")(function* (handlers) {
    const billing = yield* Billing
    const accounts = yield* Accounts

    /** Paying is an owner's call, made in the app: the ticket says owner, and WorkOS is asked again. */
    const owner = Effect.gen(function* () {
      const p = yield* notViaToken("Manage billing in the app, not with an access token.")
      const refused = new Forbidden({ message: "Only owners manage billing." })
      if (p.actor.type !== "user" || p.role !== "owner") return yield* refused
      if ((yield* accounts.currentRole(p.orgId, p.actor.id)) !== "owner") return yield* refused
      return p
    })
    const origin = Effect.map(HttpServerRequest.HttpServerRequest, (request) => new URL(request.originalUrl).origin)
    /** APP_URL when it's set (behind a proxy the request's own origin can be wrong), else the request's. */
    const appOrigin = Effect.map(origin, (o) => accounts.appOrigin(new Request(o)))

    return handlers.handleAll({
      info: () => Effect.flatMap(CurrentPrincipal, (p) => billing.info(p)),
      checkout: ({ payload }) =>
        Effect.gen(function* () {
          const p = yield* owner
          return yield* billing.checkout(p, payload.interval, yield* appOrigin)
        }),
      portal: () =>
        Effect.gen(function* () {
          const p = yield* owner
          return yield* billing.portal(p, yield* appOrigin)
        }),
    })
  }),
)

export const TokensHandlers = HttpApiBuilder.group(
  Api,
  "tokens",
  Effect.fn("Http.tokens")(function* (handlers) {
    const workspaces = yield* Workspaces
    const accounts = yield* Accounts

    /**
     * With sign-in, a token is made only by a person in the app: the request must
     * carry the browser's session cookie, for the same person and org as the
     * ticket. A ticket alone isn't enough, since tickets also travel as
     * `?ticket=` on sockets and can end up in logs. Dev mode has no sessions.
     */
    const fromSession = (p: Principal) =>
      Effect.gen(function* () {
        if (accounts.mode === "dev") return
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* accounts.readSession(request.cookies[cookieName(request.originalUrl, SESSION_COOKIE)])
        if (!session || userActorId(session.user.id) !== p.actor.id || session.org.id !== p.orgId) {
          return yield* new Forbidden({ message: "Create access tokens in Settings, signed in to the app." })
        }
      })

    return handlers.handleAll({
      list: () => Effect.flatMap(CurrentPrincipal, (p) => workspaces.listTokens(p)),
      create: ({ payload }) =>
        Effect.gen(function* () {
          const p = yield* notViaToken("Create access tokens in Settings, not with another token.")
          yield* fromSession(p)
          return yield* workspaces.createToken(p, payload.name)
        }),
      revoke: ({ params }) => Effect.flatMap(CurrentPrincipal, (p) => workspaces.revokeToken(p, params.id)),
    })
  }),
)

export const ConnectionsHandlers = HttpApiBuilder.group(
  Api,
  "connections",
  Effect.fn("Http.connections")(function* (handlers) {
    const oauth = yield* OAuthServer
    const origin = Effect.map(HttpServerRequest.HttpServerRequest, (request) => oauth.origin(new Request(new URL(request.originalUrl).origin)))
    /** Seeing and disconnecting agents is for a person in the app, not for an agent or a token. */
    const person = notViaToken("Manage connected agents in Settings, not with a token.")
    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const p = yield* person
          const base = yield* origin
          const agents = oauth.enabled ? yield* oauth.connections(p, base) : []
          return { mcpUrl: `${base}/mcp`, oauth: oauth.enabled, agents, everyone: p.role === "owner" }
        }),
      disconnect: ({ params }) => Effect.flatMap(person, (p) => oauth.disconnect(p, params.id)),
    })
  }),
)
