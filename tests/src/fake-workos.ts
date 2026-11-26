import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"

/**
 * A fake WorkOS for the live-mode tests: the User Management and Organizations
 * endpoints the Worker calls, in memory, plus a stand-in for AuthKit's hosted
 * sign-in page. CI runs everything against it; no real WorkOS keys needed.
 *
 * It behaves like WorkOS where our code depends on it: refresh tokens rotate
 * (an old one stops working), a user in several orgs gets
 * `organization_selection_required`, access tokens carry `sid`, `org_id` and
 * `role`, and an invitation is accepted by signing in with its token. Lists
 * come in pages (`limit`, `after`), like WorkOS's.
 *
 * Tests can also make it misbehave: fail the next call to a route (`failNext`,
 * for 429s and outages), ask for SSO or MFA before switching into an org
 * (`stepUp`), answer slowly (`delayMs`), or change things mid-request
 * (`beforeWrite`), as someone in the WorkOS dashboard might.
 */

export const FAKE_API_KEY = "fake-workos-api-key"
export const FAKE_CLIENT_ID = "client_fake_workos"

type User = { id: string; email: string; first_name: string | null; last_name: string | null; profile_picture_url: string | null }
type Org = { id: string; name: string; metadata: Record<string, string> }
type Membership = { id: string; user_id: string; organization_id: string; role: string; status: "active"; created_at: string }
type Invitation = {
  id: string
  email: string
  organization_id: string
  role_slug: string | null
  state: "pending" | "accepted" | "revoked" | "expired"
  token: string
  expires_at: string
  created_at: string
  resent: number
}
type Session = { id: string; userId: string; orgId: string | undefined; ended: boolean }

const ulid = () => randomBytes(13).toString("hex").toUpperCase().slice(0, 26)
const b64url = (s: string) => Buffer.from(s).toString("base64url")

export interface FakeWorkOS {
  readonly url: string
  readonly users: Map<string, User>
  readonly orgs: Map<string, Org>
  readonly memberships: Map<string, Membership>
  readonly invitations: Map<string, Invitation>
  readonly sessions: Map<string, Session>
  /** Every API call, as "METHOD /path" (no query), for assertions. */
  readonly calls: Array<string>
  /** Roles the environment has (WorkOS role slugs). */
  roles: Set<string>
  /** Access token lifetime in seconds. Under a minute means every ticket refreshes. */
  accessTtl: number
  /** Every API answer waits this long, so concurrent requests overlap. */
  delayMs: number
  /** Orgs that need another sign-in step: a refresh into them fails with this WorkOS error code (`sso_required`, `mfa_enrollment`…). */
  readonly stepUp: Map<string, string>
  /** Runs before a membership is changed or deleted (`PUT`/`DELETE /user_management/organization_memberships/:id`). */
  beforeWrite: ((route: string) => void) | undefined
  /** The next call to `route` ("METHOD /path") answers `status` with `body`, without doing anything. */
  failNext(route: string, status: number, body: unknown): void
  /** The next hosted sign-in completes as this email, without showing the page. */
  signInAs(email: string | undefined): void
  user(email: string, first?: string, last?: string): User
  org(name: string): Org
  member(userId: string, orgId: string, role: string): Membership
  membershipOf(userId: string, orgId: string): Membership | undefined
  close(): Promise<void>
}

export async function startFakeWorkOS(): Promise<FakeWorkOS> {
  const users = new Map<string, User>()
  const orgs = new Map<string, Org>()
  const memberships = new Map<string, Membership>()
  const invitations = new Map<string, Invitation>()
  const sessions = new Map<string, Session>()
  const codes = new Map<string, { userId: string; orgId: string | undefined }>()
  const refreshTokens = new Map<string, string>() // refresh token → session id
  const pending = new Map<string, string>() // pending authentication token → user id
  const calls: Array<string> = []
  let nextSignIn: string | undefined
  const failures = new Map<string, { status: number; body: unknown }>()

  const fake: FakeWorkOS = {
    url: "",
    users,
    orgs,
    memberships,
    invitations,
    sessions,
    calls,
    roles: new Set(["owner", "editor", "viewer", "admin", "member"]),
    accessTtl: 300,
    delayMs: 0,
    stepUp: new Map(),
    beforeWrite: undefined,
    failNext: (route, status, body) => void failures.set(route, { status, body }),
    signInAs: (email) => void (nextSignIn = email),
    user: (email, first, last) => {
      const existing = [...users.values()].find((u) => u.email === email)
      if (existing) return existing
      const u: User = { id: `user_${ulid()}`, email, first_name: first ?? null, last_name: last ?? null, profile_picture_url: null }
      users.set(u.id, u)
      return u
    },
    org: (name) => {
      const o: Org = { id: `org_${ulid()}`, name, metadata: {} }
      orgs.set(o.id, o)
      return o
    },
    member: (userId, orgId, role) => {
      const m: Membership = { id: `om_${ulid()}`, user_id: userId, organization_id: orgId, role, status: "active", created_at: new Date().toISOString() }
      memberships.set(m.id, m)
      return m
    },
    membershipOf: (userId, orgId) => [...memberships.values()].find((m) => m.user_id === userId && m.organization_id === orgId),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }

  const userMemberships = (userId: string) => [...memberships.values()].filter((m) => m.user_id === userId)

  const accessToken = (s: Session) => {
    const m = s.orgId ? fake.membershipOf(s.userId, s.orgId) : undefined
    const claims = {
      iss: "https://fake.workos.test",
      sub: s.userId,
      sid: s.id,
      exp: Math.floor(Date.now() / 1000) + fake.accessTtl,
      ...(s.orgId && { org_id: s.orgId }),
      ...(m && { role: m.role, roles: [m.role] }),
    }
    return `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claims))}.fake`
  }

  const authenticated = (s: Session) => {
    const refresh = `rt_${randomBytes(12).toString("hex")}`
    refreshTokens.set(refresh, s.id)
    return { user: users.get(s.userId), organization_id: s.orgId ?? null, access_token: accessToken(s), refresh_token: refresh, authentication_method: "Password" }
  }

  const newSession = (userId: string, orgId: string | undefined): Session => {
    const s = { id: `session_${ulid()}`, userId, orgId, ended: false }
    sessions.set(s.id, s)
    return s
  }

  /** What signing in on the hosted page does: find or make the user, accept an invitation, hand back a code. */
  const completeSignIn = (email: string, invitationToken: string | null) => {
    const local = email.split("@")[0] ?? "someone"
    const user = fake.user(email, local.charAt(0).toUpperCase() + local.slice(1))
    let orgId: string | undefined
    if (invitationToken) {
      const inv = [...invitations.values()].find((i) => i.token === invitationToken && i.state === "pending")
      if (inv && inv.email === email) {
        if (!fake.membershipOf(user.id, inv.organization_id)) fake.member(user.id, inv.organization_id, inv.role_slug ?? "member")
        inv.state = "accepted"
        orgId = inv.organization_id
      }
    }
    const code = `code_${randomBytes(10).toString("hex")}`
    codes.set(code, { userId: user.id, orgId })
    return code
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  /** One page of a list, by `limit` (WorkOS's default is 10) and the `after` cursor (an item id). */
  const list = (items: Array<{ id: string }>, url: URL) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 10) || 10, 100)
    const ordered = url.searchParams.get("order") === "desc" ? [...items].reverse() : items
    const after = url.searchParams.get("after")
    const start = after ? ordered.findIndex((x) => x.id === after) + 1 : 0
    const data = ordered.slice(start, start + limit)
    return { object: "list", data, list_metadata: { before: null, after: start + limit < ordered.length ? (data.at(-1)?.id ?? null) : null } }
  }
  const notFound = (res: ServerResponse) => send(res, 404, { code: "entity_not_found", message: "Not found" })
  const bad = (res: ServerResponse, code: string, message: string) => send(res, 400, { code, error: code, message, error_description: message })

  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, any>>((resolve) => {
      let data = ""
      req.on("data", (c) => (data += c))
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch {
          resolve({})
        }
      })
    })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake")
    const path = url.pathname
    const route = `${req.method} ${path}`

    // --- The hosted sign-in page (AuthKit) --------------------------------------------------------
    if (route === "GET /user_management/authorize") {
      const redirect = url.searchParams.get("redirect_uri")
      if (url.searchParams.get("client_id") !== FAKE_CLIENT_ID || !redirect || url.searchParams.get("provider") !== "authkit") {
        return send(res, 400, { error: "invalid_request" })
      }
      const state = url.searchParams.get("state") ?? ""
      const invitation = url.searchParams.get("invitation_token")
      const email = nextSignIn ?? url.searchParams.get("email")
      if (email) {
        nextSignIn = undefined
        const back = new URL(redirect)
        back.searchParams.set("code", completeSignIn(email, invitation))
        back.searchParams.set("state", state)
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }
      // A page a browser can fill in, like AuthKit's: it submits back here with ?email=.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      const hidden = [...url.searchParams].map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, "&quot;")}">`).join("")
      return res.end(
        `<!doctype html><title>Fake AuthKit</title><form method="get" action="/user_management/authorize">${hidden}<label>Email <input name="email" type="email" required></label><button>Continue</button></form>`,
      )
    }

    if (route === "GET /user_management/sessions/logout") {
      const s = sessions.get(url.searchParams.get("session_id") ?? "")
      if (s) s.ended = true
      res.writeHead(302, { location: url.searchParams.get("return_to") ?? "/" })
      return res.end()
    }

    // --- The API ---------------------------------------------------------------------------------------
    calls.push(route)
    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {}
    if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs))
    const failure = failures.get(route)
    if (failure) {
      failures.delete(route)
      return send(res, failure.status, failure.body)
    }
    if (route === "POST /user_management/authenticate") {
      if (body.client_id !== FAKE_CLIENT_ID || body.client_secret !== FAKE_API_KEY) return send(res, 401, { error: "invalid_client" })
      switch (body.grant_type) {
        case "authorization_code": {
          const code = codes.get(body.code)
          codes.delete(body.code)
          if (!code) return bad(res, "invalid_grant", "The code is invalid or expired")
          let orgId = code.orgId
          if (!orgId) {
            const ms = userMemberships(code.userId)
            if (ms.length === 1) orgId = ms[0]!.organization_id
            if (ms.length > 1) {
              const token = `pat_${randomBytes(8).toString("hex")}`
              pending.set(token, code.userId)
              return send(res, 403, {
                code: "organization_selection_required",
                message: "The user must choose an organization to finish their authentication.",
                pending_authentication_token: token,
                organizations: ms.map((m) => ({ id: m.organization_id, name: orgs.get(m.organization_id)?.name })),
                user: users.get(code.userId),
              })
            }
          }
          return send(res, 200, authenticated(newSession(code.userId, orgId)))
        }
        case "urn:workos:oauth:grant-type:organization-selection": {
          const userId = pending.get(body.pending_authentication_token)
          pending.delete(body.pending_authentication_token)
          if (!userId || !fake.membershipOf(userId, body.organization_id)) return bad(res, "invalid_grant", "Invalid selection")
          return send(res, 200, authenticated(newSession(userId, body.organization_id)))
        }
        case "refresh_token": {
          const sid = refreshTokens.get(body.refresh_token)
          // Rotation: a refresh token works once.
          refreshTokens.delete(body.refresh_token)
          const s = sid ? sessions.get(sid) : undefined
          if (!s || s.ended) return bad(res, "invalid_grant", "Session has already ended.")
          const orgId = body.organization_id ?? s.orgId
          if (orgId && !fake.membershipOf(s.userId, orgId)) return bad(res, "invalid_grant", "The user isn't a member of that organization.")
          const step = orgId && orgId !== s.orgId ? fake.stepUp.get(orgId) : undefined
          if (step) {
            // Like WorkOS's authentication errors: `error`/`error_description`. The refresh token stays good.
            refreshTokens.set(body.refresh_token, s.id)
            return send(res, 403, { error: step, error_description: "User must authenticate using one of the matching connections.", connection_ids: ["conn_fake"] })
          }
          s.orgId = orgId
          return send(res, 200, authenticated(s))
        }
        default:
          return bad(res, "unsupported_grant_type", "Unsupported grant")
      }
    }

    if (req.headers.authorization !== `Bearer ${FAKE_API_KEY}`) return send(res, 401, { message: "Unauthorized" })

    let m: RegExpMatchArray | null
    if ((m = path.match(/^\/user_management\/users\/([\w-]+)$/)) && req.method === "GET") {
      const u = users.get(m[1]!)
      return u ? send(res, 200, { object: "user", ...u }) : notFound(res)
    }
    if (route === "POST /organizations") {
      return send(res, 201, { object: "organization", ...fake.org(String(body.name)) })
    }
    if ((m = path.match(/^\/organizations\/([\w-]+)\/roles$/)) && req.method === "GET") {
      return orgs.has(m[1]!)
        ? send(res, 200, { object: "list", data: [...fake.roles].map((slug) => ({ object: "role", slug, name: slug, type: "EnvironmentRole" })) })
        : notFound(res)
    }
    if ((m = path.match(/^\/organizations\/([\w-]+)$/)) && req.method === "GET") {
      const o = orgs.get(m[1]!)
      return o ? send(res, 200, { object: "organization", ...o }) : notFound(res)
    }

    const toMembership = (x: Membership) => ({
      object: "organization_membership",
      ...x,
      organization_name: orgs.get(x.organization_id)?.name,
      role: { slug: x.role },
      roles: [{ slug: x.role }],
      updated_at: x.created_at,
    })
    if (route === "GET /user_management/organization_memberships") {
      const userId = url.searchParams.get("user_id")
      const orgId = url.searchParams.get("organization_id")
      if (!userId && !orgId) return bad(res, "invalid_request", "user_id or organization_id is required")
      const found = [...memberships.values()].filter((x) => (!userId || x.user_id === userId) && (!orgId || x.organization_id === orgId))
      return send(res, 200, list(found.map(toMembership), url))
    }
    if (route === "POST /user_management/organization_memberships") {
      if (!users.has(body.user_id) || !orgs.has(body.organization_id)) return notFound(res)
      if (body.role_slug && !fake.roles.has(body.role_slug)) return bad(res, "invalid_role", `Role ${body.role_slug} doesn't exist`)
      return send(res, 201, toMembership(fake.member(body.user_id, body.organization_id, body.role_slug ?? "member")))
    }
    if ((m = path.match(/^\/user_management\/organization_memberships\/([\w-]+)$/))) {
      const x = memberships.get(m[1]!)
      if (!x) return notFound(res)
      if (req.method === "GET") return send(res, 200, toMembership(x))
      if (req.method === "PUT" || req.method === "DELETE") fake.beforeWrite?.(route)
      if (req.method === "PUT") {
        if (!fake.roles.has(body.role_slug)) return bad(res, "invalid_role", `Role ${body.role_slug} doesn't exist`)
        x.role = body.role_slug
        return send(res, 200, toMembership(x))
      }
      if (req.method === "DELETE") {
        memberships.delete(x.id)
        res.writeHead(202)
        return res.end()
      }
    }

    const toInvitation = ({ token, resent: _, ...i }: Invitation) => ({
      object: "invitation",
      ...i,
      token,
      accept_invitation_url: `https://fake.workos.test/invite?invitation_token=${token}`,
      updated_at: i.created_at,
    })
    if (route === "GET /user_management/invitations") {
      const orgId = url.searchParams.get("organization_id")
      return send(res, 200, list([...invitations.values()].filter((i) => !orgId || i.organization_id === orgId).map(toInvitation), url))
    }
    if (route === "POST /user_management/invitations") {
      if (!orgs.has(body.organization_id)) return notFound(res)
      const existing = [...users.values()].find((u) => u.email === body.email)
      if (existing && fake.membershipOf(existing.id, body.organization_id)) return bad(res, "user_already_organization_member", "This user is already a member of the organization.")
      if (body.role_slug && !fake.roles.has(body.role_slug)) return bad(res, "invalid_role", `Role ${body.role_slug} doesn't exist`)
      const i: Invitation = {
        id: `invitation_${ulid()}`,
        email: String(body.email),
        organization_id: body.organization_id,
        role_slug: body.role_slug ?? null,
        state: "pending",
        token: randomBytes(12).toString("hex"),
        expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
        created_at: new Date().toISOString(),
        resent: 0,
      }
      invitations.set(i.id, i)
      return send(res, 201, toInvitation(i))
    }
    if ((m = path.match(/^\/user_management\/invitations\/([\w-]+)(?:\/(resend|revoke))?$/))) {
      const i = invitations.get(m[1]!)
      if (!i) return notFound(res)
      if (req.method === "GET" && !m[2]) return send(res, 200, toInvitation(i))
      if (req.method === "POST" && m[2] === "resend") {
        if (i.state !== "pending") return bad(res, "invite_not_pending", "Only pending invitations can be resent")
        i.resent++
        return send(res, 200, toInvitation(i))
      }
      if (req.method === "POST" && m[2] === "revoke") {
        i.state = "revoked"
        return send(res, 200, toInvitation(i))
      }
    }
    notFound(res)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  ;(fake as { url: string }).url = `http://127.0.0.1:${port}`
  return fake
}
