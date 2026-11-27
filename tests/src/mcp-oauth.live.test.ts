import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, before, describe, test } from "node:test"
import { startLive, Visitor, type LiveApp } from "./live-harness.ts"

/**
 * Remote MCP sign-in (OAuth), end to end against the Worker in live mode and a
 * fake WorkOS, the way Claude Code, Claude.ai or ChatGPT go through it:
 * discovery from a 401, registration, the browser's trip through the consent
 * page, the code for tokens, MCP with the access token, refresh with
 * rotation, revocation. Plus choosing an org, read-only grants, and what
 * losing membership or being disconnected does. oauth.test.ts covers the
 * pieces; mcp-oauth.sdk.test.ts runs the official MCP SDK client against it.
 */

let app: LiveApp
before(async () => {
  app = await startLive()
})
after(async () => {
  await app?.close()
})

const REDIRECT = "http://127.0.0.1/callback"

type Rpc = { result?: any; error?: { code: number; message: string } }

/** A minimal Streamable HTTP MCP client with a bearer token. */
async function mcp(token: string) {
  let session: string | undefined
  let id = 0
  const post = async (body: object) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }
    if (session) headers["mcp-session-id"] = session
    if (session) headers["mcp-protocol-version"] = "2025-11-25"
    const res = await fetch(`${app.base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) })
    session ??= res.headers.get("mcp-session-id") ?? undefined
    const text = await res.text()
    const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5)
    return { status: res.status, headers: res.headers, body: json ? (JSON.parse(json) as Rpc) : undefined }
  }
  const init = await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } })
  if (init.status === 200) await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  const request = async (method: string, params: object = {}) => post({ jsonrpc: "2.0", id: ++id, method, params })
  const callTool = async (name: string, args: object) => {
    const r = await request("tools/call", { name, arguments: args })
    assert.equal(r.status, 200, `${name}: HTTP ${r.status} ${JSON.stringify(r.body)}`)
    return r.body!.result
  }
  return { init, request, callTool }
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

async function register(body: object = {}) {
  const res = await fetch(`${app.base}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code (standard-artifacts)", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...body }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

const form = (path: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${app.base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(params) }).then(async (r) => ({
    status: r.status,
    headers: r.headers,
    body: (await r.text().then((t) => (t ? JSON.parse(t) : null))) as any,
  }))

/** The browser half: /api/oauth/authorize → the consent page's data. Returns the request id and what the page shows. */
async function startConsent(browser: Visitor, clientId: string, options: { redirectUri?: string; state?: string; challenge: string; extra?: Record<string, string> }) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: options.redirectUri ?? "http://127.0.0.1:54321/callback",
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    state: options.state ?? "st-123",
    resource: `${app.base}/mcp`,
    scope: "mcp",
    ...options.extra,
  })
  const res = await browser.fetch(`/api/oauth/authorize?${q}`)
  assert.equal(res.status, 302)
  const location = res.headers.get("location")!
  return location
}

async function consentInfo(browser: Visitor, location: string) {
  const request = new URL(location, app.base).searchParams.get("request")!
  const res = await browser.fetch(`/api/oauth/consent?request=${request}`)
  return { status: res.status, body: (await res.json()) as any, request }
}

const answer = (browser: Visitor, body: object) =>
  browser
    .fetch("/api/oauth/consent", { method: "POST", headers: { "content-type": "application/json", origin: app.base }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: (await r.json()) as any }))

async function signedIn(email: string, first: string) {
  app.fake.user(email, first)
  const v = new Visitor(app, email)
  await v.signIn()
  await v.session()
  return v
}

/** The whole dance for one person: register, consent (approve), token. */
async function connect(browser: Visitor, options: { orgId?: string; access?: "write" | "read"; clientName?: string } = {}) {
  const client = await register(options.clientName ? { client_name: options.clientName } : {})
  assert.equal(client.status, 201, JSON.stringify(client.body))
  const { verifier, challenge } = pkce()
  const location = await startConsent(browser, client.body.client_id, { challenge })
  const info = await consentInfo(browser, location)
  assert.equal(info.status, 200, JSON.stringify(info.body))
  const orgId = options.orgId ?? info.body.orgs.find((o: any) => o.current).id
  const approved = await answer(browser, { request: info.request, csrf: info.body.csrf, decision: "approve", orgId, access: options.access ?? "write" })
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  const code = new URL(approved.body.redirect).searchParams.get("code")!
  const tokens = await form("/api/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: "http://127.0.0.1:54321/callback", client_id: client.body.client_id, resource: `${app.base}/mcp` })
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body))
  return { clientId: client.body.client_id as string, tokens: tokens.body, info: info.body }
}

describe("remote MCP sign-in (OAuth)", () => {
  test("discovery → registration → consent → token → MCP → refresh → revoke → 401", async () => {
    // A client tries /mcp with nothing: 401, and where to find out how to sign in.
    const bare = await fetch(`${app.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })
    assert.equal(bare.status, 401)
    const challenge = bare.headers.get("www-authenticate")!
    assert.match(challenge, /^Bearer resource_metadata="/)
    assert.doesNotMatch(challenge, /invalid_token/, "no token sent, so no token error")
    const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)![1]!
    const prm = await (await fetch(prmUrl)).json()
    assert.equal(prm.resource, `${app.base}/mcp`)
    assert.deepEqual(prm.authorization_servers, [app.base])
    const meta = await (await fetch(`${app.base}/.well-known/oauth-authorization-server`)).json()
    assert.equal(meta.issuer, app.base)
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"])
    assert.equal(meta.client_id_metadata_document_supported, true)
    assert.equal(meta.registration_endpoint, `${app.base}/api/oauth/register`)
    assert.equal((await fetch(`${app.base}/.well-known/oauth-protected-resource`)).status, 200)

    // Registration.
    const client = await register()
    assert.equal(client.status, 201)
    assert.match(client.body.client_id, /^cl_/)
    assert.equal(client.body.client_secret, undefined, "a public client gets no secret")

    // Signed out: authorize goes through sign-in and comes back to the consent page.
    const browser = new Visitor(app, "ada@example.test")
    app.fake.user("ada@example.test", "Ada", "Lovelace")
    const { verifier, challenge: codeChallenge } = pkce()
    const toLogin = await startConsent(browser, client.body.client_id, { challenge: codeChallenge })
    assert.match(toLogin, /^\/api\/auth\/login\?return_to=%2Fauthorize%3Frequest%3Dreq_/)
    const landed = await browser.signIn({ returnTo: decodeURIComponent(toLogin.split("return_to=")[1]!) })
    assert.match(landed, /^\/authorize\?request=req_/)
    await browser.session()

    // The consent page's data.
    const info = await consentInfo(browser, landed)
    assert.equal(info.status, 200, JSON.stringify(info.body))
    assert.equal(info.body.client.name, "Claude Code (standard-artifacts)")
    assert.equal(info.body.client.agentName, "Claude Code")
    assert.equal(info.body.client.redirectKind, "loopback")
    assert.equal(info.body.client.warning, null)
    assert.equal(info.body.user.name, "Ada Lovelace")
    assert.equal(info.body.orgs.length, 1)
    assert.equal(info.body.orgs[0].maxAccess, "write")

    // Approve: back to the client's loopback redirect, with the code, its state and the issuer.
    const approved = await answer(browser, { request: info.request, csrf: info.body.csrf, decision: "approve", orgId: info.body.orgs[0].id, access: "write" })
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    assert.equal(approved.body.approved, true)
    assert.equal(approved.body.clientName, "Claude Code")
    const back = new URL(approved.body.redirect)
    assert.equal(back.origin + back.pathname, "http://127.0.0.1:54321/callback")
    assert.equal(back.searchParams.get("state"), "st-123")
    assert.equal(back.searchParams.get("iss"), app.base)
    const code = back.searchParams.get("code")!
    assert.match(code, /^sac_/)
    // The request is answered: it can't be approved twice.
    assert.equal((await answer(browser, { request: info.request, csrf: info.body.csrf, decision: "approve", orgId: info.body.orgs[0].id })).status, 410)

    // A wrong verifier burns the code.
    const tokenParams = { grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:54321/callback", client_id: client.body.client_id, resource: `${app.base}/mcp` }
    const tokens = await form("/api/oauth/token", { ...tokenParams, code_verifier: verifier })
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body))
    assert.equal(tokens.headers.get("cache-control"), "no-store")
    assert.equal(tokens.body.token_type, "Bearer")
    assert.equal(tokens.body.expires_in, 3600)
    assert.match(tokens.body.access_token, /^sao_/)
    assert.match(tokens.body.refresh_token, /^sar_/)

    // MCP with the access token: the tools, acting as Claude Code for Ada.
    const session = await mcp(tokens.body.access_token)
    assert.equal(session.init.status, 200, JSON.stringify(session.init.body))
    const tools = (await session.request("tools/list")).body!.result.tools
    assert.ok(tools.some((t: any) => t.name === "create_artifact"))
    const created = await session.callTool("create_artifact", { kind: "doc", title: "Written by an agent" })
    assert.equal(created.isError, false, JSON.stringify(created))
    const docs = (await browser.api("GET", "/workspace")).body.artifacts.filter((a: any) => a.title === "Written by an agent")
    assert.equal(docs.length, 1)
    assert.match(docs[0].createdBy, /^agt_claude-code:usr_/, "the write is the agent's, for Ada")
    // Once it has looked around, it shows up among the workspace's agents, for Ada.
    assert.equal((await session.callTool("list_artifacts", {})).isError, false)
    const agents = (await browser.api("GET", "/members")).body.agents
    assert.ok(agents.some((a: any) => a.name === "Claude Code" && a.onBehalfOfName === "Ada Lovelace"), JSON.stringify(agents))

    // whoami.
    const who = await (await fetch(`${app.base}/mcp/whoami`, { headers: { authorization: `Bearer ${tokens.body.access_token}` } })).json()
    assert.equal(who.person.name, "Ada Lovelace")
    assert.equal(who.organization.name, "Ada's workspace")
    assert.equal(who.access, "write")
    assert.equal(who.role, "editor", "an owner's agent edits, never above editor")
    assert.equal(who.client.agentName, "Claude Code")
    assert.equal(who.via, "oauth")

    // The token is for /mcp only.
    const api = await fetch(`${app.base}/api/v1/workspace`, { headers: { authorization: `Bearer ${tokens.body.access_token}` } })
    assert.equal(api.status, 401)

    // Refresh rotates.
    const refreshed = await form("/api/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.body.refresh_token, client_id: client.body.client_id })
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
    assert.notEqual(refreshed.body.refresh_token, tokens.body.refresh_token)
    assert.equal((await mcp(refreshed.body.access_token)).init.status, 200)

    // Settings → Connections shows it.
    const listed = await browser.api("GET", "/connections")
    assert.equal(listed.status, 200, JSON.stringify(listed.body))
    assert.equal(listed.body.mcpUrl, `${app.base}/mcp`)
    assert.equal(listed.body.oauth, true)
    assert.equal(listed.body.agents.length, 1)
    assert.equal(listed.body.agents[0].agentName, "Claude Code")
    assert.equal(listed.body.agents[0].redirectHost, "this computer")
    assert.equal(listed.body.agents[0].connectedBy.name, "Ada Lovelace")
    assert.ok(listed.body.agents[0].lastUsedAt)

    // Revoke (RFC 7009), then /mcp says to sign in again.
    const revoked = await form("/api/oauth/revoke", { token: refreshed.body.refresh_token, client_id: client.body.client_id })
    assert.equal(revoked.status, 200)
    const after = await mcp(refreshed.body.access_token)
    assert.equal(after.init.status, 401)
    assert.match(after.init.headers.get("www-authenticate")!, /resource_metadata=".*", error="invalid_token"/)
    assert.equal((await browser.api("GET", "/connections")).body.agents.length, 0)
  })

  test("a code works once, with its verifier, its client and its redirect", async () => {
    const browser = await signedIn("once@example.test", "Una")
    const client = await register()
    const other = await register()
    const { verifier, challenge } = pkce()
    const info = await consentInfo(browser, await startConsent(browser, client.body.client_id, { challenge }))
    const approved = await answer(browser, { request: info.request, csrf: info.body.csrf, decision: "approve", orgId: info.body.orgs[0].id })
    const code = new URL(approved.body.redirect).searchParams.get("code")!
    const base = { grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:54321/callback" }
    const wrongClient = await form("/api/oauth/token", { ...base, client_id: other.body.client_id, code_verifier: verifier })
    assert.equal(wrongClient.status, 400)
    assert.equal(wrongClient.body.error, "invalid_grant")
    // That spent the code: a second try, even a right one, is a replay.
    const replay = await form("/api/oauth/token", { ...base, client_id: client.body.client_id, code_verifier: verifier })
    assert.equal(replay.body.error, "invalid_grant")
    assert.match(replay.body.error_description, /already used/)

    const second = pkce()
    const info2 = await consentInfo(browser, await startConsent(browser, client.body.client_id, { challenge: second.challenge }))
    const code2 = new URL((await answer(browser, { request: info2.request, csrf: info2.body.csrf, decision: "approve", orgId: info2.body.orgs[0].id })).body.redirect).searchParams.get("code")!
    const badVerifier = await form("/api/oauth/token", { ...base, code: code2, client_id: client.body.client_id, code_verifier: verifier })
    assert.equal(badVerifier.body.error, "invalid_grant")
    assert.match(badVerifier.body.error_description, /code_verifier/)
  })

  test("refresh token reuse ends the grant", async () => {
    const browser = await signedIn("reuse@example.test", "Rue")
    const { clientId, tokens } = await connect(browser)
    const first = await form("/api/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId })
    assert.equal(first.status, 200)
    // A retry moments later (the client never got the answer) is allowed once…
    const retry = await form("/api/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId })
    assert.equal(retry.status, 200)
    // …but the pair it replaced is now spent: presenting it means someone else has it.
    const stolen = await form("/api/oauth/token", { grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: clientId })
    assert.equal(stolen.body.error, "invalid_grant")
    assert.match(stolen.body.error_description, /already used/)
    assert.equal((await mcp(retry.body.access_token)).init.status, 401, "the whole grant ended")
  })

  test("deny goes back to the client with access_denied; errors before the redirect is checked never redirect", async () => {
    const browser = await signedIn("deny@example.test", "Dee")
    const client = await register()
    const info = await consentInfo(browser, await startConsent(browser, client.body.client_id, { challenge: pkce().challenge, state: "s1" }))
    const denied = await answer(browser, { request: info.request, csrf: info.body.csrf, decision: "deny" })
    assert.equal(denied.status, 200)
    const back = new URL(denied.body.redirect)
    assert.equal(back.searchParams.get("error"), "access_denied")
    assert.equal(back.searchParams.get("state"), "s1")

    // An unknown client or a redirect it didn't register: the consent page explains, nothing goes to the redirect.
    assert.equal(await startConsent(browser, "cl_nobodynobodynobodynobo", { challenge: pkce().challenge }), "/authorize?error=unknown-client")
    assert.equal(await startConsent(browser, client.body.client_id, { challenge: pkce().challenge, redirectUri: "https://evil.test/cb" }), "/authorize?error=redirect-mismatch")
    // Once the redirect checks out, protocol errors go back to it.
    const noPkce = await browser.fetch(`/api/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.body.client_id, redirect_uri: "http://127.0.0.1:9/callback", state: "s2" })}`)
    const err = new URL(noPkce.headers.get("location")!)
    assert.equal(err.origin, "http://127.0.0.1:9")
    assert.equal(err.searchParams.get("error"), "invalid_request")
    assert.equal(err.searchParams.get("state"), "s2")
    const wrongResource = await startConsent(browser, client.body.client_id, { challenge: pkce().challenge, extra: { resource: `${app.base}/api/v1` } })
    assert.equal(new URL(wrongResource).searchParams.get("error"), "invalid_target")

    // An expired or made-up request, and a stranger's CSRF token, are refused in words.
    const gone = await browser.fetch("/api/oauth/consent?request=req_aaaaaaaaaaaaaaaaaaaaaaaa")
    assert.equal(gone.status, 410)
    assert.equal((await gone.json()).reason, "expired")
    const info2 = await consentInfo(browser, await startConsent(browser, client.body.client_id, { challenge: pkce().challenge }))
    const forged = await answer(browser, { request: info2.request, csrf: "x".repeat(43), decision: "approve", orgId: info2.body.orgs[0].id })
    assert.equal(forged.status, 403)
    const crossSite = await browser.fetch("/api/oauth/consent", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: JSON.stringify({ request: info2.request, csrf: info2.body.csrf, decision: "approve" }) })
    assert.equal(crossSite.status, 403)
    const signedOut = await new Visitor(app, "nobody@example.test").fetch(`/api/oauth/consent?request=${info2.request}`)
    assert.equal(signedOut.status, 401)
    assert.equal((await signedOut.json()).reason, "signed-out")
  })

  test("choosing another org binds the grant there (and switches the browser to it)", async () => {
    const owner = await signedIn("orgs-owner@example.test", "Oona")
    const team = (await owner.session()).body.org
    const mia = await signedIn("orgs-mia@example.test", "Mia")
    const own = (await mia.session()).body.org
    app.fake.member([...app.fake.users.values()].find((u) => u.email === "orgs-mia@example.test")!.id, team.id, "editor")
    const { tokens, info } = await connect(mia, { orgId: team.id })
    assert.deepEqual(info.orgs.map((o: any) => o.name).sort(), [own.name, team.name].sort(), "only her orgs")
    const who = await (await fetch(`${app.base}/mcp/whoami`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()
    assert.equal(who.organization.id, team.id)
    assert.equal(who.access, "write")
    assert.equal((await mia.session()).body.org.id, team.id)
    // The owner sees Mia's agent in the team's Connections.
    const listed = (await owner.api("GET", "/connections")).body
    assert.equal(listed.everyone, true)
    assert.ok(listed.agents.some((a: any) => a.connectedBy.name === "Mia"))
  })

  test("a read-only grant reads but can't write; a viewer can only grant read", async () => {
    const browser = await signedIn("ro@example.test", "Rho")
    const doc = await browser.api("POST", "/artifacts", { kind: "doc", title: "Read me" })
    const { tokens } = await connect(browser, { access: "read" })
    const session = await mcp(tokens.access_token)
    const read = await session.callTool("read_artifact", { artifact: doc.body.id })
    assert.equal(read.isError, false)
    const write = await session.callTool("create_artifact", { kind: "doc", title: "Nope" })
    assert.equal(write.isError, true)
    const who = await (await fetch(`${app.base}/mcp/whoami`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()
    assert.equal(who.access, "read")
    assert.equal(who.role, "viewer")

    // A viewer in an org: read only is the most they can give, and asking for more is refused.
    const orgId = (await browser.session()).body.org.id
    const viewer = await signedIn("ro-viewer@example.test", "Vi")
    app.fake.member([...app.fake.users.values()].find((u) => u.email === "ro-viewer@example.test")!.id, orgId, "viewer")
    const client = await register()
    const info = await consentInfo(viewer, await startConsent(viewer, client.body.client_id, { challenge: pkce().challenge }))
    const there = info.body.orgs.find((o: any) => o.id === orgId)
    assert.equal(there.maxAccess, "read")
    assert.match(there.limit, /Viewer/)
    const refused = await answer(viewer, { request: info.request, csrf: info.body.csrf, decision: "approve", orgId, access: "write" })
    assert.equal(refused.status, 403)
  })

  test("losing membership answers 403 with a reason; disconnecting answers 401", async () => {
    const owner = await signedIn("lose-owner@example.test", "Lo")
    const orgId = (await owner.session()).body.org.id
    const bo = await signedIn("lose-bo@example.test", "Bo")
    const boUser = [...app.fake.users.values()].find((u) => u.email === "lose-bo@example.test")!
    app.fake.member(boUser.id, orgId, "editor")
    const { tokens } = await connect(bo, { orgId })
    assert.equal((await mcp(tokens.access_token)).init.status, 200)

    const members = (await owner.api("GET", "/org/members")).body.members
    const membership = members.find((m: any) => m.email === "lose-bo@example.test")
    assert.equal((await owner.api("DELETE", `/org/members/${membership.id}`)).status, 204)
    const lost = await mcp(tokens.access_token)
    assert.equal(lost.init.status, 403)
    assert.match(lost.init.body!.error!.message, /isn't a member of .* anymore/)
    assert.equal(lost.init.headers.get("www-authenticate"), null, "signing in again wouldn't help, so no challenge")
    const listed = (await owner.api("GET", "/connections")).body.agents
    assert.equal(listed.find((a: any) => a.connectedBy.name === "Bo")?.member, false)

    // The owner disconnects it: now it's a 401, so the client knows to sign in again.
    const id = listed.find((a: any) => a.connectedBy.name === "Bo").id
    assert.equal((await owner.api("DELETE", `/connections/${id}`)).status, 204)
    assert.equal((await mcp(tokens.access_token)).init.status, 401)
  })

  test("people disconnect their own agents; an agent's token can't list or disconnect", async () => {
    const browser = await signedIn("own@example.test", "Owen")
    const { tokens } = await connect(browser)
    const id = (await browser.api("GET", "/connections")).body.agents[0].id
    const viaToken = await fetch(`${app.base}/api/v1/connections`, { headers: { authorization: `Bearer ${tokens.access_token}` } })
    assert.equal(viaToken.status, 401)
    assert.equal((await browser.api("DELETE", `/connections/${id}`)).status, 204)
    assert.equal((await mcp(tokens.access_token)).init.status, 401)
    assert.equal((await browser.api("DELETE", `/connections/${id}`)).status, 404)
  })

  test("access tokens from Settings keep working at /mcp", async () => {
    const browser = await signedIn("pat@example.test", "Pat")
    const token = (await browser.createToken("Claude Code")).body.token
    const session = await mcp(token)
    assert.equal(session.init.status, 200)
    const who = await (await fetch(`${app.base}/mcp/whoami`, { headers: { authorization: `Bearer ${token}` } })).json()
    assert.equal(who.via, "access-token")
    assert.equal(who.person.name, "Pat")
  })

  test("confidential clients authenticate; registration is validated and rate limited", async () => {
    const secretClient = await register({ token_endpoint_auth_method: "client_secret_basic" })
    assert.equal(secretClient.status, 201)
    assert.match(secretClient.body.client_secret, /^scs_/)
    const browser = await signedIn("conf@example.test", "Cy")
    const { verifier, challenge } = pkce()
    const info = await consentInfo(browser, await startConsent(browser, secretClient.body.client_id, { challenge }))
    const code = new URL((await answer(browser, { request: info.request, csrf: info.body.csrf, decision: "approve", orgId: info.body.orgs[0].id })).body.redirect).searchParams.get("code")!
    const params = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: "http://127.0.0.1:54321/callback" }
    const noSecret = await form("/api/oauth/token", { ...params, client_id: secretClient.body.client_id })
    assert.equal(noSecret.status, 401)
    assert.equal(noSecret.body.error, "invalid_client")
    const basic = `Basic ${btoa(`${secretClient.body.client_id}:${secretClient.body.client_secret}`)}`
    // The failed try didn't spend the code: client authentication comes first.
    const ok = await form("/api/oauth/token", params, { authorization: basic })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))

    assert.equal((await register({ redirect_uris: ["http://evil.test/cb"] })).body.error, "invalid_redirect_uri")
    assert.equal((await register({ redirect_uris: ["javascript:alert(1)"] })).status, 400)
    let limited = false
    for (let i = 0; i < 70 && !limited; i++) limited = (await register()).status === 429
    assert.ok(limited, "registration is rate limited")
  })
})
