import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { launch } from "./harness.ts"
import { startLive, type LiveApp } from "./live-harness.ts"

/**
 * Connecting an agent in a real browser, against the Worker in live mode and
 * a fake WorkOS: the consent page (signed in or not, org and access choices,
 * approve and deny, warnings and errors) and Settings → Connections (the URL,
 * per-app steps, the connected agents list and Disconnect). It runs the
 * production web build, as Cloud does.
 *
 * STDARTIFACTS_SCREENSHOTS=<dir> saves screenshots of each screen there.
 */

let app: LiveApp
let browser: Browser
before(async () => {
  app = await startLive()
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await app?.close()
})

const shots = process.env.STDARTIFACTS_SCREENSHOTS
if (shots) mkdirSync(shots, { recursive: true })
const shot = async (p: Page, name: string) => {
  if (shots) await p.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
}

const CALLBACK = "http://127.0.0.1:54321/callback"

/** A tall window: everything on the consent page is in view, and clicks near the bottom land. */
async function page(options: { dark?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 }, colorScheme: options.dark ? "dark" : "light" })
  const p = await ctx.newPage()
  const errors: Array<string> = []
  p.on("pageerror", (e) => errors.push(e.message))
  // Stand in for the client's loopback listener (Claude Code, Codex…): note where the browser was sent.
  const callbacks: Array<URL> = []
  await ctx.route(`${CALLBACK}**`, (route) => {
    callbacks.push(new URL(route.request().url()))
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>Claude Code</title><p>Authentication complete. You can close this window.</p>" })
  })
  return { page: p, errors, callbacks }
}

async function signIn(p: Page, email: string) {
  await p.goto(app.base)
  await p.getByRole("heading", { name: "Sign in to Standard Artifacts" }).waitFor()
  await p.getByRole("button", { name: "Continue" }).click()
  await p.getByLabel("Email").fill(email)
  await p.getByRole("button", { name: "Continue" }).click()
  await p.getByRole("button", { name: "Account" }).waitFor({ timeout: 15000 })
}

async function register(body: object = {}) {
  const res = await fetch(`${app.base}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code (standard-artifacts)", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none", ...body }),
  })
  return (await res.json()) as { client_id: string }
}

function authorizeUrl(clientId: string, redirectUri = CALLBACK) {
  const verifier = randomBytes(32).toString("base64url")
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "ui-state",
    resource: `${app.base}/mcp`,
  })
  return { url: `${app.base}/api/oauth/authorize?${q}`, verifier }
}

describe("connecting an agent (browser)", () => {
  test("signed out: sign in, see the consent page, approve, land back at the app with a code that works", async () => {
    app.fake.user("cara@example.test", "Cara", "Diaz")
    const { page: p, errors, callbacks } = await page()
    const client = await register()
    const { url, verifier } = authorizeUrl(client.client_id)

    // Signed out, the authorize link goes through the (fake) AuthKit first.
    await p.goto(url)
    await p.getByLabel("Email").fill("cara@example.test")
    await p.getByRole("button", { name: "Continue" }).click()
    await p.waitForURL(/\/authorize\?request=req_/)
    await p.getByRole("heading", { name: "Connect Claude Code to Standard Artifacts" }).waitFor({ timeout: 15000 })
    assert.equal(await p.title(), "Connect an agent · Standard Artifacts")
    await p.getByText("Returns to an app on this computer").waitFor()
    await p.getByText("Signed in as Cara Diaz").waitFor()
    await p.getByText("cara@example.test").waitFor()
    assert.equal(await p.getByRole("radio", { name: /Cara's workspace/ }).isChecked(), true)
    assert.equal(await p.getByRole("radio", { name: /Read and write/ }).isChecked(), true)
    await p.getByText("Edits like an Editor; never manages the workspace").waitFor()
    assert.equal(await p.getByRole("alert").count(), 0, "a loopback client on this computer needs no warning")
    await shot(p, "consent")

    await p.getByRole("button", { name: "Approve" }).click()
    await p.getByRole("heading", { name: "Connected" }).waitFor()
    await p.getByText("You can return to Claude Code.").waitFor()
    await shot(p, "consent-connected")
    await p.waitForURL(`${CALLBACK}**`)
    const back = callbacks.at(-1)!
    assert.equal(back.searchParams.get("state"), "ui-state")
    assert.equal(back.searchParams.get("iss"), app.base)

    const tokens = await fetch(`${app.base}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, redirect_uri: CALLBACK, client_id: client.client_id }),
    })
    assert.equal(tokens.status, 200)
    assert.deepEqual(errors, [])
  })

  test("read only, deny, and an app that isn't who it says it is", async () => {
    app.fake.user("rae@example.test", "Rae")
    const { page: p, errors, callbacks } = await page()
    await signIn(p, "rae@example.test")

    // Read only.
    const client = await register({ client_name: "Codex" })
    await p.goto(authorizeUrl(client.client_id).url)
    await p.getByRole("heading", { name: "Connect Codex to Standard Artifacts" }).waitFor({ timeout: 15000 })
    await p.getByRole("radio", { name: /Read only/ }).check({ force: true })
    await p.getByText(/Codex will act for you in the workspace you pick: reading boards/).waitFor()
    await p.getByRole("button", { name: "Approve" }).click()
    await p.waitForURL(`${CALLBACK}**`)
    assert.ok(callbacks.at(-1)!.searchParams.get("code"))

    // Deny.
    await p.goto(authorizeUrl(client.client_id).url)
    await p.getByRole("button", { name: "Deny" }).click()
    await p.getByRole("heading", { name: "Not connected" }).waitFor()
    await p.waitForURL(`${CALLBACK}**`)
    assert.equal(callbacks.at(-1)!.searchParams.get("error"), "access_denied")

    // An app that calls itself Claude but would send you elsewhere.
    const impostor = await register({ client_name: "Claude", redirect_uris: ["https://claude-ai.evil.test/oauth/callback"] })
    await p.goto(authorizeUrl(impostor.client_id, "https://claude-ai.evil.test/oauth/callback").url)
    await p.getByRole("heading", { name: "Connect Claude to Standard Artifacts" }).waitFor({ timeout: 15000 })
    const warning = p.getByRole("alert")
    await warning.getByText(/calls itself Claude, but it would send you to claude-ai\.evil\.test/).waitFor()
    await p.getByText("Returns to claude-ai.evil.test").waitFor()
    await shot(p, "consent-warning")
    assert.deepEqual(errors, [])
  })

  test("problems read as sentences, not JSON", async () => {
    app.fake.user("err@example.test", "Erin")
    const { page: p, errors } = await page()
    await signIn(p, "err@example.test")
    await p.goto(`${app.base}/api/oauth/authorize?client_id=cl_nobodynobodynobodynobo&response_type=code`)
    await p.getByRole("heading", { name: "We don't recognize this app" }).waitFor({ timeout: 15000 })
    await shot(p, "consent-unknown-client")
    await p.goto(`${app.base}/authorize?request=req_aaaaaaaaaaaaaaaaaaaaaaaa`)
    await p.getByRole("heading", { name: "This request expired" }).waitFor({ timeout: 15000 })
    await shot(p, "consent-expired")
    const client = await register()
    await p.goto(authorizeUrl(client.client_id, "https://evil.test/cb").url)
    await p.getByRole("heading", { name: "This app's return address doesn't match" }).waitFor({ timeout: 15000 })
    assert.deepEqual(errors, [])
  })

  test("the consent page won't work inside someone else's frame", async () => {
    app.fake.user("frame@example.test", "Fay")
    const { page: p } = await page()
    await signIn(p, "frame@example.test")
    const client = await register()
    await p.goto(authorizeUrl(client.client_id).url)
    await p.waitForURL(/\/authorize\?request=req_/)
    const consent = p.url()
    await p.setContent(`<iframe src="${consent}" style="width:900px;height:900px"></iframe>`)
    const frame = p.frameLocator("iframe")
    await frame.getByRole("heading", { name: "Open this in its own window" }).waitFor({ timeout: 15000 })
    assert.equal(await frame.getByRole("button", { name: "Approve" }).count(), 0)
  })

  test("Settings → Connections: the URL, steps per app, connected agents, disconnect", async () => {
    app.fake.user("seth@example.test", "Seth")
    const { page: p, errors, callbacks } = await page()
    await signIn(p, "seth@example.test")
    // Connect one agent first: approve, and the client trades the code for tokens (that makes the grant).
    const client = await register({ client_name: "Claude Code (standard-artifacts)" })
    const { url, verifier } = authorizeUrl(client.client_id)
    await p.goto(url)
    await p.getByRole("button", { name: "Approve" }).click()
    await p.waitForURL(`${CALLBACK}**`)
    const tokens = await fetch(`${app.base}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: callbacks.at(-1)!.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id }),
    })
    assert.equal(tokens.status, 200)

    await p.goto(`${app.base}/settings/connections`)
    const main = p.locator("main")
    await main.getByRole("heading", { name: "Connections" }).waitFor({ timeout: 15000 })
    assert.equal(await main.getByRole("textbox", { name: "MCP server URL" }).inputValue(), `${app.base}/mcp`)

    // Each app's steps, with the URL filled in.
    const tabs = main.getByRole("tablist", { name: "Apps" })
    await main.getByText("Add custom connector").waitFor()
    await tabs.getByRole("tab", { name: "Claude Code" }).click()
    await main.getByText(`claude mcp add --transport http --scope user standard-artifacts ${app.base}/mcp`).waitFor()
    await tabs.getByRole("tab", { name: "Codex" }).click()
    await main.getByText(`codex mcp add standard-artifacts --url ${app.base}/mcp`).waitFor()
    await main.getByText("codex mcp login standard-artifacts").waitFor()
    await tabs.getByRole("tab", { name: "ChatGPT" }).click()
    await main.getByText("Developer mode").waitFor()
    await tabs.getByRole("tab", { name: "Cursor" }).click()
    const cursor = await main.getByRole("link", { name: "Add to Cursor" }).getAttribute("href")
    assert.match(cursor!, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=standard-artifacts&config=/)
    assert.deepEqual(JSON.parse(Buffer.from(new URL(cursor!).searchParams.get("config")!, "base64").toString()), { url: `${app.base}/mcp` })
    await tabs.getByRole("tab", { name: "VS Code" }).click()
    assert.match((await main.getByRole("link", { name: "Add to VS Code" }).getAttribute("href"))!, /^vscode:mcp\/install\?/)
    await tabs.getByRole("tab", { name: "Other" }).click()
    await main.getByRole("link", { name: "access token", exact: true }).waitFor()
    // Arrow keys move between tabs.
    await tabs.getByRole("tab", { name: "Other" }).press("ArrowLeft")
    assert.equal(await tabs.getByRole("tab", { name: "VS Code" }).getAttribute("aria-selected"), "true")
    await tabs.getByRole("tab", { name: "VS Code" }).press("ArrowRight")
    await tabs.getByRole("tab", { name: "Claude Code" }).click()

    // The connected agent.
    const list = main.getByRole("list", { name: "Connected agents" })
    const row = list.getByRole("listitem").filter({ hasText: "Claude Code" })
    await row.getByText(/Read and write · (used just now|not used yet) · connected just now · from this computer/).waitFor()
    await shot(p, "connections")
    await row.getByRole("button", { name: "Disconnect Claude Code" }).click()
    await row.getByRole("button", { name: "Disconnect", exact: true }).click()
    await main.getByText("No agents yet.").waitFor()
    await shot(p, "connections-empty")
    assert.deepEqual(errors, [])
  })

  test("dark theme and phone width", async () => {
    app.fake.user("dana@example.test", "Dana")
    const { page: p, errors } = await page({ dark: true })
    await signIn(p, "dana@example.test")
    const client = await register({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] })
    await p.goto(authorizeUrl(client.client_id, "https://chatgpt.com/connector_platform_oauth_redirect").url)
    await p.getByRole("heading", { name: "Connect ChatGPT to Standard Artifacts" }).waitFor({ timeout: 15000 })
    await p.getByLabel("Verified").waitFor()
    await shot(p, "consent-dark")
    await p.setViewportSize({ width: 390, height: 1100 })
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.equal(overflow, 0)
    await shot(p, "consent-phone")
    await p.goto(`${app.base}/settings/connections`)
    await p.locator("main").getByRole("heading", { name: "Connections" }).waitFor({ timeout: 15000 })
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0)
    await shot(p, "connections-phone")
    assert.deepEqual(errors, [])
  })
})
