#!/usr/bin/env node
/**
 * Smoke test for a hosted Standard Artifacts server (Cloud staging or prod, or any
 * live-mode deploy). It signs in with a personal access token and checks, end to end:
 *
 *   auth       no token, garbage and forged tokens are refused; the real one works;
 *              a token can't mint tokens, manage members or make share links
 *   crud       a table, doc, board and tracker (issue + comment): create, write, read back, delete
 *   live       a room socket sees writes made over HTTP and from a second socket
 *   mcp        remote MCP (/mcp, Streamable HTTP) and the stdio CLI (`stdartifacts mcp`)
 *   assets     an image uploads to a board, comes back byte for byte, and goes with the board
 *   agent      a person's "@claude" in a doc block starts a hosted run that completes
 *   cleanup    everything it made is deleted, and the workspace no longer lists it
 *
 * Usage: pnpm smoke [url]   (reads SMOKE_URL and SMOKE_TOKEN; `.env.local` is loaded if present)
 *   SMOKE_SKIP_AGENT=1         skip the hosted agent run (it spends model credit)
 *   SMOKE_AGENT_TIMEOUT_MS     how long to wait for the run (default 360000)
 *
 * Everything it creates is titled "smoke-<timestamp> …" and lives in a "smoke" folder.
 * Plain Node (24+), no dependencies. The token is never printed.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// SMOKE_* from the repo's gitignored .env.local, unless the environment already has them. Nothing else in it is read.
const envFile = join(ROOT, ".env.local")
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*(SMOKE_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2")
  }
}
const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? "").replace(/\/+$/, "")
const TOKEN = process.env.SMOKE_TOKEN ?? ""
const SKIP_AGENT = process.env.SMOKE_SKIP_AGENT === "1"
const AGENT_TIMEOUT_MS = Number(process.env.SMOKE_AGENT_TIMEOUT_MS ?? 6 * 60 * 1000)

if (!BASE || !/^https?:\/\//.test(BASE)) fatal("Set SMOKE_URL (or pass the URL: pnpm smoke https://staging.standardartifacts.com)")
if (!TOKEN.startsWith("sat_")) fatal("Set SMOKE_TOKEN to a sat_ access token (Settings → Access tokens)")

const API = `${BASE}/api/v1`
const STAMP = Date.now()
const PREFIX = `smoke-${STAMP}`
const FOLDER = "smoke"

// --- output ---------------------------------------------------------------------------

/** Never let the token reach the terminal, whatever ends up in a message. */
const redact = (s) => String(s).split(TOKEN).join("sat_[redacted]")

function fatal(message) {
  console.error(`smoke: ${message}`)
  process.exit(2)
}

const results = []
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`.padStart(6)

function report(status, name, ms, note) {
  results.push({ status, name })
  const line = `${status.padEnd(4)} ${ms === undefined ? "      " : secs(ms)}  ${name}${note ? ` — ${note}` : ""}`
  console.log(redact(line))
}

/** Set by Ctrl-C: no new checks start, and the run goes straight to cleanup. */
let aborted = false

/** One check: passes unless it throws. A string it returns is printed as a note. */
async function check(name, fn, { always = false } = {}) {
  if (aborted && !always) return false
  const start = Date.now()
  try {
    const note = await fn()
    report("PASS", name, Date.now() - start, typeof note === "string" ? note : undefined)
    return true
  } catch (e) {
    report("FAIL", name, Date.now() - start, e instanceof Error ? e.message : String(e))
    return false
  }
}

const skip = (name, why) => report("SKIP", name, undefined, why)

class Failure extends Error {}
const assert = (cond, message) => {
  if (!cond) throw new Failure(message)
}
const expectStatus = (r, want, what) =>
  assert(r.status === want, `${what}: expected ${want}, got ${r.status} ${short(r.body ?? r.text)}`)
const short = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : (s ?? "")
}

// --- HTTP ---------------------------------------------------------------------------

const auth = (token = TOKEN) => (token ? { authorization: `Bearer ${token}` } : {})

/** An API call. `token: null` sends none. Bodies are parsed when they're JSON. */
async function api(method, path, body, { token = TOKEN, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...auth(token ?? ""), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, body: parsed, text, headers: res.headers }
}

const ok = async (method, path, body, what = `${method} ${path}`) => {
  const r = await api(method, path, body)
  assert(r.status === 200 || r.status === 201 || r.status === 204, `${what}: ${r.status} ${short(r.body ?? r.text)}`)
  return r.body
}

const content = (id) => ok("GET", `/artifacts/${id}/content`)
const ops = (id, list) => ok("POST", `/artifacts/${id}/ops`, { ops: list }, `ops on ${id}`)
const snapshot = () => ok("GET", "/workspace")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function eventually(fn, timeout = 8000, every = 200) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout && !aborted) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(every)
  }
  throw new Failure(`not within ${timeout} ms${last ? `: ${last.message ?? last}` : ""}`)
}

// --- what this run made, for cleanup ----------------------------------------------------

const made = new Map() // id → title
let folderId
let createdFolder = false
const mentionIds = new Set()

async function create(kind, label) {
  if (aborted) throw new Failure("interrupted")
  const title = `${PREFIX} ${label}`
  const a = await ok("POST", "/artifacts", { kind, title, ...(folderId && { folderId }) }, `create ${kind}`)
  made.set(a.id, title)
  assert(a.kind === kind && a.title === title, `create ${kind}: got ${short(a)}`)
  return a
}

async function remove(id) {
  const r = await api("DELETE", `/artifacts/${id}`)
  if (r.status === 200 || r.status === 404) made.delete(id)
  return r
}

// --- sockets ----------------------------------------------------------------------------

/** A room socket, authenticated with a bearer header (Node can set one; browsers send `?ticket=`). */
function socket(id, { token = TOKEN, query = "" } = {}) {
  const url = `${BASE.replace(/^http/, "ws")}/api/v1/rooms/${id}${query}`
  const ws = new WebSocket(url, token ? { headers: auth(token) } : undefined)
  const messages = []
  ws.addEventListener("message", (e) => {
    try {
      messages.push(JSON.parse(String(e.data)))
    } catch {}
  })
  const opened = new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 15000)
    ws.addEventListener("open", () => (clearTimeout(timer), resolve("open")))
    ws.addEventListener("error", () => (clearTimeout(timer), resolve("refused")))
  })
  return { ws, messages, opened, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.readyState <= 1 && ws.close() }
}

// --- MCP --------------------------------------------------------------------------------

const PROTOCOL = "2025-11-25"
const initialize = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
})
const toolText = (result) => (result?.content ?? []).map((c) => c.text ?? "").join("\n")

/** Streamable HTTP: one POST per message, answered with JSON or a single SSE event. */
async function httpMcp(token = TOKEN) {
  let session
  let id = 0
  const post = async (body) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth(token) }
    if (session) Object.assign(headers, { "mcp-session-id": session, "mcp-protocol-version": PROTOCOL })
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) })
    session ??= res.headers.get("mcp-session-id") ?? undefined
    const text = await res.text()
    const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5)
    return { status: res.status, body: json ? JSON.parse(json) : undefined, text }
  }
  const init = await post(initialize(++id))
  const request = async (method, params = {}) => {
    const r = await post({ jsonrpc: "2.0", id: ++id, method, params })
    assert(r.status === 200, `${method}: HTTP ${r.status} ${short(r.text)}`)
    assert(!r.body?.error, `${method}: ${short(r.body?.error)}`)
    return r.body.result
  }
  if (init.status === 200 && session) await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  return { init, session: () => session, request, tool: (name, args) => request("tools/call", { name, arguments: args }) }
}

/** `stdartifacts mcp` as a child process: newline-delimited JSON-RPC on stdin/stdout. */
function stdioMcp(cli) {
  const child = spawn(process.execPath, [cli, "mcp"], {
    // Only what it needs: the URL and token come in the environment, never argv.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", STDARTIFACTS_URL: BASE, STDARTIFACTS_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let buffer = ""
  let stderr = ""
  const waiting = new Map()
  child.stdout.on("data", (d) => {
    buffer += d
    let nl
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && waiting.has(msg.id)) {
          waiting.get(msg.id)(msg)
          waiting.delete(msg.id)
        }
      } catch {}
    }
  })
  child.stderr.on("data", (d) => (stderr += d))
  let id = 0
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`)
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const timer = setTimeout(() => (waiting.delete(n), reject(new Failure(`${method}: no answer in 30 s${stderr ? `; stderr: ${short(stderr)}` : ""}`))), 30000)
      waiting.set(n, (msg) => {
        clearTimeout(timer)
        if (msg.error) reject(new Failure(`${method}: ${short(msg.error)}`))
        else resolve(msg.result)
      })
      send(method === "initialize" ? initialize(n) : { jsonrpc: "2.0", id: n, method, params })
    })
  return {
    request,
    notify: (method) => send({ jsonrpc: "2.0", method }),
    tool: (name, args) => request("tools/call", { name, arguments: args }),
    close: () => child.kill(),
  }
}

// --- the checks -------------------------------------------------------------------------

// A 1×1 PNG, complete (IHDR, IDAT, IEND), so the server's byte sniffing accepts it.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"))

let me // the principal the token resolves to
const agentRun = { doc: undefined, mention: undefined, filedAt: 0 }

async function authChecks() {
  await check("auth: no token → 401", async () => {
    expectStatus(await api("GET", "/workspace", undefined, { token: null }), 401, "GET /workspace")
  })
  await check("auth: malformed sat_ token → 401", async () => {
    expectStatus(await api("GET", "/workspace", undefined, { token: "sat_garbage" }), 401, "GET /workspace")
  })
  await check("auth: well-formed sat_ token with a wrong secret → 401", async () => {
    // Same org part as the real token, random secret: it reaches the org's cell and isn't found.
    const org = TOKEN.split("_")[1]
    const fake = `sat_${org}_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`
    const r = await api("GET", "/workspace", undefined, { token: fake })
    expectStatus(r, 401, "GET /workspace")
    return r.body?.message
  })
  await check("auth: forged HMAC ticket → 401", async () => {
    const body = Buffer.from(JSON.stringify({ orgId: "org_x", orgName: "x", plan: "team", role: "owner", actor: { type: "user", id: "usr_x", name: "x" }, exp: 4102444800 })).toString("base64url")
    expectStatus(await api("GET", "/workspace", undefined, { token: `${body}.${Buffer.from("nope").toString("base64url")}` }), 401, "GET /workspace")
  })
  const valid = await check("auth: valid token → 200", async () => {
    const r = await api("GET", "/workspace")
    expectStatus(r, 200, "GET /workspace")
    me = r.body.principal
    assert(r.body.authMode === "live", `authMode is ${r.body.authMode}, expected live`)
    assert(me.actor.type === "user", `actor is ${me.actor.type}`)
    return `role ${me.role}, plan ${me.plan}, ${r.body.artifacts.length} artifacts`
  })
  if (!valid) return false

  await check("auth: a token lists its owner's tokens", async () => {
    const r = await api("GET", "/tokens")
    expectStatus(r, 200, "GET /tokens")
    assert(Array.isArray(r.body) && r.body.length >= 1, `expected at least this token, got ${short(r.body)}`)
    return `${r.body.length} token(s)`
  })
  await check("auth: a token can't create tokens (403)", async () => {
    const r = await api("POST", "/tokens", { name: `${PREFIX} should not exist` })
    if (r.status === 200 && r.body?.id) await api("DELETE", `/tokens/${r.body.id}`) // never leave one behind
    expectStatus(r, 403, "POST /tokens")
  })
  await check("auth: a token can't manage members (403 ×5)", async () => {
    // Ids that don't exist: the guard runs before any lookup, so 404 here would mean it's missing.
    const tried = [
      ["POST", "/org/invitations", { email: "smoke-never-sent@example.com", role: "viewer" }],
      ["POST", "/org/invitations/inv_smoke_none/resend"],
      ["DELETE", "/org/invitations/inv_smoke_none"],
      ["PATCH", "/org/members/om_smoke_none", { role: "viewer" }],
      ["DELETE", "/org/members/om_smoke_none"],
    ]
    for (const [method, path, body] of tried) {
      const r = await api(method, path, body)
      if (method === "POST" && path === "/org/invitations" && r.status === 200 && r.body?.id) await api("DELETE", `/org/invitations/${r.body.id}`)
      expectStatus(r, 403, `${method} ${path}`)
    }
  })
  await check("auth: a token can read the member list", async () => {
    const r = await api("GET", "/org/members")
    expectStatus(r, 200, "GET /org/members")
    return `${r.body.members.length} member(s), ${r.body.invitations.length} pending invitation(s)` // no names or emails
  })
  await check("auth: revoking an unknown token id → 404", async () => {
    expectStatus(await api("DELETE", "/tokens/tok_smoke_none"), 404, "DELETE /tokens/:id")
  })
  skip("auth: revoke a throwaway token", "no API path: tokens are minted only from a signed-in browser session (POST /tokens refuses tokens and ticket-only callers)")
  return true
}

async function folderCheck() {
  await check(`folder: "${FOLDER}" exists`, async () => {
    const existing = (await snapshot()).folders.find((f) => f.name === FOLDER && !f.parentId)
    if (existing) {
      folderId = existing.id
      return `reusing ${existing.id}`
    }
    const f = await ok("POST", "/folders", { name: FOLDER }, "create folder")
    folderId = f.id
    createdFolder = true
    return `created ${f.id}`
  })
}

/** Filed early, checked last: the container's cold start overlaps the other checks. */
async function fileAgentRequest() {
  if (SKIP_AGENT) return
  await check("agent: a person's @claude in a doc block files a request", async () => {
    agentRun.doc = await create("doc", "agent run")
    await ops(agentRun.doc.id, [
      { type: "insert", item: { id: "k_smoke_ask", type: "paragraph", text: "@claude Add one new paragraph block after this one whose text is exactly the word pong. Do nothing else." } },
    ])
    agentRun.filedAt = Date.now()
    const m = await eventually(async () => {
      const list = await ok("GET", `/mentions?artifactId=${agentRun.doc.id}`)
      return list.find((x) => x.target.type === "block" && x.target.id === "k_smoke_ask")
    })
    agentRun.mention = m
    mentionIds.add(m.id)
    assert(m.requestedBy === me.actor.id, `requested by ${m.requestedBy}, expected the token's person`)
    return `${m.id} ${m.status}`
  })
}

async function crudChecks() {
  await check("crud: table (columns, cells)", async () => {
    const t = await create("table", "table")
    const c0 = await content(t.id)
    const [col] = c0.state.columns
    const [row] = c0.state.rowIds
    assert(col && row, `new table has no column or row: ${short(c0.state)}`)
    const r = await ops(t.id, [
      { type: "addColumn", column: { id: "c_smoke", name: "Smoke", type: "text" } },
      { type: "setCell", rowId: row, colId: col.id, value: "smoke-row" },
      { type: "setCell", rowId: row, colId: "c_smoke", value: "ok" },
    ])
    assert(r.applied === 3, `applied ${r.applied}`)
    const c = await content(t.id)
    assert(c.state.cells[`${row}:${col.id}`]?.v === "smoke-row", `cell reads ${short(c.state.cells[`${row}:${col.id}`])}`)
    assert(c.state.columns.some((x) => x.id === "c_smoke"), "the new column is missing")
    assert(/smoke-row/.test(c.text), "the text rendering lacks the cell")
    await deleted(t.id)
  })
  await check("crud: doc (blocks, rename, markdown)", async () => {
    const d = await create("doc", "doc")
    const first = (await content(d.id)).state.items[0].id
    await ops(d.id, [
      { type: "update", id: first, patch: { type: "heading1", text: "Smoke" } },
      { type: "insert", item: { id: "k_smoke_1", type: "paragraph", text: "It works." }, after: first },
      { type: "insert", item: { id: "k_smoke_2", type: "todo", text: "Clean up", checked: true }, after: "k_smoke_1" },
    ])
    const renamed = await ok("PATCH", `/artifacts/${d.id}`, { title: `${PREFIX} doc renamed` }, "rename")
    made.set(d.id, renamed.title)
    const c = await content(d.id)
    assert(c.text === "# Smoke\n\nIt works.\n\n- [x] Clean up", `markdown reads ${JSON.stringify(c.text)}`)
    assert(c.artifact.title === `${PREFIX} doc renamed`, `title reads ${c.artifact.title}`)
    assert(c.artifact.folderId === folderId, `folder is ${c.artifact.folderId}, expected ${folderId}`)
    // Share links are made in the app, never with a token.
    const link = await api("POST", `/artifacts/${d.id}/link`)
    if (link.status === 200) await api("DELETE", `/artifacts/${d.id}/link`)
    expectStatus(link, 403, "POST /artifacts/:id/link with a token")
    await deleted(d.id)
  })
  await check("crud: board (shapes, arrows)", async () => {
    const b = await create("board", "board")
    await ops(b.id, [
      { type: "insert", item: { id: "s_smoke_a", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "Smoke A" } },
      { type: "insert", item: { id: "s_smoke_b", kind: "rect", x: 300, y: 0, w: 160, h: 100, text: "Smoke B" } },
      { type: "insert", item: { id: "s_smoke_ab", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_smoke_a", to: "s_smoke_b" } },
    ])
    const ids = (await content(b.id)).state.items.map((s) => s.id)
    for (const id of ["s_smoke_a", "s_smoke_b", "s_smoke_ab"]) assert(ids.includes(id), `${id} missing from ${short(ids)}`)
    await deleted(b.id)
  })
  await check("crud: tracker (issue, comment)", async () => {
    const t = await create("tracker", "tracker")
    const at = new Date().toISOString()
    await ops(t.id, [
      { type: "insert", item: { type: "issue", id: "is_smoke", number: 0, title: "Smoke issue", status: "todo", priority: "none", source: { via: "api" }, createdAt: at } },
      { type: "insert", item: { type: "comment", id: "co_smoke", issueId: "is_smoke", text: "Smoke comment", at } },
    ])
    const items = (await content(t.id)).state.items
    const issue = items.find((i) => i.id === "is_smoke")
    const comment = items.find((i) => i.id === "co_smoke")
    assert(issue?.number === 1, `issue reads ${short(issue)}`)
    assert(issue.createdBy === me.actor.id, `issue createdBy ${issue.createdBy}, expected ${me.actor.id}`)
    assert(comment?.text === "Smoke comment" && comment.by === me.actor.id, `comment reads ${short(comment)}`)
    await deleted(t.id)
  })
}

/** Delete, then make sure it's gone from the API and the workspace. */
async function deleted(id) {
  const r = await remove(id)
  expectStatus(r, 200, `DELETE /artifacts/${id}`)
  expectStatus(await api("GET", `/artifacts/${id}/content`), 404, "content after delete")
  assert(!(await snapshot()).artifacts.some((a) => a.id === id), "still listed after delete")
}

async function liveChecks() {
  let a
  let b
  try {
    const d = await create("doc", "live sync")
    const first = (await content(d.id)).state.items[0].id
    a = socket(d.id)
    const opened = await check("live: room socket opens with the token", async () => {
      const state = await a.opened
      assert(state === "open", `socket ${state}`)
      const init = await eventually(() => a.messages.find((m) => m.type === "init"))
      assert(init.self.actor.id === me.actor.id && init.self.readOnly === false, `init.self is ${short(init.self)}`)
      return `seq ${init.seq}`
    })
    await check("live: sockets without credentials or with a forged ticket are refused", async () => {
      const none = socket(d.id, { token: "" })
      const forged = socket(d.id, { token: "", query: "?ticket=forged.ticket" })
      const [s1, s2] = await Promise.all([none.opened, forged.opened])
      none.close()
      forged.close()
      assert(s1 === "refused" && s2 === "refused", `no credentials: ${s1}, forged ticket: ${s2}`)
    })
    if (!opened) return
    await check("live: an HTTP write reaches the socket", async () => {
      await ops(d.id, [{ type: "update", id: first, patch: { text: "from http" } }])
      await eventually(() => a.messages.find((m) => m.type === "op" && m.op?.patch?.text === "from http"))
    })
    await check("live: a second socket's write reaches the first", async () => {
      b = socket(d.id)
      assert((await b.opened) === "open", "second socket didn't open")
      await eventually(() => b.messages.find((m) => m.type === "init"))
      await eventually(() => a.messages.find((m) => m.type === "join"))
      b.send({ type: "op", id: "smoke-op-1", op: { type: "insert", item: { id: "k_smoke_ws", type: "paragraph", text: "from socket" }, after: first } })
      await eventually(() => a.messages.find((m) => m.type === "op" && m.op?.item?.id === "k_smoke_ws"))
      const reject = b.messages.find((m) => m.type === "reject")
      assert(!reject, `rejected: ${short(reject)}`)
      assert((await content(d.id)).text.includes("from socket"), "the socket's write isn't in the stored content")
    })
  } finally {
    a?.close()
    b?.close()
  }
}

async function mcpChecks() {
  const d = await create("doc", "mcp")
  await check("mcp http: no token → 401", async () => {
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(initialize(1)) })
    assert(res.status === 401, `expected 401, got ${res.status}`)
  })
  let mcp
  const up = await check("mcp http: initialize + tools/list", async () => {
    mcp = await httpMcp()
    assert(mcp.init.status === 200 && mcp.session(), `initialize: HTTP ${mcp.init.status} ${short(mcp.init.text)}`)
    const { tools } = await mcp.request("tools/list")
    const names = tools.map((t) => t.name)
    for (const n of ["read_artifact", "doc_append", "list_artifacts"]) assert(names.includes(n), `no ${n} in ${names.length} tools`)
    return `${mcp.init.body.result.serverInfo?.name} ${mcp.init.body.result.serverInfo?.version}, ${tools.length} tools`
  })
  if (up) {
    await check("mcp http: read tool (read_artifact)", async () => {
      const r = await mcp.tool("read_artifact", { artifact: d.id })
      assert(!r.isError, `error: ${short(toolText(r))}`)
      assert(toolText(r).includes(d.title), `text lacks the title: ${short(toolText(r))}`)
    })
    await check("mcp http: write tool (doc_append), as an agent", async () => {
      const r = await mcp.tool("doc_append", { artifact: d.id, markdown: "Written over remote MCP." })
      assert(!r.isError, `error: ${short(toolText(r))}`)
      const block = (await content(d.id)).state.items.find((i) => i.text === "Written over remote MCP.")
      assert(block, "the block isn't in the doc")
    })
  }

  const cli = join(ROOT, "apps/cli/dist/stdartifacts.mjs")
  await check("mcp stdio: stdartifacts mcp against this server", async () => {
    if (!existsSync(cli)) {
      const built = spawnSync("pnpm", ["--filter", "stdartifacts", "build"], { cwd: ROOT, encoding: "utf8" })
      assert(built.status === 0 && existsSync(cli), `couldn't build the CLI (pnpm cli): ${short(built.stderr || built.stdout)}`)
    }
    const s = stdioMcp(cli)
    try {
      const init = await s.request("initialize")
      s.notify("notifications/initialized")
      const { tools } = await s.request("tools/list")
      assert(tools.some((t) => t.name === "read_artifact"), "no read_artifact tool")
      const read = await s.tool("read_artifact", { artifact: d.id })
      assert(!read.isError && toolText(read).includes(d.title), `read_artifact: ${short(toolText(read))}`)
      const wrote = await s.tool("doc_append", { artifact: d.id, markdown: "Written over stdio MCP." })
      assert(!wrote.isError, `doc_append: ${short(toolText(wrote))}`)
      assert((await content(d.id)).state.items.some((i) => i.text === "Written over stdio MCP."), "the block isn't in the doc")
      return `${init.serverInfo?.name} ${init.serverInfo?.version}, ${tools.length} tools`
    } finally {
      s.close()
    }
  })
}

async function assetChecks() {
  const b = await create("board", "assets")
  let url
  await check("assets: upload an image to a board", async () => {
    const res = await fetch(`${API}/artifacts/${b.id}/assets`, { method: "POST", headers: { "content-type": "image/png", ...auth() }, body: PNG })
    const body = await res.json().catch(() => null)
    assert(res.status === 201 && body?.url, `upload: ${res.status} ${short(body)}`)
    url = new URL(body.url, BASE).toString()
    return body.id
  })
  if (!url) return
  await check("assets: fetch it back byte for byte, with safe headers", async () => {
    const res = await fetch(url, { headers: auth() })
    assert(res.status === 200, `GET: ${res.status}`)
    assert(res.headers.get("content-type") === "image/png", `content-type ${res.headers.get("content-type")}`)
    assert(res.headers.get("x-content-type-options") === "nosniff", "no nosniff header")
    assert(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG)), "bytes differ")
    assert((await fetch(url)).status === 401, "readable without credentials")
  })
  await check("assets: refused on a table, and for bytes that aren't an image", async () => {
    const t = await create("table", "no assets")
    const onTable = await fetch(`${API}/artifacts/${t.id}/assets`, { method: "POST", headers: { "content-type": "image/png", ...auth() }, body: PNG })
    assert(onTable.status === 400, `table upload: ${onTable.status}`)
    const html = await fetch(`${API}/artifacts/${b.id}/assets`, { method: "POST", headers: { "content-type": "image/png", ...auth() }, body: "<html><script>alert(1)</script>" })
    assert(html.status === 400, `html as png: ${html.status}`)
    await remove(t.id)
  })
  // There's no route to delete one image: assets live in the board's cell and go with it.
  await check("assets: deleting the board deletes its images", async () => {
    expectStatus(await remove(b.id), 200, "DELETE board")
    const res = await fetch(url, { headers: auth() })
    assert(res.status === 404, `asset after delete: ${res.status}`)
  })
}

async function agentCheck() {
  if (SKIP_AGENT) return skip("agent: hosted @claude run completes", "SMOKE_SKIP_AGENT=1")
  if (!agentRun.mention) return skip("agent: hosted @claude run completes", "the request wasn't filed (see above)")
  await check("agent: hosted @claude run completes", async () => {
    const seen = []
    let m
    const deadline = agentRun.filedAt + AGENT_TIMEOUT_MS
    while (Date.now() < deadline && !aborted) {
      const list = await ok("GET", `/mentions?artifactId=${agentRun.doc.id}`)
      m = list.find((x) => x.id === agentRun.mention.id)
      assert(m, "the request disappeared from the inbox")
      const at = `${m.status}@${secs(Date.now() - agentRun.filedAt).trim()}`
      if (seen.at(-1)?.split("@")[0] !== m.status) seen.push(at)
      if (["done", "error", "cancelled"].includes(m.status)) break
      await sleep(3000)
    }
    const path = seen.join(" → ")
    if (aborted) throw new Failure(`interrupted while ${m?.status} (${path})`)
    assert(m && ["done", "error", "cancelled"].includes(m.status), `still ${m?.status} after ${secs(AGENT_TIMEOUT_MS).trim()} (attempts ${m?.attempts}; ${path})`)
    assert(m.status === "done", `${m.status} after ${m.attempts} attempt(s): ${JSON.stringify(m.result)} (${path})`)
    const c = await content(agentRun.doc.id)
    const replies = c.state.items.filter((i) => i.id !== "k_smoke_ask" && /\bpong\b/i.test(i.text ?? ""))
    assert(replies.length > 0, `done, but no "pong" block: ${short(c.text)} (result: ${short(m.result)})`)
    return `${path}; ${m.attempts} attempt(s); result: ${short(m.result).slice(0, 120)}`
  })
}

// --- cleanup ----------------------------------------------------------------------------

/** "smoke-<ms> …" from a run that died before its cleanup, at least an hour old. */
const stale = (title) => {
  const t = /^smoke-(\d{13}) /.exec(title)?.[1]
  return t !== undefined && Number(t) !== STAMP && Date.now() - Number(t) > 60 * 60 * 1000
}

async function cleanup() {
  await check("cleanup: delete everything this run made", async () => {
    for (const id of mentionIds) {
      const m = await api("POST", `/mentions/${id}/cancel`) // a no-op unless it's still queued or running
      if (m.status !== 200 && m.status !== 404) throw new Failure(`cancel ${id}: ${m.status}`)
    }
    const failed = []
    const swept = []
    // Leftovers of earlier runs that were killed mid-way, archived ones included.
    const snap = await snapshot()
    const archived = (await api("GET", "/artifacts/archived")).body ?? []
    for (const a of [...snap.artifacts, ...archived]) if (stale(a.title) && !made.has(a.id)) (made.set(a.id, a.title), swept.push(a.id))
    for (const id of [...made.keys()]) {
      const r = await remove(id)
      if (r.status !== 200 && r.status !== 404) failed.push(`${id}: ${r.status}`)
    }
    assert(!failed.length, `couldn't delete ${failed.join(", ")}`)
    if (folderId) {
      const after = await snapshot()
      const inFolder = after.artifacts.filter((a) => a.folderId === folderId)
      const child = after.folders.some((f) => f.parentId === folderId)
      // Only an empty folder goes: someone may have put something real in it.
      if (!inFolder.length && !child) {
        const r = await api("DELETE", `/folders/${folderId}`)
        if (r.status !== 200 && r.status !== 404) throw new Failure(`delete folder: ${r.status}`)
      }
    }
    return swept.length ? `also swept ${swept.length} leftover(s) from earlier runs` : undefined
  }, { always: true })
  await check("cleanup: the workspace lists no smoke artifacts", async () => {
    const snap = await snapshot()
    const archived = (await api("GET", "/artifacts/archived")).body ?? []
    const left = [...snap.artifacts, ...archived].filter((a) => a.title.startsWith(PREFIX) || stale(a.title))
    assert(!left.length, `still listed: ${left.map((a) => `${a.id} "${a.title}"`).join(", ")}`)
    const folder = snap.folders.find((f) => f.name === FOLDER && !f.parentId)
    const note = folder ? `"${FOLDER}" folder kept: it holds other things` : `"${FOLDER}" folder removed`
    return `${snap.artifacts.length} artifact(s) left in the workspace; ${note}`
  }, { always: true })
}

// --- run --------------------------------------------------------------------------------

process.on("SIGINT", () => {
  if (aborted) process.exit(130)
  aborted = true
  console.log("\ninterrupted: cleaning up after the current step (Ctrl-C again to quit without cleaning up)")
})

console.log(`Smoke test: ${BASE} (run ${PREFIX})\n`)
const started = Date.now()
try {
  if (await authChecks()) {
    await folderCheck()
    await fileAgentRequest()
    await crudChecks()
    await liveChecks()
    await mcpChecks()
    await assetChecks()
    await agentCheck()
  }
} catch (e) {
  // A check's setup (creating its artifact) failed outside a check.
  if (!aborted) report("FAIL", "setup", undefined, e instanceof Error ? e.message : String(e))
} finally {
  if (me) await cleanup()
}

const failed = results.filter((r) => r.status === "FAIL")
const passed = results.filter((r) => r.status === "PASS").length
const skipped = results.filter((r) => r.status === "SKIP").length
console.log(`\n${aborted ? "INTERRUPTED" : failed.length ? "FAILED" : "OK"}: ${passed} passed, ${failed.length} failed, ${skipped} skipped in ${secs(Date.now() - started).trim()}`)
process.exit(aborted ? 130 : failed.length ? 1 : 0)
