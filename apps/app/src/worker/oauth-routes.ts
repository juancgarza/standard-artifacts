import { Effect } from "effect"
import type { ConsentProblem } from "@standard-artifacts/protocol"
import { Accounts } from "./accounts"
import { SCOPE, mcpResource } from "./oauth"
import { OAuthServer, type ConsentError, type OAuthError } from "./oauth-server"
import { ORG_COOKIE, SESSION_COOKIE, SESSION_MAX_AGE_S, TICKET_COOKIE, cookieName, setCookie } from "./session"

/**
 * The OAuth server's HTTP surface (see oauth.ts for what each endpoint does).
 * Discovery, registration, token and revocation are for MCP clients, some of
 * which run in a browser, so they answer CORS without credentials. The consent
 * endpoints are for the app's own /authorize page only: same origin, the
 * session cookie, and a CSRF token on the answer.
 *
 * On a server without sign-in (dev, Solo) all of it answers 404: its /mcp
 * needs no token, so clients never look for a way to sign in.
 */

export const isOAuthPath = (pathname: string) => pathname.startsWith("/api/oauth/") || pathname.startsWith("/.well-known/oauth-")

const base = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
}
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}, cookies: ReadonlyArray<string> = []) => {
  const headers = new Headers({ "content-type": "application/json", ...base, ...extra })
  for (const c of cookies) headers.append("set-cookie", c)
  return new Response(JSON.stringify(body), { status, headers })
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location, ...base } })

const oauthFailure = (e: OAuthError) =>
  json({ error: e.error, error_description: e.description }, e.status, {
    ...cors,
    ...(e.status === 401 && { "www-authenticate": 'Basic realm="standard-artifacts"' }),
    ...(e.status === 429 && { "retry-after": "60" }),
  })

const consentStatus: Record<ConsentProblem, number> = {
  "signed-out": 401,
  expired: 410,
  "unknown-client": 400,
  "redirect-mismatch": 400,
  "bad-request": 400,
  "no-membership": 403,
  forbidden: 403,
  unavailable: 503,
  "not-enabled": 404,
}
const consentFailure = (e: ConsentError) => json({ _tag: "ConsentError", reason: e.reason, message: e.message }, consentStatus[e.reason])

/** The body of a token or revocation request: a form, as RFC 6749 says, or JSON from clients that send it. */
const formOf = (request: Request) =>
  Effect.promise(async (): Promise<URLSearchParams> => {
    const type = request.headers.get("content-type")?.toLowerCase() ?? ""
    const text = await request.text().catch(() => "")
    if (!type.startsWith("application/json")) return new URLSearchParams(text)
    try {
      const body: unknown = JSON.parse(text)
      const form = new URLSearchParams()
      if (typeof body === "object" && body !== null) for (const [k, v] of Object.entries(body)) if (typeof v === "string") form.set(k, v)
      return form
    } catch {
      return new URLSearchParams()
    }
  })

/** RFC 9728: what /mcp is and who signs people in for it. */
export const protectedResource = (origin: string) => ({
  resource: mcpResource(origin),
  authorization_servers: [origin],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "Standard Artifacts",
  resource_documentation: "https://github.com/juancgarza/standard-artifacts/blob/main/docs/cli-and-mcp.md",
})

/** RFC 8414. */
export const authorizationServer = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/api/oauth/authorize`,
  token_endpoint: `${origin}/api/oauth/token`,
  registration_endpoint: `${origin}/api/oauth/register`,
  revocation_endpoint: `${origin}/api/oauth/revoke`,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  scopes_supported: [SCOPE],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  service_documentation: "https://github.com/juancgarza/standard-artifacts/blob/main/docs/cli-and-mcp.md",
})

export const oauthRoute = (request: Request) =>
  Effect.gen(function* () {
    const server = yield* OAuthServer
    const accounts = yield* Accounts
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    if (!server.enabled) return json({ error: "not_found", error_description: "This server has no sign-in, so its MCP server needs none." }, 404)
    const origin = server.origin(request)

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...base, ...cors } })

    switch (route) {
      case "GET /.well-known/oauth-protected-resource":
      case "GET /.well-known/oauth-protected-resource/mcp":
        return json(protectedResource(origin), 200, { ...cors, "cache-control": "public, max-age=3600" })

      case "GET /.well-known/oauth-authorization-server":
      case "GET /.well-known/oauth-authorization-server/mcp":
        return json(authorizationServer(origin), 200, { ...cors, "cache-control": "public, max-age=3600" })

      case "POST /api/oauth/register": {
        const body = yield* Effect.promise(() => request.json().catch((): unknown => null))
        return yield* server.register(request, body).pipe(
          Effect.map((registered) => json(registered, 201, cors)),
          Effect.catchTag("OAuthError", (e) => Effect.succeed(oauthFailure(e))),
        )
      }

      case "GET /api/oauth/authorize":
        return redirect(yield* server.authorize(request))

      case "GET /api/oauth/consent":
        return yield* server.consent(request, url.searchParams.get("request")).pipe(
          Effect.map((info) => json(info)),
          Effect.catchTag("ConsentError", (e) => Effect.succeed(consentFailure(e))),
        )

      case "POST /api/oauth/consent": {
        // From the app's own consent page only: same origin, JSON (a form on another site can't send it), plus the CSRF token.
        const from = request.headers.get("origin")
        if (from !== null && from !== origin && from !== url.origin) return json({ _tag: "Forbidden", message: "Cross-site request refused" }, 403)
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ _tag: "Invalid", message: "Send the answer as JSON." }, 415)
        const body = yield* Effect.promise(() => request.json().catch((): unknown => null))
        return yield* server.answer(request, body).pipe(
          Effect.flatMap(({ result, session }) =>
            session
              ? Effect.map(accounts.sealSession(session).pipe(Effect.orElseSucceed(() => undefined)), (sealed) =>
                  json(
                    result,
                    200,
                    {},
                    sealed
                      ? [
                          setCookie(request.url, cookieName(request.url, SESSION_COOKIE), sealed, SESSION_MAX_AGE_S),
                          setCookie(request.url, ORG_COOKIE, session.org.id, 60 * 60 * 24 * 365),
                          setCookie(request.url, cookieName(request.url, TICKET_COOKIE), "", 0),
                        ]
                      : [],
                  ),
                )
              : Effect.succeed(json(result)),
          ),
          Effect.catchTag("ConsentError", (e) => Effect.succeed(consentFailure(e))),
        )
      }

      case "POST /api/oauth/token":
        return yield* server.token(request, yield* formOf(request)).pipe(
          Effect.map((tokens) => json(tokens, 200, { ...cors, pragma: "no-cache" })),
          Effect.catchTag("OAuthError", (e) => Effect.succeed(oauthFailure(e))),
        )

      case "POST /api/oauth/revoke":
        // RFC 7009: the answer is the same whether or not the token was valid.
        yield* server.revoke(yield* formOf(request))
        return new Response(null, { status: 200, headers: { ...base, ...cors } })

      default:
        return json({ error: "not_found", error_description: "Not found" }, 404, cors)
    }
  }).pipe(Effect.withSpan("Http.oauth"))
