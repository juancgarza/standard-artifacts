import { Config, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { Ticket, Unauthorized, type ArtifactKind, type Principal } from "@standard-artifacts/protocol"
import { Bindings } from "./env"

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
   */
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const env = yield* Bindings
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
        if (!key || !body || !sig) return yield* unauthorized("Invalid ticket")
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

      const principalOf = Effect.fn("Auth.principalOf")(function* (c: Credentials) {
        const token = c.bearer ?? c.ticket ?? c.cookie
        if (token?.startsWith("sh.")) return yield* guestOf(token, c.guest)
        if (token) return yield* verify(token)
        // In dev an explicit "view as" wins over a share cookie, so the switch keeps working.
        if (mode === "dev" && c.devAs) return devPrincipal(c.devAs)
        if (c.share) return yield* guestOf(c.share, c.guest)
        if (mode !== "dev") return yield* unauthorized("Sign in required")
        return devPrincipal(c.devAs)
      })
      const resolve = (c: Credentials) => Effect.map(principalOf(c), (p) => fromClient(p, c.client))

      return Auth.of({ resolve, shared })
    }).pipe(Effect.orDie),
  )
}

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

/** Pull credentials off a raw Request (used for WebSocket upgrades). */
export function credentialsFromRequest(request: Request): Credentials {
  const url = new URL(request.url)
  return {
    bearer: bearer(request.headers.get("authorization") ?? undefined),
    ticket: url.searchParams.get("ticket") ?? undefined,
    cookie: readCookie(request.headers.get("cookie") ?? undefined, "standard_artifacts_ticket"),
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
