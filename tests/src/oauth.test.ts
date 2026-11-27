import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, test } from "node:test"
import { GrantStore, type PendingCode, type Sql } from "../../apps/app/src/worker/cells/grants.ts"
import {
  ACCESS_TOKEN_TTL_S,
  REFRESH_RETRY_GRACE_S,
  REFRESH_TOKEN_TTL_S,
  agentIdOf,
  agentNameOf,
  basicCredentials,
  checkClientMetadata,
  checkRedirectUri,
  fetchMetadataDocument,
  isPrivateHost,
  metadataUrlProblem,
  newSecret,
  redirectMatches,
  resourceMatches,
  s256,
  secretOrg,
  summarizeRedirect,
  verifyPkce,
  withParams,
} from "../../apps/app/src/worker/oauth.ts"

/**
 * The OAuth server's parts that don't need a Worker: PKCE, redirect URIs,
 * client metadata and metadata documents, resource binding, token formats,
 * and the grant store's codes, rotation and reuse detection (on node:sqlite,
 * standing in for a Durable Object's SQLite). mcp-oauth.live.test.ts runs the
 * whole flow through the Worker.
 */

describe("PKCE (S256 only)", () => {
  test("the RFC 7636 example verifier matches its challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert.equal(await s256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    assert.equal(await verifyPkce(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"), true)
  })

  test("a wrong, short, or missing verifier fails; so does a plain challenge", async () => {
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    assert.equal(await verifyPkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX", challenge), false)
    assert.equal(await verifyPkce("short", challenge), false)
    assert.equal(await verifyPkce(undefined, challenge), false)
    // "plain" would send the verifier itself as the challenge; it never matches its own hash.
    const verifier = "a".repeat(43)
    assert.equal(await verifyPkce(verifier, verifier), false)
  })
})

describe("redirect URIs", () => {
  test("https anywhere, http only to this computer, apps by their own scheme", () => {
    assert.deepEqual(kind("https://claude.ai/api/mcp/auth_callback"), "web")
    assert.deepEqual(kind("http://127.0.0.1:33418/callback"), "loopback")
    assert.deepEqual(kind("http://localhost:6274/oauth/callback"), "loopback")
    assert.deepEqual(kind("http://[::1]:9000/cb"), "loopback")
    assert.deepEqual(kind("cursor://anysphere.cursor-mcp/oauth/callback"), "app")
    assert.equal(checkRedirectUri("http://evil.test/cb").ok, false)
    assert.equal(checkRedirectUri("http://127.0.0.1.evil.test/cb").ok, false)
    assert.equal(checkRedirectUri("javascript:alert(1)").ok, false)
    assert.equal(checkRedirectUri("data:text/html,hi").ok, false)
    assert.equal(checkRedirectUri("file:///etc/passwd").ok, false)
    assert.equal(checkRedirectUri("https://claude.ai/cb#frag").ok, false)
    assert.equal(checkRedirectUri("https://user:pw@claude.ai/cb").ok, false)
    assert.equal(checkRedirectUri("https://claude.ai/c b").ok, false)
    assert.equal(checkRedirectUri("not a url").ok, false)
    assert.equal(checkRedirectUri(42).ok, false)
  })

  test("exact match, except loopback on any port (RFC 8252 §7.3)", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1/callback", "http://localhost:1234/cb?x=1"]
    assert.equal(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback"), true)
    assert.equal(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback/"), false)
    assert.equal(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback?x=1"), false)
    assert.equal(redirectMatches(registered, "https://claude.ai.evil.test/api/mcp/auth_callback"), false)
    assert.equal(redirectMatches(registered, "http://127.0.0.1:51234/callback"), true)
    assert.equal(redirectMatches(registered, "http://127.0.0.1:51234/other"), false)
    assert.equal(redirectMatches(registered, "http://localhost:51234/callback"), false, "localhost doesn't stand in for 127.0.0.1")
    assert.equal(redirectMatches(registered, "http://localhost:9/cb?x=1"), true)
    assert.equal(redirectMatches(registered, "http://localhost:9/cb?x=2"), false)
    assert.equal(redirectMatches(registered, "https://127.0.0.1:51234/callback"), false, "the scheme must match too")
  })

  test("the answer goes on the redirect's query, keeping what's there", () => {
    const back = new URL(withParams("http://127.0.0.1:9/cb?keep=1", { code: "c", state: "s&t", iss: "https://app.test", none: undefined }))
    assert.equal(back.searchParams.get("keep"), "1")
    assert.equal(back.searchParams.get("state"), "s&t")
    assert.equal(back.searchParams.get("iss"), "https://app.test")
    assert.equal(back.searchParams.has("none"), false)
  })
})

const kind = (uri: string) => {
  const c = checkRedirectUri(uri)
  return c.ok ? c.kind : c.reason
}

describe("client metadata", () => {
  test("keeps what we use, trims names, drops non-https logos", () => {
    const c = checkClientMetadata({
      client_name: "  Claude\u0000 Code  ",
      redirect_uris: ["http://localhost:4000/callback"],
      logo_uri: "http://insecure.test/logo.png",
      client_uri: "https://claude.com",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
    assert.ok(c.ok)
    assert.equal(c.value.name, "Claude Code")
    assert.equal(c.value.logoUri, null)
    assert.equal(c.value.uri, "https://claude.com/")
    assert.equal(c.value.authMethod, "none")
  })

  test("refuses what it can't honor", () => {
    assert.equal(error({ redirect_uris: [] }), "invalid_redirect_uri")
    assert.equal(error({ redirect_uris: ["http://evil.test/cb"] }), "invalid_redirect_uri")
    assert.equal(error({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.test/${i}`) }), "invalid_redirect_uri")
    assert.equal(error({ redirect_uris: ["https://a.test/cb"], grant_types: ["client_credentials"] }), "invalid_client_metadata")
    assert.equal(error({ redirect_uris: ["https://a.test/cb"], response_types: ["token"] }), "invalid_client_metadata")
    assert.equal(error({ redirect_uris: ["https://a.test/cb"], token_endpoint_auth_method: "private_key_jwt" }), "invalid_client_metadata")
    assert.equal(error("nope"), "invalid_client_metadata")
    // A metadata document is public, so it can't ask for a secret.
    assert.equal(checkClientMetadata({ redirect_uris: ["https://a.test/cb"], token_endpoint_auth_method: "client_secret_basic" }, { document: true }).ok, false)
  })
})

const error = (body: unknown) => {
  const c = checkClientMetadata(body)
  return c.ok ? "ok" : c.error
}

describe("client ID metadata documents (SSRF-safe)", () => {
  const url = "https://client.example.com/oauth/metadata.json"
  const doc = { client_id: url, client_name: "Example", redirect_uris: ["https://client.example.com/cb"], token_endpoint_auth_method: "none" }

  test("only https URLs with a path on a public host name", () => {
    assert.equal(metadataUrlProblem(url), undefined)
    assert.match(metadataUrlProblem("http://client.example.com/m.json")!, /https/)
    assert.match(metadataUrlProblem("https://client.example.com/")!, /path/)
    assert.match(metadataUrlProblem("https://client.example.com:8443/m.json")!, /port/)
    assert.match(metadataUrlProblem("https://user:pw@client.example.com/m.json")!, /credentials/)
    assert.match(metadataUrlProblem("https://127.0.0.1/m.json")!, /public/)
    assert.match(metadataUrlProblem("https://[::1]/m.json")!, /public/)
    assert.match(metadataUrlProblem("https://169.254.169.254/latest/meta-data")!, /public/)
    assert.match(metadataUrlProblem("https://10.0.0.8/m.json")!, /public/)
    assert.match(metadataUrlProblem("https://2130706433/m.json")!, /public/)
    assert.match(metadataUrlProblem("https://localhost/m.json")!, /public/)
    assert.match(metadataUrlProblem("https://metadata.internal/m.json")!, /public/)
    assert.match(metadataUrlProblem("https://printer.local/m.json")!, /public/)
    assert.match(metadataUrlProblem("https://intranet/m.json")!, /public/)
    assert.equal(isPrivateHost("claude.ai"), false)
  })

  test("fetches without following redirects, within time and size limits", async () => {
    let init: RequestInit | undefined
    const ok = await fetchMetadataDocument(url, async (_input, i) => {
      init = i
      return Response.json(doc)
    })
    assert.ok(ok.ok)
    assert.equal(ok.value.name, "Example")
    assert.equal(init?.redirect, "manual", "a redirect could point anywhere, so none are followed")
    assert.ok(init?.signal, "the fetch has a time limit")

    const moved = await fetchMetadataDocument(url, async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }))
    assert.equal(moved.ok, false)

    const huge = await fetchMetadataDocument(url, async () => new Response(JSON.stringify({ ...doc, pad: "x".repeat(40_000) })))
    assert.deepEqual(huge, { ok: false, reason: "The app's metadata is too large." })

    const declared = await fetchMetadataDocument(url, async () => new Response("{}", { headers: { "content-length": "999999" } }))
    assert.equal(declared.ok, false)

    const slow = await fetchMetadataDocument(url, (_i, init) => new Promise((_, fail) => init?.signal?.addEventListener("abort", () => fail(new Error("aborted")))), { timeoutMs: 50 })
    assert.deepEqual(slow, { ok: false, reason: "The app's metadata didn't load in time." })

    const other = await fetchMetadataDocument(url, async () => Response.json({ ...doc, client_id: "https://evil.example.com/m.json" }))
    assert.deepEqual(other, { ok: false, reason: "The app's metadata names a different client_id." })

    const notJson = await fetchMetadataDocument(url, async () => new Response("<html>"))
    assert.equal(notJson.ok, false)

    let called = false
    const privateHost = await fetchMetadataDocument("https://10.1.2.3/m.json", async () => {
      called = true
      return Response.json(doc)
    })
    assert.equal(privateHost.ok, false)
    assert.equal(called, false, "a private host is refused before any request")
  })
})

describe("resource binding (RFC 8707)", () => {
  test("only this server's /mcp, or none", () => {
    const origin = "https://app.standardartifacts.com"
    assert.equal(resourceMatches(null, origin), true)
    assert.equal(resourceMatches(`${origin}/mcp`, origin), true)
    assert.equal(resourceMatches(`${origin}/mcp/`, origin), true)
    assert.equal(resourceMatches(`${origin}/api/v1`, origin), false)
    assert.equal(resourceMatches("https://evil.test/mcp", origin), false)
    assert.equal(resourceMatches(origin, origin), false)
  })
})

describe("token formats", () => {
  test("the org rides in the token; kinds don't mix", () => {
    const access = newSecret("access", "org_01ABC")
    assert.match(access, /^sao_[0-9a-f]+_[A-Za-z0-9_-]{32}$/)
    assert.equal(secretOrg("access", access), "org_01ABC")
    assert.equal(secretOrg("refresh", access), undefined)
    assert.equal(secretOrg("code", newSecret("code", "org_x")), "org_x")
    assert.equal(secretOrg("access", "sao_zz_abc"), undefined)
    assert.equal(secretOrg("access", 7), undefined)
  })

  test("Basic client credentials are form-decoded", () => {
    assert.deepEqual(basicCredentials(`Basic ${btoa("cl_a%3Ab:s%20c")}`), { id: "cl_a:b", secret: "s c" })
    assert.equal(basicCredentials("Bearer x"), undefined)
  })
})

describe("what the consent page says", () => {
  test("known hosts and this computer are verified; impostors and strangers get a warning", () => {
    assert.deepEqual(summarizeRedirect({ clientName: "Claude", redirectUri: "https://claude.ai/api/mcp/auth_callback" }), { kind: "web", host: "claude.ai", verified: true, warning: null })
    assert.equal(summarizeRedirect({ clientName: "ChatGPT", redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect" }).verified, true)
    assert.deepEqual(summarizeRedirect({ clientName: "Claude Code", redirectUri: "http://localhost:4000/callback" }), { kind: "loopback", host: "this computer", verified: true, warning: null })
    const impostor = summarizeRedirect({ clientName: "Claude", redirectUri: "https://claude-ai.evil.test/cb" })
    assert.equal(impostor.verified, false)
    assert.match(impostor.warning!, /calls itself Claude, but it would send you to claude-ai\.evil\.test/)
    const stranger = summarizeRedirect({ clientName: "Acme bot", redirectUri: "https://acme.test/cb" })
    assert.match(stranger.warning!, /haven't verified acme\.test/)
    const published = summarizeRedirect({ clientName: "Acme bot", redirectUri: "https://app.acme.com/cb", metadataUrl: "https://acme.com/oauth/client.json" })
    assert.equal(published.verified, true, "the host that published the metadata vouches for its own pages")
    assert.equal(summarizeRedirect({ clientName: "Cursor", redirectUri: "cursor://anysphere.cursor-mcp/oauth/callback" }).kind, "app")
  })

  test("agents go by the app's usual name", () => {
    assert.equal(agentNameOf("Claude Code (standard-artifacts)"), "Claude Code")
    assert.equal(agentNameOf("claude-code"), "Claude Code")
    assert.equal(agentNameOf("Claude"), "Claude")
    assert.equal(agentNameOf("ChatGPT"), "ChatGPT")
    assert.equal(agentNameOf("OpenAI Codex"), "Codex")
    assert.equal(agentNameOf("Codex"), "Codex")
    assert.equal(agentNameOf("Cursor"), "Cursor")
    assert.equal(agentNameOf("Visual Studio Code"), "VS Code")
    assert.equal(agentNameOf("Acme bot"), "Acme bot")
    assert.equal(agentNameOf(null), "Agent")
    assert.equal(agentIdOf("Claude Code"), "agt_claude-code")
  })
})

// --- The grant store ------------------------------------------------------------------------------

/** node:sqlite behind the same `exec(…).toArray()` a Durable Object's SqlStorage has. */
function sqlite(): Sql {
  const db = new DatabaseSync(":memory:")
  return {
    exec: <T,>(query: string, ...bindings: Array<unknown>) => {
      const statement = db.prepare(query)
      const rows = statement.columns().length ? (statement.all(...(bindings as Array<null>)) as Array<T>) : (statement.run(...(bindings as Array<null>)), [])
      return { toArray: () => rows }
    },
  } as Sql
}

const code = (over: Partial<PendingCode> = {}): PendingCode => ({
  clientId: "cl_aaaaaaaaaaaaaaaaaaaaaaaa",
  clientName: "Claude Code",
  clientUri: null,
  logoUri: null,
  metadataDocument: false,
  redirectUri: "http://127.0.0.1:5000/callback",
  challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  resource: "https://app.test/mcp",
  userId: "usr_A",
  userName: "Ada",
  agentName: "Claude Code",
  access: "write",
  role: "editor",
  expiresAt: 1000 + 300,
  ...over,
})

/** A store with one grant made from a code at t=1000. */
function granted(over: Partial<PendingCode> = {}) {
  const store = new GrantStore(sqlite())
  store.putCode("code1", code(over), 1000)
  const taken = store.takeCode("code1", 1001)
  assert.ok(taken.ok)
  const grant = store.createGrant({ codeHash: "code1", id: "grt_1", code: taken.code, accessHash: "a1", refreshHash: "r1", now: 1001 })
  assert.ok(grant)
  return { store, grant }
}

describe("grant store", () => {
  test("a code works once; a replay ends the grant it made", () => {
    const { store } = granted()
    assert.ok(store.resolveAccess("a1", 1002))
    assert.deepEqual(store.takeCode("code1", 1003), { ok: false, reason: "used" })
    assert.equal(store.resolveAccess("a1", 1004), null, "the replay revoked the grant")
    assert.deepEqual(store.takeCode("nope", 1003), { ok: false, reason: "unknown" })
  })

  test("an expired code is refused (and spent)", () => {
    const store = new GrantStore(sqlite())
    store.putCode("c", code(), 1000)
    assert.deepEqual(store.takeCode("c", 1000 + 301), { ok: false, reason: "expired" })
    assert.deepEqual(store.takeCode("c", 1000 + 302), { ok: false, reason: "used" })
  })

  test("access tokens last an hour and note when the grant was used", () => {
    const { store } = granted()
    const found = store.resolveAccess("a1", 1500)
    assert.equal(found?.grant.agentName, "Claude Code")
    assert.equal(found?.expiresAt, 1001 + ACCESS_TOKEN_TTL_S)
    assert.equal(store.get("grt_1")?.lastUsedAt, 1500)
    assert.equal(store.resolveAccess("a1", 1001 + ACCESS_TOKEN_TTL_S), null)
    assert.equal(store.resolveAccess("r1", 1500), null, "a refresh token isn't an access token")
  })

  test("refresh rotates: the new pair works, the old access token keeps its hour, the old refresh token is spent", () => {
    const { store } = granted()
    const r = store.refresh("r1", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "a2", refreshHash: "r2" }, 2000)
    assert.ok(r.ok)
    assert.ok(store.resolveAccess("a2", 2001))
    const again = store.refresh("r2", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "a3", refreshHash: "r3" }, 2100)
    assert.ok(again.ok)
    assert.ok(store.resolveAccess("a3", 2101))
  })

  test("reuse detection: an old refresh token presented later ends the whole grant", () => {
    const { store } = granted()
    assert.ok(store.refresh("r1", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "a2", refreshHash: "r2" }, 2000).ok)
    const reused = store.refresh("r1", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "x", refreshHash: "y" }, 2000 + REFRESH_RETRY_GRACE_S + 1)
    assert.deepEqual(reused, { ok: false, reason: "reused" })
    assert.equal(store.resolveAccess("a2", 2100), null, "the thief's and the client's tokens both stop")
    assert.deepEqual(store.refresh("r2", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "z", refreshHash: "w" }, 2100), { ok: false, reason: "unknown" })
    assert.equal(store.list(null, 2100).length, 0)
  })

  test("a retry right after a rotation (the answer got lost) gets a fresh pair; the lost pair is retired", () => {
    const { store } = granted()
    assert.ok(store.refresh("r1", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "a2", refreshHash: "r2" }, 2000).ok)
    const retry = store.refresh("r1", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "a3", refreshHash: "r3" }, 2005)
    assert.ok(retry.ok)
    assert.equal(store.resolveAccess("a2", 2006), null, "the access token the client never got is gone")
    assert.ok(store.resolveAccess("a3", 2006))
    // If the lost refresh token ever turns up, someone else had it.
    assert.deepEqual(store.refresh("r2", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "q", refreshHash: "q2" }, 2010), { ok: false, reason: "reused" })
    assert.equal(store.resolveAccess("a3", 2011), null)
  })

  test("no grace once the replacement was used", () => {
    const { store } = granted()
    assert.ok(store.refresh("r1", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "a2", refreshHash: "r2" }, 2000).ok)
    assert.ok(store.refresh("r2", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "a3", refreshHash: "r3" }, 2001).ok)
    assert.deepEqual(store.refresh("r1", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "x", refreshHash: "y" }, 2002), { ok: false, reason: "reused" })
  })

  test("a refresh token works only for its client, and only for 30 days", () => {
    const { store } = granted()
    assert.deepEqual(store.refresh("r1", "cl_bbbbbbbbbbbbbbbbbbbbbbbb", { accessHash: "x", refreshHash: "y" }, 2000), { ok: false, reason: "client" })
    assert.deepEqual(store.refresh("r1", "cl_aaaaaaaaaaaaaaaaaaaaaaaa", { accessHash: "x", refreshHash: "y" }, 1001 + REFRESH_TOKEN_TTL_S), { ok: false, reason: "expired" })
  })

  test("revoking either token ends the grant; connecting the same app again replaces its grant", () => {
    const { store } = granted()
    assert.equal(store.revokeToken("r1"), true)
    assert.equal(store.resolveAccess("a1", 1002), null)

    const second = granted()
    second.store.putCode("code2", code({ redirectUri: "http://127.0.0.1:6000/callback" }), 1100)
    const taken = second.store.takeCode("code2", 1101)
    assert.ok(taken.ok)
    second.store.createGrant({ codeHash: "code2", id: "grt_2", code: taken.code, accessHash: "b1", refreshHash: "s1", now: 1101 })
    assert.deepEqual(second.store.list(null, 1200).map((g) => g.id), ["grt_2"], "one Claude Code install, one grant")
    assert.equal(second.store.resolveAccess("a1", 1200), null)
  })

  test("a metadata-document client (one id for every install) keeps each grant", () => {
    const { store } = granted({ clientId: "https://claude.ai/oauth/mcp.json", metadataDocument: true })
    store.putCode("code2", code({ clientId: "https://claude.ai/oauth/mcp.json", metadataDocument: true }), 1100)
    const taken = store.takeCode("code2", 1101)
    assert.ok(taken.ok)
    store.createGrant({ codeHash: "code2", id: "grt_2", code: taken.code, accessHash: "b1", refreshHash: "s1", now: 1101 })
    assert.equal(store.list(null, 1200).length, 2)
  })

  test("the list is one person's or everyone's, and only live grants", () => {
    const { store } = granted()
    store.putCode("code2", code({ userId: "usr_B", userName: "Bo", clientId: "cl_bbbbbbbbbbbbbbbbbbbbbbbb" }), 1100)
    const taken = store.takeCode("code2", 1101)
    assert.ok(taken.ok)
    store.createGrant({ codeHash: "code2", id: "grt_2", code: taken.code, accessHash: "b1", refreshHash: "s1", now: 1101 })
    assert.deepEqual(store.list("usr_A", 1200).map((g) => g.id), ["grt_1"])
    assert.equal(store.list(null, 1200).length, 2)
    assert.equal(store.list(null, 1101 + REFRESH_TOKEN_TTL_S + 10).length, 0, "a grant nobody refreshed in 30 days is gone")
    store.roleChecked("usr_B", "removed", 5)
    assert.equal(store.get("grt_2")?.role, "removed")
  })
})
