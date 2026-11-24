import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, describe, test } from "node:test"
import { BASE, cleanup, content, create } from "./harness.ts"

/** The CLI and MCP server are thin clients over the API; these run the built `stdartifacts` binary. */

const bin = fileURLToPath(new URL("../../apps/cli/dist/stdartifacts.mjs", import.meta.url))
const env = { ...process.env, STDARTIFACTS_URL: BASE }

const cli = (...args: Array<string>) => {
  const r = spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8" })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

after(cleanup)

describe("stdartifacts CLI", () => {
  test("tables: add rows by column name, read back", async () => {
    const t = await create("table", "cli table")
    const added = cli("table", "add-row", t.id, "Name=Ada Lovelace", "Website=https://ada.dev", "Status=Lead")
    assert.equal(added.code, 0, added.err)
    assert.match(added.out, /Added row r_/)
    const read = cli("read", t.id)
    assert.match(read.out, /"Ada Lovelace"/)
  })

  test("docs: images from markdown and from files", async () => {
    const d = await create("doc", "cli images")
    const input = "![a \\] b](https://example.com/x%28y%29.png)\n\n![x](javascript:alert(1))\n\ntext ![inline](https://example.com/i.png)\n"
    assert.equal(spawnSync(process.execPath, [bin, "doc", "append", d.id], { env, encoding: "utf8", input }).status, 0)
    const parsed = (await content(d.id)).state.items.map((b: { type: string; text: string; src?: string }) => [b.type, b.text, b.src])
    assert.deepEqual(parsed, [
      ["image", "a ] b", "https://example.com/x%28y%29.png"],
      ["paragraph", "![x](javascript:alert(1))", undefined],
      ["paragraph", "text ![inline](https://example.com/i.png)", undefined],
    ])
    assert.match((await content(d.id)).text, /^!\[a \\\] b\]\(https:\/\/example\.com\/x%28y%29\.png\)/)

    const links = await create("doc", "cli links")
    const linked = "![[t_abc]]\n\n![[b_abc#s_def|The plan]]\n\nsee ![[t_abc]] here\n"
    assert.equal(spawnSync(process.execPath, [bin, "doc", "append", links.id], { env, encoding: "utf8", input: linked }).status, 0)
    assert.deepEqual(
      (await content(links.id)).state.items.map((b: { type: string; text: string; ref?: unknown }) => [b.type, b.text, b.ref]),
      [
        ["embed", "", { artifactId: "t_abc" }],
        ["embed", "The plan", { artifactId: "b_abc", item: "s_def" }],
        ["paragraph", "see ![[t_abc]] here", undefined],
      ],
    )
    assert.equal((await content(links.id)).text, linked.trim())

    const dir = mkdtempSync(join(tmpdir(), "standard-artifacts-doc-image-"))
    const file = join(dir, "chart.png")
    writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"))
    const r = spawnSync(process.execPath, [bin, "doc", "image", d.id, file, "--caption", "Signups"], { env, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    rmSync(dir, { recursive: true })
    const last = (await content(d.id)).state.items.at(-1)
    assert.equal(last.type, "image")
    assert.equal(last.text, "Signups")
    assert.match(last.src, /^\/api\/v1\/artifacts\/.+\/assets\//)
  })

  test("docs: markdown from stdin becomes blocks", async () => {
    const d = await create("doc", "cli doc")
    const r = spawnSync(process.execPath, [bin, "doc", "append", d.id], { env, encoding: "utf8", input: "# Plan\n\n- [ ] ship\n- [x] test\n" })
    assert.equal(r.status, 0, r.stderr)
    assert.equal((await content(d.id)).text, "# Plan\n\n- [ ] ship\n\n- [x] test")
  })

  test("expected errors print one line and exit 1", async () => {
    const t = await create("table", "cli errors")
    const missing = cli("read", "e2e definitely-not-here")
    assert.equal(missing.code, 1)
    assert.equal(missing.err, 'error: No artifact matches "e2e definitely-not-here"')
    const column = cli("table", "add-row", t.id, "Nope=1")
    assert.match(column.err, /^error: No column "Nope". Columns: Name, Website, Status$/)
    const guest = spawnSync(process.execPath, [bin, "table", "add-row", t.id, "Name=x"], { env: { ...env, STDARTIFACTS_AS: "guest" }, encoding: "utf8" })
    assert.equal(guest.stderr.trim(), "error: Read-only")
  })
})

describe("MCP over stdio", () => {
  test("handshake, 36 tools, real edits, tool errors, clean stdout", async () => {
    const b = await create("board", "mcp board")
    const proc = spawn(process.execPath, [bin, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    const junk: Array<string> = []
    const waiting = new Map<number, (msg: any) => void>()
    proc.stdout.on("data", (d) => {
      buffer += d
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          waiting.get(msg.id)?.(msg)
        } catch {
          junk.push(line)
        }
      }
    })
    let id = 0
    const rpc = (method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        const n = ++id
        waiting.set(n, resolve)
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
        setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
      })
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await rpc("tools/call", { name, arguments: args })
      return { error: r.result?.isError === true || !!r.error, text: r.error?.message ?? r.result.content.map((c: { text: string }) => c.text).join("\n") }
    }
    try {
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } })
      assert.equal(init.result.serverInfo.name, "stdartifacts")
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      const tools = await rpc("tools/list", {})
      assert.equal(tools.result.tools.length, 36)

      const added = await tool("board_add", { artifact: b.id, items: [{ text: "From MCP", color: "purple" }] })
      assert.equal(added.error, false, added.text)
      const shape = (await content(b.id)).state.items.find((s: { text?: string }) => s.text === "From MCP")
      assert.ok(shape, "note was added")
      assert.equal(shape.color, "purple")

      const t = await create("table", "mcp table")
      const column = await tool("table_add_column", { artifact: t.id, name: "Tags", type: "select", options: ["AI", "B2B"], multiSelect: true })
      assert.equal(column.error, false, column.text)
      const tags = (await content(t.id)).state.columns.find((c: { name: string }) => c.name === "Tags")
      assert.equal(tags.type, "multiSelect")
      const row = await tool("table_add_rows", { artifact: t.id, rows: [{ Name: "Acme", Tags: ["AI", "B2B"] }] })
      assert.equal(row.error, false, row.text)

      // Artifact columns take ids, titles and links, in rows and in cells, and agents read back the ids.
      const d = await create("doc", `mcp linked ${Date.now().toString(36)}`)
      const links = await tool("table_add_column", { artifact: t.id, name: "Links", type: "artifact" })
      assert.equal(links.error, false, links.text)
      const linked = await tool("table_add_rows", { artifact: t.id, rows: [{ Name: "Linked", Links: [d.title, `${b.id}#${shape.id}`] }] })
      assert.equal(linked.error, false, linked.text)
      const state = (await content(t.id)).state
      const linksId = state.columns.find((c: { name: string }) => c.name === "Links").id
      const rowId = state.rowIds.at(-1)
      assert.deepEqual(state.cells[`${rowId}:${linksId}`].v, [d.id, `${b.id}#${shape.id}`])
      const set = await tool("table_set_cells", { artifact: t.id, cells: [{ row: rowId, column: "Links", value: `https://standardartifacts.com/boards/${b.id}, ${d.title}` }] })
      assert.equal(set.error, false, set.text)
      assert.deepEqual((await content(t.id)).state.cells[`${rowId}:${linksId}`].v, [b.id, d.id])
      const unknown = await tool("table_set_cells", { artifact: t.id, cells: [{ row: rowId, column: "Links", value: ["e2e no such artifact"] }] })
      assert.equal(unknown.error, true)
      assert.match(unknown.text, /No artifact matches/)
      const read = await tool("read_artifact", { artifact: t.id })
      assert.match(read.text, /"Links"\(artifact\)/)
      assert.ok(read.text.includes(JSON.stringify([b.id, d.id])))

      const missing = await tool("read_artifact", { artifact: "e2e not-a-thing" })
      assert.equal(missing.error, true)
      assert.match(missing.text, /No artifact matches/)
      const invalid = await tool("board_add", { artifact: b.id, items: [{ text: "x", color: "orange" }] })
      assert.equal(invalid.error, true)
      assert.deepEqual(junk, [], "stdout must carry only JSON-RPC")
    } finally {
      proc.kill()
    }
  })
})
