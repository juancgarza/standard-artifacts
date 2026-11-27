import { Config, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { Ticket, Unauthorized, type ArtifactKind, type Principal } from "@standard-artifacts/protocol"
import { Accounts } from "./accounts"
import { Billing } from "./billing"
import type { ResolvedToken } from "./cells/workspace-cell"
import { Bindings } from "./env"
import { TICKET_COOKIE, agentRole, apiTokenOrg, cookieName, hashApiToken } from "./session"

/**
 * What a transport could find on a request. HTTP reads headers and cookies;
 * WebSocket upgrades can't set headers from a browser, so they pass `?ticket=`.
 */
export interface Credentials {
  readonly bearer?: string | undefined
  readonly ticket?: string | undefined
  readonly cookie?: string | undefined
  /** Dev only: "guest" | "viewer" | "agent". */
  readonly devAs?: string | undefined
  /** The app an agent is calling from ("Codex"). It labels the agent and grants nothing. */
  readonly client?: string | undefined
  /** A share link's token, from the `standard_artifacts_share` cookie set when someone opens the link. */
  readonly share?: string | undefined
  /** Per-browser guest id (`standard_artifacts_guest` cookie), so two people on one link show up as two guests. */
  readonly guest?: string | undefined
}

/** What a share token opens. */
export interface SharedArtifact {
  readonly orgId: string
  readonly orgName: string
  readonly plan: Principal["plan"]
  readonly artifactId: string
  readonly kind: ArtifactKind
}

export class Auth extends Context.Service<
  Auth,
  {
    readonly resolve: (credentials: Credentials) => Effect.Effect<Principal, Unauthorized>
    /** Look up a share token; fails when the link was turned off. */
    readonly shared: (token: string) => Effect.Effect<SharedArtifact, Unauthorized>
  }
>()("@standard-artifacts/Auth") {
  /**
   * Production: a ticket, minted by this Worker (see tickets.ts), in the format
   * `base64url(json).base64url(hmacSha256(json))`. HMAC is deliberate: celld's
   * Web Crypto verifies HMAC but not RS/ES-signed JWTs.
   *
   * Dev (AUTH_MODE=dev): no ticket means a local owner on the free plan, and
   * `devAs` switches to guest, viewer or agent.
   *
   * Share links: a token `sh.<org>.<secret>` (cookie, or bearer for scripts)
   * resolves to a read-only guest scoped to one artifact, as long as the
   * link is still on in the org's WorkspaceCell.
   *
   * Personal access tokens: `sat_…` (bearer, for the CLI and MCP) resolve to
   * the person who made it, with their current role. The org's WorkspaceCell
   * keeps a hash and the role; the account service confirms the role every
   * few minutes, and a token of someone who left stops working. With
   * `x-dev-as: agent` (what `stdartifacts mcp` sends) the same token acts as an
   * agent for that person, never above editor. On Free limits (billing on) an
   * Editor's token reads only, as their tickets do.
   */
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const env = yield* Bindings
      const accounts = yield* Accounts
      const billing = yield* Billing
      const mode = yield* Config.String("AUTH_MODE").pipe(Config.withDefault("live"))
      // The local owner's display name. `stdartifacts serve` passes the OS user's; Alchemy dev keeps "JC".
      const ownerName = (yield* Config.String("DEV_OWNER_NAME").pipe(Config.withDefault(""))).trim().slice(0, 80) || "JC"
      const devPrincipal = (as: string | undefined) => devPrincipalAs(as, ownerName)
      const secret = yield* Config.option(Config.Redacted("TICKET_SECRET"))
      const key = Option.isSome(secret)
        ? yield* Effect.promise(() =>
            crypto.subtle.importKey(
              "raw",
              new TextEncoder().encode(Redacted.value(secret.value)),
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["verify"],
            ),
          )
        : undefined

      const unauthorized = (message: string) => Effect.fail(new Unauthorized({ message }))

      const verify = Effect.fn("Auth.verifyTicket")(function* (token: string) {
        const [body, sig] = token.split(".")
        if (!key) return yield* unauthorized(mode === "dev" ? "Invalid ticket" : "This server has no TICKET_SECRET, so it can't check sign-ins")
        if (!body || !sig) return yield* unauthorized("Invalid ticket")
        const valid = yield* Effect.promise(() =>
          crypto.subtle.verify("HMAC", key, fromB64url(sig), new TextEncoder().encode(body)),
        )
        if (!valid) return yield* unauthorized("Invalid ticket")
        const decoded = decodeTicket(new TextDecoder().decode(fromB64url(body)))
        if (Result.isFailure(decoded) || decoded.success.exp * 1000 < Date.now()) {
          return yield* unauthorized("Expired or malformed ticket")
        }
        const { exp: _exp, ...principal } = decoded.success
        return principal
      })

      const shared = Effect.fn("Auth.shared")(function* (token: string) {
        const orgId = shareOrg(token)
        if (!orgId) return yield* unauthorized("Invalid share link")
        const cell = env.WORKSPACE.get(env.WORKSPACE.idFromName(orgId))
        const link = yield* Effect.promise(async () => await cell.link(token))
        if (!link) return yield* unauthorized("This share link was turned off")
        return { orgId, ...link }
      })

      const guestOf = Effect.fn("Auth.guestOf")(function* (token: string, guest: string | undefined) {
        const link = yield* shared(token)
        const id = guest && /^[\w-]{8,40}$/.test(guest) ? guest : token.slice(-10)
        return {
          orgId: link.orgId,
          orgName: link.orgName,
          plan: link.plan,
          role: "viewer",
          actor: { type: "guest", id: `guest_${id}` },
          scope: link.artifactId,
        } satisfies Principal
      })

      const cellOf = (orgId: string) => env.WORKSPACE.get(env.WORKSPACE.idFromName(orgId))

      /** A token's role, checked with the account service when the last check is older than this. */
      const TOKEN_CHECK_MS = 5 * 60 * 1000
      /** If the account service is down, a token keeps its last-known role for this long, then stops. */
      const TOKEN_GRACE_MS = 60 * 60 * 1000

      const viaToken = Effect.fn("Auth.viaToken")(function* (token: string, devAs: string | undefined) {
        const orgId = apiTokenOrg(token)
        if (!orgId) return yield* unauthorized("Invalid access token")
        const hash = yield* Effect.promise(() => hashApiToken(token))
        const cell = cellOf(orgId)
        const found = yield* Effect.promise(async (): Promise<ResolvedToken | null> => await cell.resolveToken(hash))
        if (!found) return yield* unauthorized("This access token was revoked")
        let role = found.role
        const age = Date.now() - found.checkedAt
        if (age > TOKEN_CHECK_MS) {
          const current = yield* Effect.exit(accounts.currentRole(orgId, found.userId))
          if (current._tag === "Failure") {
            if (age > TOKEN_GRACE_MS) return yield* unauthorized("Couldn't check this access token with the account service. Try again in a moment.")
          } else if (current.value === null) {
            yield* Effect.promise(async () => void (await cell.revokeUserTokens(found.userId)))
            return yield* unauthorized("This access token's owner isn't in the workspace anymore")
          } else if (current.value !== undefined) {
            role = current.value
            yield* Effect.promise(async () => void (await cell.tokenRoleChecked(found.userId, role)))
          }
        }
        // The cell's plan is billing's latest; on Free limits an Editor's token reads, like their tickets.
        role = billing.effectiveRole(role, found.plan)
        const base = { orgId, orgName: found.orgName, plan: found.plan }
        const slug = found.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "token"
        const principal: Principal =
          devAs === "agent"
            ? { ...base, role: agentRole(role), actor: { type: "agent", id: `agt_${slug}`, onBehalfOf: found.userId, name: found.name } }
            : { ...base, role, actor: { type: "user", id: found.userId, name: found.userName } }
        fromAccessToken.add(principal)
        return principal
      })

      const principalOf = Effect.fn("Auth.principalOf")(function* (c: Credentials) {
        const token = c.bearer ?? c.ticket ?? c.cookie
        if (token?.startsWith("sh.")) return yield* guestOf(token, c.guest)
        if (token?.startsWith("sat_")) return yield* viaToken(token, c.devAs)
        if (token) return yield* verify(token)
        // In dev an explicit "view as" wins over a share cookie, so the switch keeps working.
        if (mode === "dev" && c.devAs) return devPrincipal(c.devAs)
        if (c.share) return yield* guestOf(c.share, c.guest)
        if (mode !== "dev") return yield* unauthorized("Sign in required: sign in, or send an access token (Settings → Access tokens) as a bearer token")
        return devPrincipal(c.devAs)
      })
      const resolve = (c: Credentials) =>
        Effect.map(principalOf(c), (p) => {
          const labeled = fromClient(p, c.client)
          if (labeled !== p && fromAccessToken.has(p)) fromAccessToken.add(labeled)
          return labeled
        })

      return Auth.of({ resolve, shared })
    }).pipe(Effect.orDie),
  )
}

/**
 * Principals that came from an access token. A token can't mint more tokens (so a
 * leaked one can't outlive its revocation), manage members or make share links:
 * see `notViaToken` in http.ts. (Kept beside the principal rather than in it: the
 * principal is the signed contract cells see.)
 */
export const fromAccessToken = new WeakSet<Principal>()

const decodeTicket = Schema.decodeUnknownResult(Schema.fromJsonString(Ticket))

/** An agent is the app it's calling from, still acting for the same person with the same access. */
function fromClient(p: Principal, client: string | undefined): Principal {
  const name = client?.trim().slice(0, 80)
  const slug = name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (p.actor.type !== "agent" || !name || !slug) return p
  return { ...p, actor: { ...p.actor, id: `agt_${slug}`, name } }
}

function devPrincipalAs(as: string | undefined, ownerName: string): Principal {
  const base = { orgId: "dev", orgName: "Dev Org", plan: "free" } as const
  switch (as) {
    case "agent":
      return { ...base, role: "editor", actor: { type: "agent", id: "agt_dev", onBehalfOf: "usr_dev", name: "Claude" } }
    case "guest":
      return { ...base, role: "viewer", actor: { type: "guest", id: "guest_dev" } }
    case "viewer":
      return { ...base, role: "viewer", actor: { type: "user", id: "usr_viewer", name: "Viewer" } }
    default:
      return { ...base, role: "owner", actor: { type: "user", id: "usr_dev", name: ownerName } }
  }
}

/**
 * Pull credentials off a raw Request (sockets, asset bytes, MCP). The ticket
 * cookie counts only where `ticketCookie` says so: asset GETs, for `<img>` URLs
 * that can't carry a header. Everywhere else a ticket must be sent on purpose
 * (bearer or `?ticket=`), so a cookie the browser attaches on its own never
 * opens a socket or another API route.
 */
export function credentialsFromRequest(request: Request, options: { readonly ticketCookie?: boolean } = {}): Credentials {
  const url = new URL(request.url)
  return {
    bearer: bearer(request.headers.get("authorization") ?? undefined),
    ticket: url.searchParams.get("ticket") ?? undefined,
    cookie: options.ticketCookie ? readCookie(request.headers.get("cookie") ?? undefined, cookieName(request.url, TICKET_COOKIE)) : undefined,
    devAs: request.headers.get("x-dev-as") ?? url.searchParams.get("as") ?? undefined,
    client: request.headers.get("x-standard-artifacts-client") ?? undefined,
    share: readCookie(request.headers.get("cookie") ?? undefined, SHARE_COOKIE),
    guest: readCookie(request.headers.get("cookie") ?? undefined, GUEST_COOKIE),
  }
}

export const SHARE_COOKIE = "standard_artifacts_share"
export const GUEST_COOKIE = "standard_artifacts_guest"

/** The org id inside a share token `sh.<base64url(orgId)>.<secret>`. */
function shareOrg(token: string): string | undefined {
  const [prefix, org, secret] = token.split(".")
  if (prefix !== "sh" || !org || !secret || secret.length < 20) return undefined
  try {
    return new TextDecoder().decode(fromB64url(org))
  } catch {
    return undefined
  }
}

export const bearer = (h: string | undefined) => (h?.startsWith("Bearer ") ? h.slice(7) : undefined)

export const readCookie = (header: string | undefined, name: string) =>
  header
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
