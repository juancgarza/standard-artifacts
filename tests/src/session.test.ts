import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  accessClaims,
  apiTokenOrg,
  cookieKey,
  displayName,
  hashApiToken,
  newApiToken,
  roleFromSlugs,
  safeReturnTo,
  seal,
  setCookie,
  signInProblem,
  slugForRole,
  unseal,
  userActorId,
  workosUserId,
  workspaceName,
} from "../../apps/app/src/worker/session.ts"

/** Sign-in's pure parts (no server needed): cookies, roles, ids, tokens, config. */

describe("sealed cookies", () => {
  test("round-trip, and refuse another key, another purpose or any tampering", async () => {
    const key = await cookieKey("a-cookie-password-that-is-long-enough!")
    const sealed = await seal(key, "session", { hello: "world" })
    assert.match(sealed, /^v1\.[\w-]+\.[\w-]+$/)
    assert.deepEqual(await unseal(key, "session", sealed), { hello: "world" })
    assert.equal(await unseal(key, "signin", sealed), undefined, "a sealed value only opens for its purpose")
    const other = await cookieKey("a-different-password-that-is-long-enough")
    assert.equal(await unseal(other, "session", sealed), undefined)
    const [v, iv, data] = sealed.split(".")
    const flipped = data!.slice(0, 5) + (data![5] === "A" ? "B" : "A") + data!.slice(6)
    assert.equal(await unseal(key, "session", `${v}.${iv}.${flipped}`), undefined)
    for (const junk of [undefined, "", "v1", "v2.a.b", "v1..", "not-a-cookie"]) assert.equal(await unseal(key, "session", junk), undefined)
    assert.notEqual(await seal(key, "session", { hello: "world" }), sealed, "a fresh IV every time")
  })
})

describe("roles", () => {
  test("our slugs, WorkOS's defaults, and anything else as viewer; the highest of several wins", () => {
    assert.equal(roleFromSlugs(["owner"]), "owner")
    assert.equal(roleFromSlugs(["admin"]), "owner")
    assert.equal(roleFromSlugs(["editor"]), "editor")
    assert.equal(roleFromSlugs(["member"]), "editor")
    assert.equal(roleFromSlugs(["viewer"]), "viewer")
    assert.equal(roleFromSlugs(["billing"]), "viewer")
    assert.equal(roleFromSlugs([]), "viewer")
    assert.equal(roleFromSlugs([undefined, null]), "viewer")
    assert.equal(roleFromSlugs(["viewer", "member"]), "editor")
    assert.equal(roleFromSlugs(["member", "admin", "viewer"]), "owner")
  })

  test("the slug to write prefers ours, falls back to admin and member, and never maps viewer upward", () => {
    const all = new Set(["owner", "editor", "viewer", "admin", "member"])
    const defaults = new Set(["admin", "member"])
    assert.equal(slugForRole("owner", all), "owner")
    assert.equal(slugForRole("editor", all), "editor")
    assert.equal(slugForRole("owner", defaults), "admin")
    assert.equal(slugForRole("editor", defaults), "member")
    assert.equal(slugForRole("viewer", defaults), undefined)
    assert.equal(slugForRole("viewer", undefined), "viewer", "roles unknown: try ours")
  })
})

describe("ids", () => {
  test("a WorkOS user id maps to usr_ and back; dev ids aren't WorkOS ids", () => {
    const workos = "user_01HXYZ0123456789ABCDEFGHJK"
    assert.equal(userActorId(workos), "usr_01HXYZ0123456789ABCDEFGHJK")
    assert.equal(workosUserId(userActorId(workos)), workos)
    assert.equal(workosUserId("usr_dev"), undefined)
    assert.equal(workosUserId("usr_viewer"), undefined)
    assert.equal(workosUserId("agt_claude"), undefined)
  })

  test("names", () => {
    assert.equal(displayName({ email: "ada@x.test", first_name: "Ada", last_name: "Lovelace" }), "Ada Lovelace")
    assert.equal(displayName({ email: "ada@x.test", first_name: null }), "ada")
    assert.equal(workspaceName({ email: "ada@x.test", first_name: "Ada" }), "Ada's workspace")
    assert.equal(workspaceName({ email: "grace@x.test" }), "grace's workspace")
  })
})

describe("access tokens", () => {
  test("carry their org, and only well-formed ones parse", async () => {
    for (const org of ["org_01HXYZ0123456789ABCDEFGHJK", "dev", "a-b_c"]) {
      const token = newApiToken(org)
      assert.match(token, /^sat_[0-9a-f]+_[\w-]{32}$/)
      assert.equal(apiTokenOrg(token), org)
    }
    assert.notEqual(newApiToken("dev"), newApiToken("dev"))
    for (const bad of ["", "sat_", "sat_6465_short", `sat_zz_${"a".repeat(32)}`, `sat_2e2e2f_${"a".repeat(32)}`, `sh.ZGV2.${"a".repeat(32)}`]) {
      assert.equal(apiTokenOrg(bad), undefined, bad)
    }
    assert.match(await hashApiToken("sat_x"), /^[0-9a-f]{64}$/)
    assert.equal(await hashApiToken("sat_x"), await hashApiToken("sat_x"))
  })
})

describe("WorkOS access tokens", () => {
  const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
  test("read sid, exp, org and roles", () => {
    assert.deepEqual(accessClaims(jwt({ sid: "s", exp: 5, org_id: "org_1", role: "admin" })), { sid: "s", exp: 5, orgId: "org_1", roles: ["admin"] })
    assert.deepEqual(accessClaims(jwt({ sid: "s", exp: 5, roles: ["member", "viewer"] }))?.roles, ["member", "viewer"])
    assert.equal(accessClaims(jwt({ exp: 5 })), undefined)
    assert.equal(accessClaims("garbage"), undefined)
  })
})

describe("redirects, cookies and config", () => {
  test("return_to stays on this app", () => {
    assert.equal(safeReturnTo("/boards/b_1?x=1"), "/boards/b_1?x=1")
    for (const evil of ["//evil.test", "https://evil.test", "/\\evil.test", "evil", "/api/auth/logout", "/x\r\nSet-Cookie: a=b", null, undefined]) {
      assert.equal(safeReturnTo(evil), "/", String(evil))
    }
  })

  test("cookies are HttpOnly, SameSite=Lax, and Secure except over plain http to this machine", () => {
    assert.equal(setCookie("https://app.example.com/x", "n", "v", 10), "n=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=10; Secure")
    assert.match(setCookie("http://app.example.com/x", "n", "v", 10), /; Secure$/)
    assert.doesNotMatch(setCookie("http://localhost:5173/x", "n", "v", 10), /Secure/)
    assert.doesNotMatch(setCookie("http://127.0.0.1:4747/x", "n", "v", 10), /Secure/)
  })

  test("live sign-in config: everything missing is named, and a short cookie password is refused", () => {
    const ok = { TICKET_SECRET: "t", WORKOS_API_KEY: "sk", WORKOS_CLIENT_ID: "client", WORKOS_COOKIE_PASSWORD: "x".repeat(32) }
    assert.equal(signInProblem(ok), undefined)
    assert.match(signInProblem({})!, /TICKET_SECRET, WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD/)
    assert.match(signInProblem({ ...ok, WORKOS_CLIENT_ID: " " })!, /WORKOS_CLIENT_ID/)
    assert.match(signInProblem({ ...ok, WORKOS_COOKIE_PASSWORD: "short" })!, /at least 32/)
    assert.match(signInProblem({ ...ok, APP_URL: "not a url" })!, /APP_URL/)
    assert.equal(signInProblem({ ...ok, APP_URL: "https://app.example.com" }), undefined)
  })
})
