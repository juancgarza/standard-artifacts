import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * Starts the built `standard-artifacts-server` on a free port with a temp data
 * dir, writes a board, restarts it and reads the board back. Also covers the
 * owner's name, the data-dir lock and the dev guard. Needs `pnpm build` first.
 */

const pkgDir = fileURLToPath(new URL("..", import.meta.url))
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { bin: Record<string, string> }
const bin = join(pkgDir, pkg.bin["standard-artifacts-server"]!)
const data = mkdtempSync(join(tmpdir(), "stdartifacts-smoke-"))
const lockFile = join(data, "server.lock")
let child: ChildProcess | undefined

after(async () => {
  await stop()
  rmSync(data, { recursive: true, force: true })
})

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer()
    s.once("error", fail)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number }
      s.close(() => done(port))
    })
  })

const args = (port: number, extra: Array<string> = []) => [bin, "--port", String(port), "--data", data, "--no-open", ...extra]

async function start(port: number, extra: Array<string> = []) {
  let log = ""
  child = spawn(process.execPath, args(port, extra), { stdio: ["ignore", "pipe", "pipe"] })
  child.stdout!.on("data", (d) => (log += d))
  child.stderr!.on("data", (d) => (log += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}):\n${log}`)
    const up = await fetch(`${base}/api/v1/workspace`).then((r) => r.ok, () => false)
    if (up) return { base, log: () => log }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`server didn't answer at ${base}:\n${log}`)
}

async function stop() {
  const c = child
  child = undefined
  if (!c || c.exitCode !== null) return
  const exited = new Promise((r) => c.once("exit", r))
  c.kill("SIGINT")
  await exited
}

/** Run a second server to completion (it's expected to refuse) and collect what it said. */
const attempt = (port: number) =>
  new Promise<{ code: number | null; output: string }>((done) => {
    let output = ""
    const p = spawn(process.execPath, args(port), { stdio: ["ignore", "pipe", "pipe"] })
    p.stdout.on("data", (d) => (output += d))
    p.stderr.on("data", (d) => (output += d))
    const timer = setTimeout(() => p.kill("SIGKILL"), 20_000)
    p.once("exit", (code) => {
      clearTimeout(timer)
      done({ code, output })
    })
  })

const json = async (base: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** fetch() won't send a foreign Host header, so use node:http. */
const withHeaders = (base: string, path: string, headers: Record<string, string>) =>
  new Promise<number>((done, fail) => {
    const req = request(`${base}${path}`, { headers }, (res) => {
      res.resume()
      done(res.statusCode ?? 0)
    })
    req.once("error", fail)
    req.end()
  })

test("serves the app, keeps a board across a restart, and only answers localhost", async () => {
  const port = await freePort()
  const first = await start(port, ["--name", "Smoke Tester"])
  assert.match(first.log(), new RegExp(`http://127\\.0\\.0\\.1:${port}`))
  assert.match(first.log(), /claude mcp add stdartifacts/)

  const page = await fetch(`${first.base}/board/anything`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get("content-type") ?? "", /text\/html/, "the SPA answers app routes")

  const snapshot = await json(first.base, "GET", "/workspace")
  assert.equal(snapshot.body.principal.actor.name, "Smoke Tester", "--name is the owner's name")
  assert.equal(snapshot.body.principal.role, "owner")
  assert.equal(snapshot.body.authMode, "dev", "the server says it has no sign-in")

  const board = await json(first.base, "POST", "/artifacts", { kind: "board", title: "Smoke board" })
  assert.ok(board.status === 200 || board.status === 201, JSON.stringify(board.body))
  const id = board.body.id as string
  const applied = await json(first.base, "POST", `/artifacts/${id}/ops`, {
    ops: [{ type: "insert", item: { id: "s_kept", kind: "rect", x: 10, y: 20, w: 160, h: 100, text: "Survives restarts" } }],
  })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))

  assert.equal(await withHeaders(first.base, "/api/v1/workspace", { host: "evil.example" }), 403, "foreign Host")
  assert.equal(await withHeaders(first.base, "/api/v1/workspace", { origin: "https://evil.example" }), 403, "foreign Origin")
  assert.equal(await withHeaders(first.base, "/mcp", { host: "evil.example" }), 403, "MCP too")
  assert.equal(await withHeaders(first.base, "/api/v1/workspace", { host: `localhost:${port}` }), 200)

  // One server per data dir: a second one on another port refuses and says where the first is.
  assert.deepEqual(JSON.parse(readFileSync(lockFile, "utf8")), { pid: child!.pid, port })
  const second = await attempt(await freePort())
  assert.equal(second.code, 1, second.output)
  assert.match(second.output, new RegExp(`already using .* on port ${port}`), second.output)

  await stop()
  assert.equal(existsSync(lockFile), false, "a clean stop releases the lock")

  // A lock left by a process that's gone is stale, and the next start takes it over.
  writeFileSync(lockFile, JSON.stringify({ pid: 999_999, port: 1 }))
  const restarted = await start(port)
  const listed = await json(restarted.base, "GET", "/workspace")
  assert.ok(listed.body.artifacts.some((a: { id: string; title: string }) => a.id === id && a.title === "Smoke board"), "still listed")
  const content = await json(restarted.base, "GET", `/artifacts/${id}/content`)
  assert.equal(content.status, 200)
  const kept = content.body.state.items.find((s: { id: string }) => s.id === "s_kept")
  assert.equal(kept?.text, "Survives restarts")

  // Without --name, the owner is the OS account (never the old hard-coded "JC", unless that's you).
  const { ownerName } = (await import(join(pkgDir, "dist/index.mjs"))) as { ownerName: () => string }
  const expected = ownerName()
  assert.ok(expected.length > 0)
  assert.equal(listed.body.principal.actor.name, expected)
  assert.match(restarted.log(), new RegExp(`as "${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`))
})
