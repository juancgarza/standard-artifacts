import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import { signTicket } from "../../apps/app/src/worker/tickets.ts"
import { SESSION_COOKIE, TICKET_COOKIE } from "../../apps/app/src/worker/session.ts"
import { images } from "./images.ts"
import { bearer, startLive, TICKET_SECRET, Visitor, type LiveApp } from "./live-harness.ts"

/**
 * Live mode with sign-in (Standard Artifacts Cloud), against a fake WorkOS:
 * sessions and tickets, first sign-in, roles, org switching, members and
 * invitations, access tokens, and that one org can never reach another.
 */

let app: LiveApp
before(async () => {
  app = await startLive()
})
after(async () => {
  await app?.close()
})

/** Someone who signed in and holds a ticket. */
async function signedIn(email: string, first?: string, last?: string) {
  if (first) app.fake.user(email, first, last)
  const v = new Visitor(app, email)
  await v.signIn()
  const s = await v.session()
  assert.equal(s.status, 200, JSON.stringify(s.body))
  return v
}

const whoami = async (v: Visitor) => (await v.api("GET", "/workspace")).body.principal

describe("sign-in", () => {
  test("signed out, the API refuses and nothing falls back to dev", async () => {
    const res = await fetch(`${app.base}/api/v1/workspace`)
    assert.equal(res.status, 401)
    const v = new Visitor(app, "nobody@example.test")
    const s = await v.session()
    assert.equal(s.status, 401)
    assert.deepEqual(s.body, { mode: "live", signedIn: false })
    // Dev's switch means nothing here.
    assert.equal((await fetch(`${app.base}/api/v1/workspace`, { headers: { "x-dev-as": "agent" } })).status, 401)
  })

  test("login redirects to AuthKit with a state, and the callback sets an httpOnly session cookie", async () => {
    const v = new Visitor(app, "first@example.test")
    const login = await v.fetch("/api/auth/login?return_to=/settings/members")
    assert.equal(login.status, 302)
    const authorize = new URL(login.headers.get("location")!)
    assert.equal(authorize.pathname, "/user_management/authorize")
    assert.equal(authorize.searchParams.get("provider"), "authkit")
    assert.equal(authorize.searchParams.get("redirect_uri"), `${app.base}/api/auth/callback`)
    assert.ok(authorize.searchParams.get("state"))
    const setCookie = login.headers.getSetCookie().join("\n")
    assert.match(setCookie, /standard_artifacts_signin=.*HttpOnly.*SameSite=Lax/)

    app.fake.signInAs(v.email)
    const hosted = await v.fetch(authorize.toString())
    const callback = await v.fetch(hosted.headers.get("location")!)
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get("location"), "/settings/members")
    assert.match(callback.headers.getSetCookie().join("\n"), new RegExp(`${SESSION_COOKIE}=v1\\..*HttpOnly.*SameSite=Lax`))
    assert.ok(v.cookies.get(SESSION_COOKIE))
    assert.equal(v.cookies.get("standard_artifacts_signin"), undefined, "the sign-in state is used up")
  })

  test("a callback whose state doesn't match the browser's is refused", async () => {
    const v = new Visitor(app, "csrf@example.test")
    const login = await v.fetch("/api/auth/login")
    const authorize = new URL(login.headers.get("location")!)
    app.fake.signInAs(v.email)
    const hosted = await v.fetch(authorize.toString())
    const back = new URL(hosted.headers.get("location")!)
    back.searchParams.set("state", "someone-elses-state")
    const res = await v.fetch(back.toString())
    assert.equal(res.status, 400)
    assert.equal(v.cookies.get(SESSION_COOKIE), undefined)
    // Nor from a browser that never started a sign-in.
    const stranger = new Visitor(app, "stranger@example.test")
    assert.equal((await stranger.fetch(hosted.headers.get("location")!)).status, 400)
  })

  test("return_to can't send anyone off-site", async () => {
    // Decoded values, as the query carries them: `?return_to=/%09/evil.test` is "/\t/evil.test".
    for (const evil of ["//evil.test/x", "https://evil.test", "/\\evil.test", "/\t/evil.test", "/\n/evil.test", "/x\r\nSet-Cookie: a=b", "/.//evil.test", "/%2F/x/../../evil.test"]) {
      const v = new Visitor(app, `ret${Math.random().toString(36).slice(2)}@example.test`)
      const landed = await v.signIn({ returnTo: evil })
      assert.ok(landed === "/" || (landed.startsWith("/") && !landed.startsWith("//") && new URL(landed, app.base).origin === app.base), `${JSON.stringify(evil)} → ${landed}`)
    }
    // Exactly as the reviewer sent it, encoded in the query: the browser gets "/", never a tab it would strip.
    for (const query of ["/%09/evil.example", "%2F%5Cevil.example", "//evil.example", "https://evil.example", "/%0d%0aLocation:%20https://evil.example"]) {
      const v = new Visitor(app, `raw${Math.random().toString(36).slice(2)}@example.test`)
      app.fake.signInAs(v.email)
      const login = await v.fetch(`/api/auth/login?return_to=${query}`)
      const hosted = await v.fetch(login.headers.get("location")!)
      const callback = await v.fetch(hosted.headers.get("location")!)
      assert.equal(callback.headers.get("location"), "/", query)
    }
    // Paths on the app still work, query and hash included.
    const ok = new Visitor(app, `retok${Math.random().toString(36).slice(2)}@example.test`)
    assert.equal(await ok.signIn({ returnTo: "/boards/b_1?view=grid#top" }), "/boards/b_1?view=grid#top")
  })

  test("first sign-in makes “<First name>'s workspace” with them as owner", async () => {
    const ada = await signedIn("ada@example.test", "Ada", "Lovelace")
    const s = await ada.session()
    assert.equal(s.body.org.name, "Ada's workspace")
    assert.equal(s.body.role, "owner")
    assert.equal(s.body.org.plan, "free")
    const user = app.fake.user("ada@example.test")
    assert.equal(s.body.user.id, `usr_${user.id.slice("user_".length)}`)
    assert.equal(s.body.user.name, "Ada Lovelace")

    const me = await whoami(ada)
    assert.deepEqual(me.actor, { type: "user", id: s.body.user.id, name: "Ada Lovelace" })
    assert.equal(me.orgId, s.body.org.id)
    assert.equal(me.role, "owner")
    assert.equal(app.fake.membershipOf(user.id, s.body.org.id)?.role, "owner")
    // Signing in again lands in the same workspace; no second one is made.
    const orgsBefore = app.fake.orgs.size
    const again = new Visitor(app, "ada@example.test")
    await again.signIn()
    assert.equal((await again.session()).body.org.id, s.body.org.id)
    assert.equal(app.fake.orgs.size, orgsBefore)
  })

  test("the ticket opens sockets with ?ticket=, and the ticket cookie covers <img> URLs and nothing else", async () => {
    const v = await signedIn("sockets@example.test", "Sam")
    const url = `${app.base.replace(/^http/, "ws")}/api/v1/workspace/live`
    const open = (u: string, headers?: Record<string, string>) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(u, headers ? ({ headers } as never) : undefined)
        ws.onopen = () => {
          ws.close()
          resolve(true)
        }
        ws.onerror = () => resolve(false)
      })
    assert.equal(await open(`${url}?ticket=${encodeURIComponent(v.ticket!)}`), true)
    assert.equal(await open(url), false)
    assert.ok(v.cookies.get(TICKET_COOKIE), "the ticket endpoint also sets the ticket cookie")
    const cookie = `${TICKET_COOKIE}=${v.cookies.get(TICKET_COOKIE)}`

    // An image on a board: the cookie alone fetches it, as an <img> would.
    const board = (await v.api("POST", "/artifacts", { kind: "board", title: "Pictures" })).body
    const up = await fetch(`${app.base}/api/v1/artifacts/${board.id}/assets`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${v.ticket}` }, body: images.png })
    assert.equal(up.status, 201)
    const { url: assetUrl } = await up.json()
    assert.equal((await fetch(new URL(assetUrl, app.base), { headers: { cookie } })).status, 200)
    assert.equal((await fetch(new URL(assetUrl, app.base))).status, 401)

    // Nothing else takes it: not the API, not uploads, not sockets, not MCP.
    assert.equal((await fetch(`${app.base}/api/v1/workspace`, { headers: { cookie } })).status, 401)
    assert.equal((await fetch(`${app.base}/api/v1/artifacts/${board.id}/assets`, { method: "POST", headers: { "content-type": "image/png", cookie }, body: images.png })).status, 401)
    assert.equal(await open(url, { cookie }), false)
    const mcp = await fetch(`${app.base}/mcp`, { method: "POST", headers: { cookie, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })
    assert.equal(mcp.status, 401)
  })

  test("tickets are short-lived and signed; a forged or tampered one is refused", async () => {
    const v = await signedIn("tickets@example.test", "Tia")
    const s = await v.session()
    assert.ok(s.body.expiresAt - Date.now() <= 5 * 60 * 1000 + 1000)
    const me = await whoami(v)
    const forged = await signTicket("not-the-secret", { ...me, role: "owner", orgId: "org_SOMEONE_ELSE" }, 60)
    assert.equal((await bearer(app, forged, "GET", "/workspace")).status, 401)
    const expired = await signTicket(TICKET_SECRET, me, -10)
    assert.equal((await bearer(app, expired, "GET", "/workspace")).status, 401)
    const [body, sig] = v.ticket!.split(".")
    const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), orgId: "org_SOMEONE_ELSE" })).toString("base64url")}.${sig}`
    assert.equal((await bearer(app, tampered, "GET", "/workspace")).status, 401)
  })

  test("a tampered session cookie is no session", async () => {
    const v = await signedIn("tamper@example.test", "Tam")
    const sealed = v.cookies.get(SESSION_COOKIE)!
    v.cookies.set(SESSION_COOKIE, `${sealed.slice(0, -4)}AAAA`)
    assert.equal((await v.session()).status, 401)
    v.cookies.set(SESSION_COOKIE, "v1.not.sealed")
    assert.equal((await v.session()).status, 401)
  })

  test("POSTs from another site are refused", async () => {
    const v = await signedIn("origin@example.test", "Ori")
    const res = await v.fetch("/api/auth/ticket", { method: "POST", headers: { origin: "https://evil.test" } })
    assert.equal(res.status, 403)
  })

  test("the session refreshes its WorkOS access token when it's about to expire, keeping the rotated refresh token", async () => {
    const authenticates = () => app.fake.calls.filter((c) => c === "POST /user_management/authenticate").length
    const steady = await signedIn("steady@example.test", "Stu")
    let before = authenticates()
    await steady.session()
    assert.equal(authenticates(), before, "a token with minutes left isn't refreshed")

    app.fake.accessTtl = 30
    try {
      const v = await signedIn("refresh@example.test", "Rae")
      before = authenticates()
      assert.equal((await v.session()).status, 200)
      assert.equal(authenticates(), before + 1, "a token with under a minute left is refreshed")
      // WorkOS rotated the refresh token; the cookie kept the new one, so this refresh works too.
      assert.equal((await v.session()).status, 200)
      assert.equal(authenticates(), before + 2)
    } finally {
      app.fake.accessTtl = 300
    }
  })

  test("a session WorkOS ended (signed out elsewhere) gets signed out here, cookies and all", async () => {
    app.fake.accessTtl = 30
    try {
      const v = await signedIn("ended@example.test", "End")
      for (const s of app.fake.sessions.values()) if (s.userId === app.fake.user("ended@example.test").id) s.ended = true
      const res = await v.session()
      assert.equal(res.status, 401)
      assert.equal(v.cookies.get(SESSION_COOKIE), undefined)
      assert.equal(v.cookies.get(TICKET_COOKIE), undefined)
    } finally {
      app.fake.accessTtl = 300
    }
  })

  test("WorkOS rate limits, outages and other refusals during a refresh keep the session; only a refused refresh token ends it", async () => {
    app.fake.accessTtl = 30
    try {
      const v = await signedIn("flaky@example.test", "Fla")
      const sealed = v.cookies.get(SESSION_COOKIE)
      for (const [status, body] of [
        [429, { message: "Too many requests" }],
        [503, { message: "Service unavailable" }],
        [403, { code: "something_else", message: "Not now" }],
      ] as const) {
        app.fake.failNext("POST /user_management/authenticate", status, body)
        const res = await v.session()
        assert.equal(res.status, 503, `${status}: ${JSON.stringify(res.body)}`)
        assert.equal(v.cookies.get(SESSION_COOKIE), sealed, `${status} keeps the session cookie`)
      }
      // WorkOS is back: the same session refreshes fine.
      assert.equal((await v.session()).status, 200)
      // A refresh token WorkOS refuses (400 invalid_grant) is a session that's over.
      app.fake.failNext("POST /user_management/authenticate", 400, { error: "invalid_grant", error_description: "Session has already ended." })
      assert.equal((await v.session()).status, 401)
      assert.equal(v.cookies.get(SESSION_COOKIE), undefined)
    } finally {
      app.fake.accessTtl = 300
    }
  })

  test("logout clears the cookies and sends the browser through AuthKit's sign-out", async () => {
    const v = await signedIn("logout@example.test", "Lou")
    const out = await v.post("/api/auth/logout")
    assert.equal(out.status, 200)
    const to = new URL(out.body.redirect)
    assert.equal(to.pathname, "/user_management/sessions/logout")
    assert.ok(to.searchParams.get("session_id")?.startsWith("session_"))
    assert.equal(to.searchParams.get("return_to"), `${app.base}/`)
    assert.equal(v.cookies.get(SESSION_COOKIE), undefined)
    assert.equal((await v.session()).status, 401)
  })
})

describe("roles", () => {
  test("WorkOS slugs map to roles: owner/admin → owner, editor/member → editor, viewer and anything else → viewer", async () => {
    const owner = await signedIn("roles-owner@example.test", "Ro")
    const orgId = (await owner.session()).body.org.id
    for (const [slug, role] of [
      ["owner", "owner"],
      ["admin", "owner"],
      ["editor", "editor"],
      ["member", "editor"],
      ["viewer", "viewer"],
      ["billing-admin", "viewer"],
    ] as const) {
      const email = `role-${slug}@example.test`
      const user = app.fake.user(email, "R")
      app.fake.member(user.id, orgId, slug)
      const v = new Visitor(app, email)
      await v.signIn()
      const s = await v.session()
      assert.equal(s.body.role, role, slug)
      assert.equal((await whoami(v)).role, role, slug)
    }
  })

  test("a viewer can read but not write", async () => {
    const owner = await signedIn("vw-owner@example.test", "Vo")
    const orgId = (await owner.session()).body.org.id
    const created = await owner.api("POST", "/artifacts", { kind: "doc", title: "Plans" })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const user = app.fake.user("vw-viewer@example.test", "Vi")
    app.fake.member(user.id, orgId, "viewer")
    const viewer = new Visitor(app, "vw-viewer@example.test")
    await viewer.signIn()
    await viewer.session()
    assert.equal((await viewer.api("GET", `/artifacts/${created.body.id}/content`)).status, 200)
    assert.equal((await viewer.api("POST", "/artifacts", { kind: "doc", title: "Nope" })).status, 403)
  })
})

describe("orgs", () => {
  test("create a second workspace, list both, switch between them; someone else's can't be switched to", async () => {
    const v = await signedIn("multi@example.test", "Mia")
    const first = (await v.session()).body.org
    const made = await v.post("/api/auth/orgs", { name: "Side project" })
    assert.equal(made.status, 200, JSON.stringify(made.body))
    assert.equal(made.body.org.name, "Side project")
    assert.equal(made.body.role, "owner")
    v.ticket = made.body.ticket
    assert.equal((await whoami(v)).orgId, made.body.org.id)

    const orgs = await (await v.fetch("/api/auth/orgs")).json()
    assert.deepEqual(
      orgs.map((o: any) => [o.name, o.current]).sort(),
      [
        ["Mia's workspace", false],
        ["Side project", true],
      ].sort(),
    )

    // The session itself moved: a fresh ticket is for the new org.
    assert.equal((await v.session()).body.org.id, made.body.org.id)
    const back = await v.post("/api/auth/switch", { orgId: first.id })
    assert.equal(back.status, 200)
    assert.equal(back.body.org.id, first.id)
    assert.equal((await v.session()).body.org.id, first.id)

    const other = await signedIn("multi-other@example.test", "Oz")
    const theirs = (await other.session()).body.org.id
    const refused = await v.post("/api/auth/switch", { orgId: theirs })
    assert.equal(refused.status, 403)
    assert.equal((await v.session()).body.org.id, first.id, "still where it was")
  })

  test("switching into an org that wants SSO or MFA is refused, and the session stays where it was", async () => {
    const v = await signedIn("sso-switch@example.test", "Sso")
    const home = (await v.session()).body.org.id
    const strict = app.fake.org("Strict Corp")
    app.fake.member(app.fake.user("sso-switch@example.test").id, strict.id, "editor")
    for (const code of ["sso_required", "mfa_enrollment"]) {
      app.fake.stepUp.set(strict.id, code)
      const res = await v.post("/api/auth/switch", { orgId: strict.id })
      assert.equal(res.status, 403, JSON.stringify(res.body))
      assert.match(res.body.message, /SSO or MFA/)
      assert.ok(v.cookies.get(SESSION_COOKIE), "still signed in")
      assert.equal((await v.session()).body.org.id, home)
    }
    // A switch WorkOS is too busy for is "try again", not a sign-out either.
    app.fake.stepUp.delete(strict.id)
    app.fake.failNext("POST /user_management/authenticate", 429, { message: "Too many requests" })
    assert.equal((await v.post("/api/auth/switch", { orgId: strict.id })).status, 503)
    assert.equal((await v.session()).status, 200)
    assert.equal((await v.post("/api/auth/switch", { orgId: strict.id })).status, 200)
  })

  test("one person can own at most 10 workspaces through New workspace", async () => {
    const v = await signedIn("many-orgs@example.test", "Manny")
    const user = app.fake.user("many-orgs@example.test")
    for (let i = 0; i < 9; i++) app.fake.member(user.id, app.fake.org(`Org ${i}`).id, "owner")
    // Being a member elsewhere doesn't count against it.
    app.fake.member(user.id, app.fake.org("Someone else's").id, "editor")
    const before = app.fake.orgs.size
    const refused = await v.post("/api/auth/orgs", { name: "Eleventh" })
    assert.equal(refused.status, 403, JSON.stringify(refused.body))
    assert.match(refused.body.message, /10 workspaces/)
    assert.equal(app.fake.orgs.size, before, "no org was made")
  })

  test("someone in several orgs lands in the one they last used", async () => {
    const v = await signedIn("last@example.test", "Lia")
    const home = (await v.session()).body.org.id
    const made = await v.post("/api/auth/orgs", { name: "Second" })
    // A new browser has no memory of it: WorkOS asks which org, and we pick one of theirs.
    const fresh = new Visitor(app, "last@example.test")
    await fresh.signIn()
    assert.ok([home, made.body.org.id].includes((await fresh.session()).body.org.id))
    // This browser remembers Second.
    await v.post("/api/auth/logout")
    await v.signIn()
    assert.equal((await v.session()).body.org.id, made.body.org.id)
  })
})

describe("members and invitations", () => {
  test("an owner invites by email with a role; the invitee signs in with the link and lands in that org with that role", async () => {
    const owner = await signedIn("inv-owner@example.test", "Iris")
    const orgId = (await owner.session()).body.org.id
    const sent = await owner.api("POST", "/org/invitations", { email: "Invitee@Example.test", role: "viewer" })
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.equal(sent.body.email, "invitee@example.test")
    assert.equal(sent.body.role, "viewer")
    assert.equal(sent.body.state, "pending")

    let list = await owner.api("GET", "/org/members")
    assert.equal(list.body.canManage, true)
    assert.deepEqual(
      list.body.invitations.map((i: any) => [i.email, i.role]),
      [["invitee@example.test", "viewer"]],
    )
    assert.equal((await owner.api("POST", `/org/invitations/${sent.body.id}/resend`)).status, 200)

    const token = app.fake.invitations.get(sent.body.id)!.token
    const invitee = new Visitor(app, "invitee@example.test")
    await invitee.signIn({ invitationToken: token })
    const s = await invitee.session()
    assert.equal(s.body.org.id, orgId, "lands in the org that invited them, not a new one")
    assert.equal(s.body.role, "viewer")

    list = await owner.api("GET", "/org/members")
    assert.deepEqual(list.body.members.map((m: any) => [m.email, m.role]).sort(), [
      ["inv-owner@example.test", "owner"],
      ["invitee@example.test", "viewer"],
    ])
    assert.equal(list.body.invitations.length, 0)

    // Members see each other; only owners manage.
    const seen = await invitee.api("GET", "/org/members")
    assert.equal(seen.status, 200)
    assert.equal(seen.body.canManage, false)
    assert.equal((await invitee.api("POST", "/org/invitations", { email: "x@example.test", role: "owner" })).status, 403)
  })

  test("owners change roles and remove people; the change reaches the person's next ticket", async () => {
    app.fake.accessTtl = 30
    try {
      const owner = await signedIn("mgr-owner@example.test", "Max")
      const orgId = (await owner.session()).body.org.id
      const bob = app.fake.user("mgr-bob@example.test", "Bob")
      const membership = app.fake.member(bob.id, orgId, "viewer")
      const b = new Visitor(app, "mgr-bob@example.test")
      await b.signIn()
      assert.equal((await b.session()).body.role, "viewer")

      const changed = await owner.api("PATCH", `/org/members/${membership.id}`, { role: "editor" })
      assert.equal(changed.status, 200, JSON.stringify(changed.body))
      assert.equal(changed.body.role, "editor")
      assert.equal(app.fake.memberships.get(membership.id)?.role, "editor")
      assert.equal((await b.session()).body.role, "editor")
      assert.equal((await b.api("POST", "/artifacts", { kind: "doc", title: "Bob's" })).status, 200)

      // Not an owner: can't change anyone.
      const ownerMembership = app.fake.membershipOf(app.fake.user("mgr-owner@example.test").id, orgId)!
      assert.equal((await b.api("PATCH", `/org/members/${ownerMembership.id}`, { role: "viewer" })).status, 403)
      assert.equal((await b.api("DELETE", `/org/members/${ownerMembership.id}`)).status, 403)

      const removed = await owner.api("DELETE", `/org/members/${membership.id}`)
      assert.equal(removed.status, 204, JSON.stringify(removed.body))
      assert.equal(app.fake.memberships.has(membership.id), false)
      const after = await b.session()
      assert.equal(after.status, 401, "their session for that org is over")
    } finally {
      app.fake.accessTtl = 300
    }
  })

  test("the last owner can't be removed or demoted, even by themselves", async () => {
    const owner = await signedIn("last-owner@example.test", "Lo")
    const orgId = (await owner.session()).body.org.id
    const m = app.fake.membershipOf(app.fake.user("last-owner@example.test").id, orgId)!
    const demote = await owner.api("PATCH", `/org/members/${m.id}`, { role: "editor" })
    assert.equal(demote.status, 400)
    assert.match(demote.body.message, /only owner/)
    const remove = await owner.api("DELETE", `/org/members/${m.id}`)
    assert.equal(remove.status, 400)
    // With a second owner, the first can step down.
    const co = app.fake.user("co-owner@example.test", "Co")
    app.fake.member(co.id, orgId, "owner")
    assert.equal((await owner.api("PATCH", `/org/members/${m.id}`, { role: "editor" })).status, 200)
  })

  test("an access token can list members but never change them or share links, even an owner's", async () => {
    const owner = await signedIn("tok-admin@example.test", "Tad")
    const orgId = (await owner.session()).body.org.id
    const token = (await owner.createToken("cli")).body.token
    const bob = app.fake.user("tok-admin-bob@example.test", "Bob")
    const m = app.fake.member(bob.id, orgId, "editor")
    const invite = (await owner.api("POST", "/org/invitations", { email: "tok-pending@example.test", role: "editor" })).body
    const doc = (await owner.api("POST", "/artifacts", { kind: "doc", title: "Shared?" })).body

    for (const headers of [{}, { "x-dev-as": "agent" }] as Array<Record<string, string>>) {
      assert.equal((await bearer(app, token, "GET", "/org/members", undefined, headers)).status, 200)
      const calls = [
        ["POST", "/org/invitations", { email: "attacker@evil.test", role: "owner" }],
        ["POST", `/org/invitations/${invite.id}/resend`, undefined],
        ["DELETE", `/org/invitations/${invite.id}`, undefined],
        ["PATCH", `/org/members/${m.id}`, { role: "owner" }],
        ["DELETE", `/org/members/${m.id}`, undefined],
        ["POST", `/artifacts/${doc.id}/link`, undefined],
      ] as const
      for (const [method, path, body] of calls) {
        const res = await bearer(app, token, method, path, body, headers)
        assert.equal(res.status, 403, `${method} ${path} ${JSON.stringify(headers)}: ${JSON.stringify(res.body)}`)
      }
    }
    assert.ok(![...app.fake.invitations.values()].some((i) => i.email === "attacker@evil.test"))
    assert.equal(app.fake.memberships.get(m.id)?.role, "editor")
    assert.equal(app.fake.invitations.get(invite.id)?.state, "pending")
    // The person, in the app, still can.
    assert.equal((await owner.api("POST", `/artifacts/${doc.id}/link`)).status, 200)
    assert.equal((await owner.api("PATCH", `/org/members/${m.id}`, { role: "viewer" })).status, 200)
  })

  test("two owners demoting or removing each other at once never leave the org without an owner", async () => {
    for (const [method, body] of [
      ["PATCH", { role: "editor" }],
      ["DELETE", undefined],
    ] as const) {
      const tag = method.toLowerCase()
      const a = await signedIn(`race-a-${tag}@example.test`, "Ana")
      const orgId = (await a.session()).body.org.id
      const bUser = app.fake.user(`race-b-${tag}@example.test`, "Ben")
      const bm = app.fake.member(bUser.id, orgId, "owner")
      const b = new Visitor(app, bUser.email)
      await b.signIn()
      await b.session()
      const am = app.fake.membershipOf(app.fake.user(`race-a-${tag}@example.test`).id, orgId)!
      // Slow answers, so without a lock both would read "two owners" before either writes.
      app.fake.delayMs = 40
      try {
        const [ra, rb] = await Promise.all([a.api(method, `/org/members/${bm.id}`, body), b.api(method, `/org/members/${am.id}`, body)])
        const statuses = [ra.status, rb.status].sort()
        assert.equal(statuses.filter((s) => s < 300).length, 1, `${method}: exactly one goes through (${statuses})`)
        assert.ok(statuses.some((s) => s === 400 || s === 403), `${method}: the other is refused (${statuses})`)
      } finally {
        app.fake.delayMs = 0
      }
      const left = [...app.fake.memberships.values()].filter((x) => x.organization_id === orgId && x.role === "owner")
      assert.equal(left.length, 1, `${method}: one owner left`)
    }
  })

  test("a demotion that would leave no owner (someone changed WorkOS meanwhile) is rolled back", async () => {
    const a = await signedIn("rollback-a@example.test", "Rolla")
    const orgId = (await a.session()).body.org.id
    const am = app.fake.membershipOf(app.fake.user("rollback-a@example.test").id, orgId)!
    const bm = app.fake.member(app.fake.user("rollback-b@example.test", "Rollo").id, orgId, "owner")
    // While Rolla demotes Rollo, someone in the WorkOS dashboard demotes Rolla.
    app.fake.beforeWrite = () => {
      app.fake.beforeWrite = undefined
      am.role = "member"
    }
    try {
      const res = await a.api("PATCH", `/org/members/${bm.id}`, { role: "editor" })
      assert.equal(res.status, 400, JSON.stringify(res.body))
      assert.match(res.body.message, /without an owner/)
    } finally {
      app.fake.beforeWrite = undefined
    }
    assert.equal(app.fake.memberships.get(bm.id)?.role, "owner", "Rollo is an owner again")
  })

  test("members and invitations list past the first page", async () => {
    const owner = await signedIn("paging@example.test", "Page")
    const orgId = (await owner.session()).body.org.id
    for (let i = 0; i < 130; i++) {
      const id = `invitation_PAGE${String(i).padStart(4, "0")}${orgId.slice(-8)}`
      app.fake.invitations.set(id, {
        id, email: `p${i}@example.test`, organization_id: orgId, role_slug: "member", state: "pending", token: `tok${i}${orgId}`,
        expires_at: new Date(Date.now() + 86400_000).toISOString(), created_at: new Date().toISOString(), resent: 0,
      })
    }
    for (let i = 0; i < 105; i++) app.fake.member(app.fake.user(`pm${i}@example.test`, "P").id, orgId, "viewer")
    const list = await owner.api("GET", "/org/members")
    assert.equal(list.status, 200)
    assert.equal(list.body.invitations.length, 130)
    assert.equal(list.body.members.length, 106)
  })

  test("a pending invitation can be revoked", async () => {
    const owner = await signedIn("rev-owner@example.test", "Rev")
    const sent = await owner.api("POST", "/org/invitations", { email: "revoked@example.test", role: "editor" })
    assert.equal((await owner.api("DELETE", `/org/invitations/${sent.body.id}`)).status, 204)
    assert.equal(app.fake.invitations.get(sent.body.id)?.state, "revoked")
    assert.equal((await owner.api("GET", "/org/members")).body.invitations.length, 0)
  })

  test("an invite with a role WorkOS doesn't have falls back to WorkOS's default slugs", async () => {
    const owner = await signedIn("fallback@example.test", "Fa")
    const orgId = (await owner.session()).body.org.id
    app.fake.roles = new Set(["admin", "member"])
    try {
      const sent = await owner.api("POST", "/org/invitations", { email: "fb-editor@example.test", role: "editor" })
      assert.equal(sent.status, 200)
      assert.equal(app.fake.invitations.get(sent.body.id)?.role_slug, "member")
      // Viewer has nothing to fall back to: it says so instead of granting more.
      const viewer = await owner.api("POST", "/org/invitations", { email: "fb-viewer@example.test", role: "viewer" })
      assert.equal(viewer.status, 400)
      assert.match(viewer.body.message, /no "viewer" role/)
      assert.ok(orgId)
    } finally {
      app.fake.roles = new Set(["owner", "editor", "viewer", "admin", "member"])
    }
  })
})

describe("access tokens", () => {
  test("create (shown once), list, use as the person, use as their agent, revoke", async () => {
    const v = await signedIn("tok@example.test", "Toby")
    const me = await whoami(v)
    const made = await v.createToken("Claude Code")
    assert.equal(made.status, 200, JSON.stringify(made.body))
    assert.match(made.body.token, /^sat_[0-9a-f]+_[\w-]{32}$/)
    const listed = await v.api("GET", "/tokens")
    assert.deepEqual(
      listed.body.map((t: any) => t.name),
      ["Claude Code"],
    )
    assert.equal(JSON.stringify(listed.body).includes(made.body.token), false, "the list never shows the token")

    const asMe = await bearer(app, made.body.token, "GET", "/workspace")
    assert.equal(asMe.status, 200)
    assert.deepEqual(asMe.body.principal.actor, me.actor)
    assert.equal(asMe.body.principal.role, "owner")
    assert.equal(asMe.body.principal.orgId, me.orgId)

    const asAgent = await bearer(app, made.body.token, "GET", "/workspace", undefined, { "x-dev-as": "agent" })
    assert.deepEqual(asAgent.body.principal.actor, { type: "agent", id: "agt_claude-code", onBehalfOf: me.actor.id, name: "Claude Code" })
    assert.equal(asAgent.body.principal.role, "editor", "an agent never acts above editor")
    // A token can't mint more tokens, as its person or as their agent.
    assert.equal((await bearer(app, made.body.token, "POST", "/tokens", { name: "more" })).status, 403)
    assert.equal((await bearer(app, made.body.token, "POST", "/tokens", { name: "more" }, { "x-dev-as": "agent" })).status, 403)

    // Remote MCP takes it too, acting as an agent.
    const mcp = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${made.body.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    })
    assert.equal(mcp.status, 200)

    assert.equal((await v.api("DELETE", `/tokens/${made.body.id}`)).status, 204)
    assert.equal((await bearer(app, made.body.token, "GET", "/workspace")).status, 401)
  })

  test("making a token needs the browser's session, not just a ticket", async () => {
    const v = await signedIn("tok-session@example.test", "Tes")
    // A ticket on its own (say, one copied from a socket URL in a log) can't make a token.
    const bare = await v.api("POST", "/tokens", { name: "from a leaked ticket" })
    assert.equal(bare.status, 403, JSON.stringify(bare.body))
    // Nor with someone else's session cookie beside it.
    const other = await signedIn("tok-session-other@example.test", "Oth")
    const mixed = await fetch(`${app.base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${v.ticket}`, cookie: other.cookieHeader() },
      body: JSON.stringify({ name: "mixed" }),
    })
    assert.equal(mixed.status, 403)
    assert.equal((await v.api("GET", "/tokens")).body.length, 0)
    // In the app, signed in: yes.
    assert.equal((await v.createToken("laptop")).status, 200)
  })

  test("a removed member's tokens stop working", async () => {
    const owner = await signedIn("tok-owner@example.test", "Tom")
    const orgId = (await owner.session()).body.org.id
    const user = app.fake.user("tok-member@example.test", "Tess")
    const m = app.fake.member(user.id, orgId, "editor")
    const member = new Visitor(app, "tok-member@example.test")
    await member.signIn()
    await member.session()
    const token = (await member.createToken("laptop")).body.token
    assert.equal((await bearer(app, token, "GET", "/workspace")).status, 200)
    assert.equal((await owner.api("DELETE", `/org/members/${m.id}`)).status, 204)
    assert.equal((await bearer(app, token, "GET", "/workspace")).status, 401)
  })

  test("garbage and look-alike tokens are refused", async () => {
    for (const t of ["sat_", "sat_zz_short", `sat_${"6f7267"}_${"a".repeat(32)}`, "sat_../../etc"]) {
      assert.equal((await bearer(app, t, "GET", "/workspace")).status, 401, t)
    }
  })
})

describe("isolation between orgs", () => {
  test("a member of one org can never read or change another's", async () => {
    const ann = await signedIn("iso-ann@example.test", "Ann")
    const annOrg = (await ann.session()).body.org.id
    const doc = (await ann.api("POST", "/artifacts", { kind: "doc", title: "Ann's secret" })).body
    const invite = (await ann.api("POST", "/org/invitations", { email: "iso-friend@example.test", role: "viewer" })).body
    const annMembership = app.fake.membershipOf(app.fake.user("iso-ann@example.test").id, annOrg)!
    const annToken = (await ann.createToken("ann")).body

    const carl = await signedIn("iso-carl@example.test", "Carl")
    assert.notEqual((await carl.session()).body.org.id, annOrg)

    assert.equal((await carl.api("GET", `/artifacts/${doc.id}/content`)).status, 404)
    assert.equal((await carl.api("PATCH", `/artifacts/${doc.id}`, { title: "mine" })).status, 404)
    assert.equal((await carl.api("GET", "/workspace")).body.artifacts.some((a: any) => a.id === doc.id), false)
    // Carl owns his org, but Ann's people and invitations aren't his to touch.
    assert.equal((await carl.api("PATCH", `/org/members/${annMembership.id}`, { role: "viewer" })).status, 404)
    assert.equal((await carl.api("DELETE", `/org/members/${annMembership.id}`)).status, 404)
    assert.equal((await carl.api("POST", `/org/invitations/${invite.id}/resend`)).status, 404)
    assert.equal((await carl.api("DELETE", `/org/invitations/${invite.id}`)).status, 404)
    assert.equal(app.fake.invitations.get(invite.id)?.state, "pending")
    assert.equal(app.fake.memberships.get(annMembership.id)?.role, "owner")
    assert.ok(!JSON.stringify((await carl.api("GET", "/org/members")).body).includes("iso-ann"))
    assert.equal((await carl.api("DELETE", `/tokens/${annToken.id}`)).status, 404)
    assert.equal((await bearer(app, annToken.token, "GET", "/workspace")).status, 200, "Ann's token still works")
    assert.equal((await carl.post("/api/auth/switch", { orgId: annOrg })).status, 403)

    // Sockets: Carl's ticket opens his org's cells, never Ann's.
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${app.base.replace(/^http/, "ws")}/api/v1/rooms/${doc.id}?ticket=${encodeURIComponent(carl.ticket!)}`)
      ws.onmessage = (e) => {
        ws.close()
        resolve(!String(e.data).includes('"type":"error"'))
      }
      ws.onerror = () => resolve(false)
      ws.onclose = () => resolve(false)
    })
    assert.equal(opened, false)
  })
})

describe("live mode without its config", () => {
  test("an access token made before the config broke stops working after the grace period instead of keeping its role", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-live-"))
    try {
      const first = await startLive({}, { persist: dir })
      let token: string
      try {
        const v = new Visitor(first, "broken-later@example.test")
        first.fake.user(v.email, "Bro")
        await v.signIn()
        await v.session()
        token = (await v.createToken("cli")).body.token
        assert.equal((await bearer(first, token, "GET", "/workspace")).status, 200)
      } finally {
        await first.close()
      }
      // Last checked with WorkOS over an hour ago.
      const sqlite = (d: string): Array<string> =>
        readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? sqlite(join(d, f)) : f.endsWith(".sqlite") ? [join(d, f)] : []))
      let aged = 0
      for (const file of sqlite(dir)) {
        const db = new DatabaseSync(file)
        try {
          if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'api_tokens'").get()) aged += Number(db.prepare("UPDATE api_tokens SET checked_at = 0").run().changes)
        } finally {
          db.close()
        }
      }
      assert.equal(aged, 1)
      const broken = await startLive({ WORKOS_API_KEY: undefined }, { persist: dir })
      try {
        const res = await bearer(broken, token, "GET", "/workspace")
        assert.equal(res.status, 401, JSON.stringify(res.body))
        assert.match(res.body.message, /Couldn't check this access token/)
      } finally {
        await broken.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails loudly with what's missing, and never acts as the dev owner", async () => {
    const broken = await startLive({ WORKOS_API_KEY: undefined, WORKOS_COOKIE_PASSWORD: "short" })
    try {
      const res = await fetch(`${broken.base}/api/auth/ticket`, { method: "POST" })
      assert.equal(res.status, 503)
      const body = await res.json()
      assert.equal(body.signedIn, false)
      assert.match(body.problem, /WORKOS_API_KEY/)
      const login = await fetch(`${broken.base}/api/auth/login`, { redirect: "manual" })
      assert.equal(login.status, 503)
      assert.match(await login.text(), /WORKOS_API_KEY/)
      assert.equal((await fetch(`${broken.base}/api/v1/workspace`)).status, 401)
      assert.equal((await fetch(`${broken.base}/api/v1/org/members`)).status, 401)
    } finally {
      await broken.close()
    }
  })
})
