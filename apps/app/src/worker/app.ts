import { Cause, ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api, kinds, type McpWhoami, type Principal } from "@standard-artifacts/protocol"
import { Accounts } from "./accounts"
import { Auth, GUEST_COOKIE, SHARE_COOKIE, bearer, credentialsFromRequest, readCookie, type GrantAccess } from "./auth"
import { authRoute, isAuthPath } from "./auth-routes"
import { Billing } from "./billing"
import { Bindings, type Env } from "./env"
import {
  AuthenticationLive,
  BillingHandlers,
  ConnectionsHandlers,
  MentionsHandlers,
  OrgHandlers,
  RoomsHandlers,
  SearchHandlers,
  SharingHandlers,
  TokensHandlers,
  ValidationErrorsLive,
  WorkspaceHandlers,
} from "./http"
import { Rooms, Search, Workspaces } from "./services"
import { mcpCellName } from "./cells/mcp-cell"
import { isOAuthPath, oauthRoute } from "./oauth-routes"
import { OAuthServer } from "./oauth-server"

/**
 * The Worker's request handling. Static assets (the SPA) are served before this
 * runs, except for /api/* and /mcp, which `runWorkerFirst` routes here.
 *
 *   /mcp                remote MCP (Streamable HTTP), served by the caller's McpCell
 *   /mcp/whoami         who a bearer token acts as (person, org, access, client)
 *   /.well-known/oauth-*, /api/oauth/*  remote MCP sign-in (OAuth): see oauth.ts
 *   /api/v1/rooms/:id   WebSocket upgrade into an artifact's cell (raw socket, outside HttpApi)
 *   /api/v1/workspace/live  WebSocket into the org's cell: says when the index changed
 *   /api/v1/share/:token  open a share link: sets a cookie, redirects to the artifact
 *   /api/v1/share/exit    drop the share cookie (dev: back to the local owner)
 *   /api/auth/*         browser sign-in with WorkOS (live mode): see auth-routes.ts
 *   /api/billing/webhook  Stripe's signed events (Cloud): see billing.ts
 *   /api/v1/*           the HttpApi contract in @standard-artifacts/protocol
 */

/** Services for one isolate. Workers env is constant per isolate, so build once. */
const services = (env: Env) =>
  Layer.mergeAll(Auth.layer, Rooms.layer, Search.layer, OAuthServer.layer).pipe(
    Layer.provideMerge(Workspaces.layer),
    Layer.provideMerge(Accounts.layer),
    Layer.provideMerge(Billing.layer),
    Layer.provide(Layer.succeed(Bindings, env)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  )

const build = (env: Env) => {
  const layer = services(env)
  const runtime = ManagedRuntime.make(layer)
  const api = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide([WorkspaceHandlers, RoomsHandlers, MentionsHandlers, SharingHandlers, SearchHandlers, OrgHandlers, TokensHandlers, ConnectionsHandlers, BillingHandlers]),
      Layer.provide([AuthenticationLive, ValidationErrorsLive]),
      Layer.provide(layer),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
  return { runtime, api }
}

let app: ReturnType<typeof build> | undefined

const roomPath = /^\/api\/v1\/rooms\/([\w-]+)$/
const assetsPath = /^\/api\/v1\/artifacts\/([\w-]+)\/assets(?:\/([\w-]+))?$/
const sharePath = /^\/api\/v1\/share\/([\w.-]+)$/

/** Handle one request. The MCP cells call it too, to reach the API in-process. */
export function handle(request: Request, env: Env): Promise<Response> {
  app ??= build(env)
  const url = new URL(request.url)
  if (url.pathname === "/mcp") return app.runtime.runPromise(routeMcp(request, env))
  if (url.pathname === "/mcp/whoami") return app.runtime.runPromise(whoami(request))
  if (isOAuthPath(url.pathname)) return app.runtime.runPromise(oauthRoute(request))
  if (isAuthPath(url.pathname)) return app.runtime.runPromise(authRoute(request, env))
  if (url.pathname === "/api/billing/webhook" && request.method === "POST") {
    return app.runtime.runPromise(Effect.gen(function* () {
      return yield* (yield* Billing).webhook(request)
    }))
  }
  const roomId = url.pathname.match(roomPath)?.[1]
  if (roomId && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return app.runtime.runPromise(connectRoom(request, roomId))
  }
  if (url.pathname === "/api/v1/workspace/live" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return app.runtime.runPromise(connectWorkspace(request))
  }
  // Image bytes in and out of a board's or doc's cell (raw bodies, so outside the JSON HttpApi).
  const asset = url.pathname.match(assetsPath)
  if (asset?.[1] && !asset[2] && request.method === "POST") return app.runtime.runPromise(uploadAsset(request, asset[1]))
  if (asset?.[1] && asset[2] && request.method === "GET") return app.runtime.runPromise(downloadAsset(request, asset[1], asset[2]))
  const share = url.pathname.match(sharePath)?.[1]
  if (share && request.method === "GET") return app.runtime.runPromise(share === "exit" ? exitShare(request) : openShare(request, share))
  return app.api.handler(request)
}

type RawError = { readonly _tag: "Unauthorized" | "Forbidden" | "NotFound" | "Invalid"; readonly message: string }
const status = { Unauthorized: 401, Forbidden: 403, NotFound: 404, Invalid: 400 } as const

/** Raw routes (sockets, bytes): authenticate, run, and turn typed errors into JSON responses. */
const raw = <R>(
  name: string,
  request: Request,
  run: (principal: Principal) => Effect.Effect<Response, RawError, R>,
  options: { readonly ticketCookie?: boolean } = {},
) =>
  Effect.gen(function* () {
    const principal = yield* (yield* Auth).resolve(credentialsFromRequest(request, options))
    return yield* run(principal)
  }).pipe(
    Effect.catch((error: RawError) => Effect.succeed(Response.json({ _tag: error._tag, message: error.message }, { status: status[error._tag] }))),
    Effect.withSpan(name),
  )

const connectRoom = (request: Request, id: string) =>
  raw("Http.connectRoom", request, (p) => Effect.flatMap(Rooms, (rooms) => rooms.connect(p, id, request)))

const connectWorkspace = (request: Request) =>
  raw("Http.connectWorkspace", request, (p) => Effect.flatMap(Workspaces, (workspaces) => workspaces.connect(p, request)))

const uploadAsset = (request: Request, id: string) =>
  raw("Http.uploadAsset", request, (p) =>
    Effect.gen(function* () {
      const mime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? ""
      const bytes = yield* Effect.promise(() => request.arrayBuffer())
      const stored = yield* (yield* Rooms).putAsset(p, id, bytes, mime)
      return Response.json(stored, { status: 201 })
    }),
  )

/** For an asset opened on its own: no scripts, no requests, an opaque origin. `<img>` embeds ignore it. */
const ASSET_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"

const downloadAsset = (request: Request, id: string, assetId: string) =>
  raw("Http.downloadAsset", request, (p) =>
    Effect.gen(function* () {
      const asset = yield* (yield* Rooms).getAsset(p, id, assetId)
      // Assets are immutable (new upload = new id), so browsers can cache them forever.
      // They're user content on our origin, so the browser must take the type as given and never run them as a page.
      const headers = new Headers({
        "content-type": asset.mime,
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": ASSET_CSP,
      })
      if (!asset.mime.startsWith("image/")) headers.set("content-disposition", "attachment")
      return new Response(asset.bytes, { headers })
    }),
    // `<img>` URLs can't carry a header: this is the one route the ticket cookie opens.
    { ticketCookie: true },
  )

const cookie = (request: Request, name: string, value: string, maxAge: number) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

/**
 * Opening a share link: remember the token in a cookie (fetches and room
 * sockets send it from then on) and land on the artifact as a read-only guest.
 * A turned-off link gets a short page instead of the app's sign-in error.
 */
const openShare = (request: Request, token: string) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const exit = yield* Effect.exit(auth.shared(token))
    if (exit._tag === "Failure") {
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link turned off</title><body style="font:15px/1.5 system-ui;margin:0;display:grid;place-items:center;height:100vh;color:#1f1f1d"><div style="max-width:360px;padding:16px"><h1 style="font-size:18px">This link isn't active</h1><p style="color:#73736e">Whoever shared it turned the link off, or the page was deleted. Ask them for a new link.</p></div>`,
        { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
      )
    }
    const link = exit.value
    const headers = new Headers({ location: `/${kinds[link.kind].slug}/${link.artifactId}`, "cache-control": "no-store" })
    headers.append("set-cookie", cookie(request, SHARE_COOKIE, token, 60 * 60 * 24 * 30))
    if (!readCookie(request.headers.get("cookie") ?? undefined, GUEST_COOKIE)) {
      headers.append("set-cookie", cookie(request, GUEST_COOKIE, crypto.randomUUID().replace(/-/g, "").slice(0, 16), 60 * 60 * 24 * 365))
    }
    return new Response(null, { status: 302, headers })
  }).pipe(Effect.withSpan("Http.openShare"))

const exitShare = (request: Request) =>
  Effect.sync(() => {
    const headers = new Headers({ location: "/", "cache-control": "no-store" })
    headers.append("set-cookie", cookie(request, SHARE_COOKIE, "", 0))
    return new Response(null, { status: 302, headers })
  })

/**
 * Remote MCP. The MCP server keeps sessions in memory and its tools act as one
 * principal, so each principal gets its own McpCell: authenticate here, then
 * hand the request to that cell. Without `x-dev-as`, dev requests act as an
 * agent (as `stdartifacts mcp` does); live tickets say who's acting.
 *
 * Signed in with OAuth (`sao_…`), the token is checked here and never goes
 * further: the cell gets a short ticket for the grant's agent instead, which
 * is all its in-process API calls carry. A token that's unknown, expired or
 * revoked answers 401 with where to sign in (RFC 9728), so the client signs
 * in again; a grant whose person left the org answers 403, since signing in
 * again wouldn't help.
 */
const routeMcp = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const token = bearer(request.headers.get("authorization") ?? undefined)
    if (token?.startsWith("sao_")) {
      const exit = yield* Effect.exit(auth.grant(token))
      if (exit._tag === "Failure") return yield* refused(request, exit)
      const { principal } = exit.value
      const headers = new Headers(request.headers)
      headers.set("authorization", `Bearer ${yield* auth.ticketFor(principal)}`)
      headers.delete("cookie")
      headers.delete("x-dev-as")
      const cell = env.MCP.get(env.MCP.idFromName(mcpCellName(principal)))
      return yield* Effect.promise(() => cell.fetch(new Request(request, { headers })))
    }
    const headers = new Headers(request.headers)
    if (!headers.has("x-dev-as")) headers.set("x-dev-as", "agent")
    const forwarded = new Request(request, { headers })
    const exit = yield* Effect.exit(auth.resolve(credentialsFromRequest(forwarded)))
    if (exit._tag === "Failure") return yield* refused(request, exit)
    const cell = env.MCP.get(env.MCP.idFromName(mcpCellName(exit.value)))
    return yield* Effect.promise(() => cell.fetch(forwarded))
  }).pipe(Effect.withSpan("Http.routeMcp"))

type Refusal = { readonly _tag: "Unauthorized" | "Forbidden" | "Unavailable"; readonly message: string }

/**
 * A refused MCP request, as a JSON-RPC error. 401 says where to sign in
 * (`resource_metadata`, RFC 9728) when this server signs agents in, and
 * `invalid_token` when a token was sent but won't do (RFC 6750).
 */
const refused = (request: Request, exit: Exit.Exit<unknown, Refusal>) =>
  Effect.gen(function* () {
    const oauth = yield* OAuthServer
    const failure = Cause.findErrorOption(exit._tag === "Failure" ? exit.cause : Cause.empty)
    const error: Refusal = Option.isSome(failure) ? failure.value : { _tag: "Unauthorized", message: "Sign in required" }
    const sent = request.headers.has("authorization")
    if (error._tag === "Forbidden") return rpcError(403, -32003, error.message)
    if (error._tag === "Unavailable") return rpcError(503, -32603, error.message, { "retry-after": "30" })
    const challenge = oauth.enabled
      ? `Bearer resource_metadata="${oauth.origin(request)}/.well-known/oauth-protected-resource/mcp"${sent ? `, error="invalid_token", error_description="${error.message.replace(/[^\x20-\x7e]|["\\]/g, "")}"` : ""}`
      : 'Bearer realm="standard-artifacts"'
    const message = oauth.enabled
      ? sent
        ? `${error.message}`
        : "Sign in to use this MCP server: add it to your client by URL and sign in in the browser, or send Authorization: Bearer <token> with a token from Settings → Access tokens."
      : "Sign in to use this MCP server: Authorization: Bearer <token>, with a token from Settings → Access tokens."
    return rpcError(401, -32001, message, { "www-authenticate": challenge })
  })

const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers: { "cache-control": "no-store", ...headers } })

/** `GET /mcp/whoami`: who a bearer token acts as. Answers 401 and 403 as /mcp does. */
const whoami = (request: Request) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    if (request.method !== "GET") return Response.json({ _tag: "NotFound", message: "Not found" }, { status: 404 })
    const token = bearer(request.headers.get("authorization") ?? undefined)
    const describe = (p: Principal, grant: GrantAccess["grant"] | undefined): McpWhoami => ({
      person: p.actor.type === "agent" ? { id: p.actor.onBehalfOf, name: grant?.userName ?? "" } : { id: p.actor.id, name: p.actor.type === "user" ? p.actor.name : "Guest" },
      organization: { id: p.orgId, name: p.orgName },
      access: p.role === "viewer" ? "read" : "write",
      role: p.role,
      client: grant ? { id: grant.clientId, name: grant.clientName, agentName: grant.agentName } : null,
      via: grant ? "oauth" : "access-token",
    })
    if (token?.startsWith("sao_")) {
      const exit = yield* Effect.exit(auth.grant(token))
      if (exit._tag === "Failure") return yield* refused(request, exit)
      return Response.json(describe(exit.value.principal, exit.value.grant), { headers: { "cache-control": "no-store" } })
    }
    // An access token, as the person who made it (over /mcp it acts as their agent, with the same access).
    const exit = yield* Effect.exit(auth.resolve({ ...credentialsFromRequest(request), devAs: undefined, client: undefined }))
    if (exit._tag === "Failure") return yield* refused(request, exit)
    return Response.json(describe(exit.value, undefined), { headers: { "cache-control": "no-store" } })
  }).pipe(Effect.withSpan("Http.whoami"))
