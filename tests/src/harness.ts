import { chromium, type Browser, type Locator, type Page } from "playwright-core"

/**
 * Shared helpers for the end-to-end suites. Tests talk to a running app
 * (STDARTIFACTS_URL, default http://localhost:5173); `scripts/test.sh` starts one if needed.
 * Every artifact a test creates is titled "e2e …" and deleted afterwards.
 */

export const BASE = process.env.STDARTIFACTS_URL ?? "http://localhost:5173"
export const API = `${BASE}/api/v1`

/**
 * Whether a browser can act as a guest, viewer or agent. The API takes `x-dev-as` from any dev-mode
 * server, but only a Vite dev build of the UI sends it (`import.meta.env.DEV`). `stdartifacts serve`
 * ships the production build, so there a page opened "as guest" is still the owner.
 */
export const canViewAs = await fetch(BASE).then(
  async (r) => (await r.text()).includes("/@vite/client"),
  () => true, // Nothing answering: let the tests fail on that, not skip.
)

/** For tests that open a page as someone other than the owner: `test(name, viewAsOnly, fn)`. */
export const viewAsOnly = { skip: canViewAs ? false : "this UI is a production build, which can't view as guest, viewer or agent" }

export type As = "owner" | "guest" | "viewer" | "agent"

export async function call<T = any>(method: string, path: string, body?: unknown, as?: As): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as && as !== "owner" ? { "x-dev-as": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** The dev owner's display name: "JC" under Alchemy dev, the OS account's name (or --name) under `stdartifacts serve`. */
export const ownerName = async () => (await call("GET", "/workspace")).body.principal.actor.name as string

export const content = async (id: string) => (await call("GET", `/artifacts/${id}/content`)).body
export const ops = (id: string, list: Array<unknown>, as: As = "agent") => call("POST", `/artifacts/${id}/ops`, { ops: list }, as)
export const presence = (id: string, runId: string, value: Record<string, unknown>, ttl = 30) =>
  call("POST", `/artifacts/${id}/presence`, { runId, presence: value, ttl }, "agent")

const created: Array<string> = []

export async function create(kind: "table" | "board" | "doc" | "tracker", title: string) {
  const r = await call("POST", "/artifacts", { kind, title: `e2e ${title}` })
  if (r.status !== 201 && r.status !== 200) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`)
  created.push(r.body.id)
  return r.body as { id: string; kind: string; title: string }
}

const createdFolders: Array<string> = []

/** A folder that's deleted afterwards. Name it uniquely: the workspace is shared. */
export async function createFolder(name: string, parentId?: string) {
  const r = await call("POST", "/folders", { name, ...(parentId && { parentId }) })
  if (r.status !== 201 && r.status !== 200) throw new Error(`createFolder failed: ${r.status} ${JSON.stringify(r.body)}`)
  createdFolders.push(r.body.id)
  return r.body as { id: string; name: string; parentId: string | null }
}

/** Remember a folder the app made (through the UI, CLI or MCP) so it's deleted afterwards. */
export const trackFolder = (id: string) => void createdFolders.push(id)

export async function cleanup() {
  while (created.length) await call("DELETE", `/artifacts/${created.pop()}`)
  while (createdFolders.length) await call("DELETE", `/folders/${createdFolders.pop()}`)
}

export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

/** Poll until `check` returns truthy (for state that syncs asynchronously). */
/** What `if (v)` lets through: polls often return `cond && value`, so `false` and friends mean "not yet". */
export type Truthy<T> = Exclude<T, null | undefined | false | 0 | "">

export async function eventually<T>(check: () => Promise<T> | T, timeout = 5000): Promise<Truthy<T>> {
  const start = Date.now()
  let last: unknown
  while (Date.now() - start < timeout) {
    try {
      const v = await check()
      // TypeScript doesn't narrow a generic by truthiness beyond NonNullable; this is exactly the check above.
      if (v) return v as Truthy<T>
    } catch (e) {
      last = e
    }
    await settle(100)
  }
  throw new Error(`condition not met within ${timeout}ms${last ? `: ${String(last)}` : ""}`)
}

/**
 * Stable Chrome can spawn its updater and crash reporter, which inherit
 * Playwright's pipes and keep `browser.close()` (and the test process) hanging
 * long after the tests finish. These flags keep those helpers from starting.
 */
const quietChrome = ["--disable-breakpad", "--disable-crash-reporter", "--disable-component-update", "--disable-background-networking", "--no-first-run", "--no-default-browser-check"]

export async function launch(): Promise<Browser> {
  const browser = process.env.STDARTIFACTS_CHROME
    ? await chromium.launch({ executablePath: process.env.STDARTIFACTS_CHROME, headless: true, args: quietChrome })
    : await chromium.launch({ channel: "chrome", headless: true, args: quietChrome })
  // Never let a stuck helper turn the suite's teardown into a hang.
  const close = browser.close.bind(browser)
  browser.close = (options) => Promise.race([close(options), new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())])
  return browser
}

/** A page acting as `as` (dev only), collecting page errors so tests can assert there were none. */
export async function open(browser: Browser, as: As = "owner", size = { width: 1280, height: 720 }) {
  // Fail loudly rather than test the owner's view by mistake.
  if (as !== "owner" && !canViewAs) throw new Error(`can't open the UI as ${as} here: mark the test with viewAsOnly`)
  const ctx = await browser.newContext({ viewport: size })
  if (as !== "owner") await ctx.addInitScript((who) => sessionStorage.setItem("standard-artifacts:dev-as", who), as)
  const page = await ctx.newPage()
  const errors: Array<string> = []
  page.on("pageerror", (e) => errors.push(e.message))
  return { page, errors }
}

/** Drag with real mouse moves (Playwright's dragTo doesn't fire HTML5 drag events in headless Chrome). */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
}

/** Open a raw room socket and collect server messages. */
export function socket(id: string, as?: As) {
  const url = `${BASE.replace(/^http/, "ws")}/api/v1/rooms/${id}${as && as !== "owner" ? `?as=${as}` : ""}`
  const ws = new WebSocket(url)
  const messages: Array<any> = []
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)))
  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error(`socket failed: ${url}`))
  })
  return { ws, messages, ready, send: (msg: unknown) => ws.send(JSON.stringify(msg)) }
}

/**
 * Navigate and wait for `ready`. After code changes Vite can re-optimize
 * dependencies and stall a cold page load; one reload recovers, so a test only
 * fails if the page is still not ready after that.
 */
export async function visit(page: Page, url: string, ready: Locator, timeout = 15000) {
  await page.goto(url)
  try {
    await ready.waitFor({ timeout })
  } catch {
    await page.reload()
    await ready.waitFor({ timeout: 30000 })
  }
}

/**
 * A remote MCP session (Streamable HTTP at /mcp), as `clientName` would open
 * it: "openai-mcp" is ChatGPT, "codex-mcp-client" is Codex.
 */
export async function mcpSession(clientName = "e2e", as?: As) {
  let session: string | undefined
  let id = 0
  const post = async (body: object) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" }
    if (session) {
      headers["mcp-session-id"] = session
      headers["mcp-protocol-version"] = "2025-11-25"
    }
    if (as) headers["x-dev-as"] = as
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) })
    session ??= res.headers.get("mcp-session-id") ?? undefined
    const text = await res.text()
    const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5)
    return { status: res.status, body: json ? JSON.parse(json) : undefined }
  }
  const init = await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: clientName, version: "1" } } })
  if (init.status !== 200 || !session) throw new Error(`MCP initialize failed: ${init.status}`)
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  const request = async (method: string, params: object = {}) => {
    const r = await post({ jsonrpc: "2.0", id: ++id, method, params })
    if (r.status !== 200) throw new Error(`${method}: HTTP ${r.status}`)
    return r.body
  }
  /** A tool call: its text, and whether it failed. */
  const tool = async (name: string, args: object) => {
    const r = (await request("tools/call", { name, arguments: args })).result
    return { error: r.isError === true, text: (r.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n"), structured: r.structuredContent }
  }
  return { request, tool, session: () => session }
}
