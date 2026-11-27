import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { startLive, Visitor, type LiveApp } from "./live-harness.ts"

/**
 * Interop with the official MCP TypeScript SDK's OAuth client, the one many
 * hosts build on: it finds the authorization server from /mcp's 401,
 * registers itself, sends the person to the consent page with PKCE and a
 * `resource`, trades the code, and refreshes on its own when the access token
 * stops working. The browser half is a signed-in Visitor approving on the
 * consent page's endpoints, as the page does.
 */

let app: LiveApp
before(async () => {
  app = await startLive()
})
after(async () => {
  await app?.close()
})

const REDIRECT = "http://127.0.0.1:47123/callback"

/** An OAuthClientProvider that keeps everything in memory and remembers where it was asked to send the browser. */
class MemoryProvider implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined
  stored: OAuthTokens | undefined
  verifier = ""
  authorizationUrl: URL | undefined
  refreshes = 0

  get redirectUrl() {
    return REDIRECT
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Claude Code (sdk-test)",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }
  clientInformation() {
    return this.client
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.client = info
  }
  tokens() {
    return this.stored
  }
  saveTokens(tokens: OAuthTokens) {
    if (this.stored) this.refreshes++
    this.stored = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }
  /** The SDK calls this when the server refuses what it holds (invalid_grant: drop the tokens and sign in again). */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.stored = undefined
    if (scope === "all" || scope === "client") this.client = undefined
  }
}

async function signedIn(email: string, first: string) {
  app.fake.user(email, first)
  const v = new Visitor(app, email)
  await v.signIn()
  await v.session()
  return v
}

/** The browser half: the SDK's authorization URL → the consent page's data → approve. Returns the code. */
async function approve(browser: Visitor, authorizationUrl: URL) {
  const toConsent = await browser.fetch(authorizationUrl.toString())
  assert.equal(toConsent.status, 302)
  const location = toConsent.headers.get("location")!
  const request = new URL(location, app.base).searchParams.get("request")
  assert.ok(request, `the consent page, not ${location}`)
  const info = await browser.fetch(`/api/oauth/consent?request=${request}`)
  assert.equal(info.status, 200)
  const body = (await info.json()) as any
  assert.equal(body.client.agentName, "Claude Code")
  const answered = await browser.fetch("/api/oauth/consent", {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.base },
    body: JSON.stringify({ request, csrf: body.csrf, decision: "approve", orgId: body.orgs[0].id, access: "write" }),
  })
  assert.equal(answered.status, 200)
  const back = new URL(((await answered.json()) as any).redirect)
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT)
  assert.equal(back.searchParams.get("iss"), app.base)
  return back.searchParams.get("code")!
}

const connect = async (provider: MemoryProvider) => {
  const client = new Client({ name: "claude-code", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), { authProvider: provider })
  await client.connect(transport)
  return { client, transport }
}

describe("the MCP TypeScript SDK's OAuth client", () => {
  test("discovers, registers, signs in through the consent page, calls tools, and refreshes on its own", async () => {
    const provider = new MemoryProvider()
    const browser = await signedIn("sdk@example.test", "Sid")

    // First connect: 401 → discovery → registration → the authorization URL, then UnauthorizedError.
    const transport = new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), { authProvider: provider })
    await assert.rejects(new Client({ name: "claude-code", version: "1.0.0" }).connect(transport), UnauthorizedError)
    assert.match(provider.client?.client_id ?? "", /^cl_/, "it registered")
    const url = provider.authorizationUrl!
    assert.ok(url, "it asked to send the person to sign in")
    assert.equal(`${url.origin}${url.pathname}`, `${app.base}/api/oauth/authorize`)
    assert.equal(url.searchParams.get("code_challenge_method"), "S256")
    assert.equal(url.searchParams.get("resource"), `${app.base}/mcp`)
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT)

    // The person approves; the client trades the code.
    await transport.finishAuth(await approve(browser, url))
    assert.match(provider.stored?.access_token ?? "", /^sao_/)
    assert.match(provider.stored?.refresh_token ?? "", /^sar_/)

    const { client } = await connect(provider)
    const { tools } = await client.listTools()
    assert.ok(tools.some((t) => t.name === "create_artifact"))
    const created = await client.callTool({ name: "create_artifact", arguments: { kind: "doc", title: "From the SDK" } })
    assert.equal(created.isError, false, JSON.stringify(created))
    const docs = (await browser.api("GET", "/workspace")).body.artifacts.filter((a: any) => a.title === "From the SDK")
    assert.equal(docs.length, 1)
    assert.match(docs[0].createdBy, /^agt_claude-code:usr_/)
    await client.close()

    // The access token stops working (here: replaced by one the server never issued). The SDK refreshes and carries on.
    const refreshToken = provider.stored!.refresh_token
    provider.stored = { ...provider.stored!, access_token: `sao_${"0".repeat(8)}_${"A".repeat(32)}` }
    provider.refreshes = 0
    const again = await connect(provider)
    assert.equal(provider.refreshes, 1, "it refreshed")
    assert.notEqual(provider.stored!.refresh_token, refreshToken, "the refresh token rotated")
    assert.ok((await again.client.listTools()).tools.length > 0)
    await again.client.close()

    // Disconnected in Settings: the SDK's refresh fails, so it asks for sign-in again.
    const listed = (await browser.api("GET", "/connections")).body.agents
    assert.equal(listed.length, 1)
    assert.equal((await browser.api("DELETE", `/connections/${listed[0].id}`)).status, 204)
    provider.authorizationUrl = undefined
    provider.stored = { ...provider.stored!, access_token: `sao_${"0".repeat(8)}_${"B".repeat(32)}` }
    await assert.rejects(connect(provider), UnauthorizedError)
    assert.ok(provider.authorizationUrl, "it starts a new sign-in")
  })
})
