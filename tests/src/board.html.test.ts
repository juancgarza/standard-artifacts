import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, cleanup, content, create, drag, eventually, launch, open, ops, settle, viewAsOnly, visit } from "./harness.ts"

/** Boards: html embeds (sandboxed live snippets) for people and agents. */

type Shape = { id: string; kind: string; x: number; y: number; w: number; h: number; text?: string; html?: string; from?: string; to?: string; src?: string }
type Box = { x: number; y: number; width: number; height: number }

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

const items = async (id: string): Promise<Array<Shape>> => (await content(id)).state.items
const find = async (id: string, shapeId: string) => (await items(id)).find((s) => s.id === shapeId)
const mid = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

/** A counter, plus probes for what the sandbox lets it reach. */
const COUNTER = `<style>body{margin:0;display:grid;place-items:center;height:100vh}</style>
<div><button id="b" style="font-size:20px;padding:12px 24px">0</button><p id="parent"></p><p id="storage"></p><p id="cookie"></p><p id="net">pending</p></div>
<script>
  let n = 0
  document.getElementById("b").onclick = () => { document.getElementById("b").textContent = String(++n) }
  const probe = (f) => { try { return f() } catch { return "blocked" } }
  document.getElementById("parent").textContent = probe(() => parent.document.title ? "leaked" : "leaked")
  document.getElementById("storage").textContent = probe(() => (localStorage.length, "leaked"))
  document.getElementById("cookie").textContent = probe(() => (document.cookie, "leaked"))
  fetch("/api/v1/artifacts").then(() => { document.getElementById("net").textContent = "leaked" }, () => { document.getElementById("net").textContent = "blocked" })
</script>`

/** A board holding one html embed (s_h) and one sticky note (s_n), nothing else. */
async function board(name: string, html = COUNTER) {
  const b = await create("board", name)
  const seeded = await items(b.id)
  await ops(b.id, [
    { type: "remove", ids: seeded.map((s) => s.id) },
    { type: "insert", item: { id: "s_n", kind: "note", x: -300, y: 0, w: 200, h: 140, color: "yellow", text: "Note" } },
    { type: "insert", item: { id: "s_h", kind: "html", x: 0, y: 0, w: 400, h: 300, html, text: "Counter" } },
  ])
  return b
}

/**
 * Open a board at 100% zoom: Playwright maps clicks inside an iframe without the
 * canvas's CSS scale, so frame coordinates only match the page at zoom 1.
 */
async function openBoard(id: string, as: "owner" | "guest" = "owner") {
  const { page, errors } = await open(browser, as)
  await visit(page, `${BASE}/boards/${id}`, page.locator('[data-shape-id="s_h"] iframe'))
  await page.locator('[aria-label="Board canvas"]').focus()
  await page.keyboard.press("Control+0")
  await settle(300)
  const frame = page.frameLocator('[data-shape-id="s_h"] iframe')
  return { page, errors, frame, box: async (shapeId = "s_h") => (await page.locator(`[data-shape-id="${shapeId}"]`).boundingBox())! }
}

const interacting = (page: Page) => page.locator("[data-interacting]").count()

describe("board html embeds", () => {
  test("render in a sandbox that can't reach the app, its storage or the network", async () => {
    const b = await board("html sandbox")
    const { page, errors, frame } = await openBoard(b.id)
    const iframe = page.locator('[data-shape-id="s_h"] iframe')
    assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts", "scripts only: no allow-same-origin, forms, popups or top navigation")
    const doc = (await iframe.getAttribute("srcdoc"))!
    assert.match(doc, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';/, "the CSP comes before anything the snippet can run")
    assert.match(doc, /connect-src 'none'/)
    assert.equal(await frame.locator("#b").textContent(), "0", "the snippet's script ran")
    assert.equal(await frame.locator("#parent").textContent(), "blocked", "can't read parent.document")
    assert.equal(await frame.locator("#storage").textContent(), "blocked", "no localStorage (opaque origin)")
    assert.equal(await frame.locator("#cookie").textContent(), "blocked", "no cookies")
    await eventually(async () => (await frame.locator("#net").textContent()) === "blocked")
    assert.ok(await page.getByText("Counter").isVisible(), "the title shows above the embed")
    assert.deepEqual(errors, [])
  })

  test("drags like a shape until double-clicked; then it's interactive until Esc or a click outside", async () => {
    const b = await board("html interact")
    const { page, errors, frame, box } = await openBoard(b.id)
    const button = async () => mid((await frame.locator("#b").boundingBox())!)

    // Not interacting: a click on the snippet's button selects the shape and doesn't reach the snippet.
    await page.mouse.click((await button()).x, (await button()).y)
    assert.ok(await page.getByRole("button", { name: "Edit HTML" }).isVisible(), "the shape is selected")
    assert.equal(await frame.locator("#b").textContent(), "0")
    assert.equal(await page.locator('[data-shape-id="s_h"] iframe').evaluate((el) => getComputedStyle(el).pointerEvents), "none")

    // ...and dragging it moves it.
    const start = await box()
    await drag(page, mid(start), { x: mid(start).x + 120, y: mid(start).y + 40 })
    const moved = await eventually(async () => {
      const s = await find(b.id, "s_h")
      return s && s.x > 80 && s
    })
    assert.ok(moved.y > 20)
    assert.equal(await frame.locator("#b").textContent(), "0", "the drag didn't click anything inside")

    // Double-click: the frame gets the pointer.
    const now = await box()
    await page.mouse.dblclick(now.x + 20, now.y + now.height - 20)
    assert.equal(await interacting(page), 1)
    assert.ok(await page.getByText("Interacting · Esc to exit").isVisible())
    await page.mouse.click((await button()).x, (await button()).y)
    await eventually(async () => (await frame.locator("#b").textContent()) === "1")
    await page.mouse.click((await button()).x, (await button()).y)
    await eventually(async () => (await frame.locator("#b").textContent()) === "2")
    const before = await find(b.id, "s_h")
    assert.equal(before?.x, moved.x, "clicking inside doesn't move the shape")

    // Esc with focus inside the frame (the frame posts it out).
    await page.keyboard.press("Escape")
    await eventually(async () => (await interacting(page)) === 0)

    // The Interact button works too; a click on empty canvas leaves.
    await page.mouse.click(now.x + 20, now.y + 20)
    await page.getByRole("button", { name: "Interact", exact: true }).click()
    assert.equal(await interacting(page), 1)
    await page.mouse.click(now.x - 40, now.y + now.height + 80)
    assert.equal(await interacting(page), 0)

    // Only one embed is interactive at a time.
    await ops(b.id, [{ type: "insert", item: { id: "s_h2", kind: "html", x: 0, y: 360, w: 300, h: 120, html: "<p>second</p>", text: "Second" } }])
    const second = await page.locator('[data-shape-id="s_h2"]').waitFor().then(() => box("s_h2"))
    await page.mouse.dblclick(now.x + 20, now.y + 20)
    await page.mouse.click(now.x - 40, now.y + now.height + 80)
    await page.mouse.dblclick(second.x + 20, second.y + 20)
    assert.equal(await interacting(page), 1)
    assert.equal(await page.locator('[data-shape-id="s_h2"][data-interacting]').count(), 1)
    assert.deepEqual(errors, [])
  })

  test("Edit HTML saves through the panel and syncs live to another browser", async () => {
    const b = await board("html edit")
    const owner = await openBoard(b.id)
    const other = await openBoard(b.id)
    await owner.page.mouse.click(mid(await owner.box()).x, mid(await owner.box()).y)
    await owner.page.getByRole("button", { name: "Edit HTML" }).click()
    const panel = owner.page.getByRole("dialog", { name: "Edit HTML" })
    const source = panel.getByLabel("HTML source")
    assert.equal(await source.inputValue(), COUNTER)

    await source.fill('<div id="v">')
    await source.press("End")
    await source.press("Tab")
    await source.pressSequentially("version two</div>")
    assert.equal(await source.inputValue(), '<div id="v">  version two</div>', "Tab indents instead of leaving the editor")
    // Canvas shortcuts don't fire while typing (Backspace would delete the shape, "n" would pick the note tool).
    await source.press("Backspace")
    await source.press("n")
    assert.ok(await find(b.id, "s_h"))
    await source.fill('<div id="v">version two</div>')
    await panel.getByLabel("Title").fill("Renamed")
    await panel.getByRole("button", { name: "Save" }).click()

    const saved = await eventually(async () => {
      const s = await find(b.id, "s_h")
      return s?.html === '<div id="v">version two</div>' && s
    })
    assert.equal(saved.text, "Renamed")
    await eventually(async () => (await other.frame.locator("#v").textContent()) === "version two")
    assert.ok(await other.page.getByText("Renamed").isVisible())
    await eventually(async () => (await owner.frame.locator("#v").textContent()) === "version two")

    // An untouched open panel follows someone else's save.
    await ops(b.id, [{ type: "update", id: "s_h", patch: { html: "<p>from agent</p>" } }])
    await eventually(async () => (await source.inputValue()) === "<p>from agent</p>")
    await panel.getByRole("button", { name: "Close" }).click()
    assert.equal(await panel.count(), 0)
    assert.deepEqual(owner.errors, [])
    assert.deepEqual(other.errors, [])
  })

  test("guests see and use embeds but can't edit or add them", viewAsOnly, async () => {
    const b = await board("html guest")
    const { page, errors, frame, box } = await openBoard(b.id, "guest")
    assert.equal(await frame.locator("#b").textContent(), "0")
    await page.mouse.click(mid(await box()).x, mid(await box()).y)
    assert.ok(await page.getByRole("button", { name: "Interact", exact: true }).isVisible())
    assert.equal(await page.getByRole("button", { name: "Edit HTML" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Add HTML embed" }).count(), 0)
    await page.keyboard.press("Enter")
    assert.equal(await page.getByRole("dialog", { name: "Edit HTML" }).count(), 0)

    const at = await box()
    await page.mouse.dblclick(at.x + 20, at.y + 20)
    assert.equal(await interacting(page), 1)
    const button = mid((await frame.locator("#b").boundingBox())!)
    await page.mouse.click(button.x, button.y)
    await eventually(async () => (await frame.locator("#b").textContent()) === "1")

    // Pasting HTML as a guest creates nothing, and the API refuses guest edits.
    await page.mouse.click(at.x - 40, at.y + at.height + 80)
    await paste(page, "<div><h1>nope</h1></div>")
    await settle()
    assert.equal((await items(b.id)).length, 2)
    const denied = await ops(b.id, [{ type: "update", id: "s_h", patch: { html: "<p>x</p>" } }], "guest")
    assert.notEqual(denied.status, 200)
    // The harness's guest init script also runs inside the sandboxed frame, where storage is off limits: more proof of isolation, not an app error.
    assert.deepEqual(errors.filter((e) => !/sandboxed and lacks the 'allow-same-origin' flag/.test(e)), [])
  })

  test("pasting HTML creates an embed; pasting prose doesn't; the toolbar adds a starter", async () => {
    const b = await board("html paste")
    const { page, errors } = await openBoard(b.id)
    await page.locator('[aria-label="Board canvas"]').focus()
    await paste(page, "if a < b and c > d then <maybe>")
    await paste(page, "<b>just bold</b> text")
    await settle()
    assert.equal((await items(b.id)).length, 2, "prose and inline snippets aren't embeds")

    const pasted = "<!doctype html><html><head><title>Pasted chart</title></head><body><svg width=100 height=50><rect width=40 height=50 fill=teal /></svg></body></html>"
    await paste(page, pasted)
    const shape = await eventually(async () => (await items(b.id)).find((s) => s.kind === "html" && s.id !== "s_h"))
    assert.equal(shape.html, pasted)
    assert.equal(shape.text, "Pasted chart")
    await page.locator(`[data-shape-id="${shape.id}"] iframe`).waitFor()
    assert.equal(await page.frameLocator(`[data-shape-id="${shape.id}"] iframe`).locator("rect").count(), 1)

    await page.getByRole("button", { name: "Add HTML embed" }).click()
    const starter = await eventually(async () => (await items(b.id)).find((s) => s.kind === "html" && s.id !== "s_h" && s.id !== shape.id))
    assert.match(starter.html!, /<button/)
    assert.ok(await page.getByRole("dialog", { name: "Edit HTML" }).isVisible(), "the new embed opens in the editor")
    assert.deepEqual(errors, [])
  })

  test("many embeds: only those near the view get a live iframe", async () => {
    const b = await create("board", "html many")
    const seeded = await items(b.id)
    const grid = Array.from({ length: 24 }, (_, i) => ({
      type: "insert",
      item: { id: `s_m${i}`, kind: "html", x: (i % 6) * 340, y: Math.floor(i / 6) * 260, w: 300, h: 220, html: `<h1>${i}</h1>`, text: `Embed ${i}` },
    }))
    await ops(b.id, [{ type: "remove", ids: seeded.map((s) => s.id) }, ...grid])
    const { page, errors } = await open(browser)
    await visit(page, `${BASE}/boards/${b.id}`, page.locator('[data-shape-id="s_m0"]'))
    await settle(500)
    const frames = await page.locator("[data-shape-id] iframe").count()
    assert.ok(frames > 0 && frames <= 12, `at most 12 live frames (got ${frames})`)
    assert.equal(frames + (await page.locator("[data-html-placeholder]").count()), 24, "the rest are placeholders")
    assert.deepEqual(errors, [])
  })

  test("existing boards are unaffected; html rules are enforced", async () => {
    const b = await create("board", "html compat")
    const seeded = await items(b.id)
    // Shapes as stored before html embeds existed, including an old-style arrow (x = y = w = h = 0).
    const old = [
      { id: "s_n", kind: "note", x: 0, y: 0, w: 200, h: 140, color: "yellow", text: "Old note" },
      { id: "s_r", kind: "rect", x: 300, y: 0, w: 160, h: 100, color: "blue", text: "Box" },
      { id: "s_a", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_n", to: "s_r" },
    ]
    await ops(b.id, [{ type: "remove", ids: seeded.map((s) => s.id) }, ...old.map((item) => ({ type: "insert", item }))])
    const before = (await content(b.id)).text
    assert.equal((await ops(b.id, [{ type: "insert", item: { id: "s_h", kind: "html", x: 0, y: 300, w: 400, h: 300, html: "<p>" + "x".repeat(5000) + "</p>", text: "Wide" } }])).status, 200)
    const after = await content(b.id)
    assert.deepEqual(after.state.items.slice(0, 3).map(({ by: _by, ...s }: { by?: string }) => s), old, "existing shapes are untouched")
    assert.equal(after.text, `${before.replace("shapes: 3", "shapes: 4")}\ns_h: html at (0,300) 400x300 "Wide" (5007 chars of HTML)`, "html is summarized, not dumped")

    const reject = async (op: unknown) => assert.notEqual((await ops(b.id, [op])).status, 200, JSON.stringify(op).slice(0, 80))
    await reject({ type: "update", id: "s_n", patch: { html: "<p>x</p>" } })
    await reject({ type: "update", id: "s_n", patch: { kind: "html" } })
    await reject({ type: "update", id: "s_h", patch: { kind: "rect" } })
    await reject({ type: "insert", item: { id: "s_x", kind: "rect", x: 0, y: 0, w: 10, h: 10, html: "<p>x</p>" } })
    await reject({ type: "update", id: "s_h", patch: { html: "x".repeat(200_001) } })
    assert.equal((await items(b.id)).length, 4)

    const { page, errors } = await open(browser)
    await visit(page, `${BASE}/boards/${b.id}`, page.locator('[data-shape-id="s_h"] iframe'))
    assert.equal(await page.locator('[data-shape-id="s_n"]').textContent(), "Old note")
    assert.equal(await page.locator('[data-arrow-id="s_a"]').count(), 1)
    assert.deepEqual(errors, [])
  })
})

describe("html embeds over MCP", () => {
  test("board_add_html places a live embed; board_update replaces its source", async () => {
    const b = await create("board", "html mcp")
    const bin = fileURLToPath(new URL("../../apps/cli/dist/stdartifacts.mjs", import.meta.url))
    const proc = spawn(process.execPath, [bin, "mcp"], { env: { ...process.env, STDARTIFACTS_URL: BASE }, stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    const waiting = new Map<number, (msg: any) => void>()
    proc.stdout.on("data", (d) => {
      buffer += d
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (line.trim()) waiting.get(JSON.parse(line).id)?.(JSON.parse(line))
      }
    })
    let n = 0
    const rpc = (method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = ++n
        waiting.set(id, resolve)
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
        setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
      })
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await rpc("tools/call", { name, arguments: args })
      return { error: r.result?.isError === true || !!r.error, text: r.error?.message ?? r.result.content.map((c: { text: string }) => c.text).join("\n") }
    }
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } })
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      const tools = (await rpc("tools/list", {})).result.tools as Array<{ name: string; inputSchema: unknown }>
      assert.ok(tools.some((t) => t.name === "board_add_html"))
      assert.match(JSON.stringify(tools.find((t) => t.name === "board_update")!.inputSchema), /"html"/)

      const chart = `<svg viewBox="0 0 100 60" width="100%"><rect x="10" y="20" width="20" height="40" fill="#2f6fed"/><rect x="40" y="5" width="20" height="55" fill="#1e9e6a"/></svg>`
      const added = await tool("board_add_html", { artifact: b.id, html: chart, title: "Signups", x: 600, y: 40 })
      assert.equal(added.error, false, added.text)
      const shape = (await items(b.id)).find((s) => s.kind === "html")!
      assert.ok(shape, "the embed was added")
      assert.match(added.text, new RegExp(shape.id))
      assert.deepEqual([shape.x, shape.y, shape.w, shape.h, shape.text, shape.html], [600, 40, 480, 360, "Signups", chart])

      const read = await tool("read_artifact", { artifact: b.id })
      assert.match(read.text, new RegExp(`${shape.id}: html at \\(600,40\\) 480x360 "Signups" \\(${chart.length} chars of HTML\\)`))
      assert.doesNotMatch(read.text, /<svg/)

      const updated = await tool("board_update", { artifact: b.id, shapes: [{ id: shape.id, html: "<h1>v2</h1>", text: "Signups v2" }] })
      assert.equal(updated.error, false, updated.text)
      const after = await eventually(async () => {
        const s = await find(b.id, shape.id)
        return s?.html === "<h1>v2</h1>" && s
      })
      assert.equal(after.text, "Signups v2")

      const tooBig = await tool("board_add_html", { artifact: b.id, html: "x".repeat(200_001) })
      assert.equal(tooBig.error, true)
      const notHtml = await tool("board_update", { artifact: b.id, shapes: [{ id: (await items(b.id)).find((s) => s.kind === "note")!.id, html: "<p>x</p>" }] })
      assert.equal(notHtml.error, true)

      // People see it render.
      const { page, errors } = await open(browser)
      await visit(page, `${BASE}/boards/${b.id}`, page.locator(`[data-shape-id="${shape.id}"] iframe`))
      assert.equal(await page.frameLocator(`[data-shape-id="${shape.id}"] iframe`).locator("h1").textContent(), "v2")
      assert.deepEqual(errors, [])
    } finally {
      proc.kill()
    }
  })
})

/** Paste plain text onto the focused element (the canvas), as a clipboard paste would. */
async function paste(page: Page, text: string) {
  await page.evaluate((t) => {
    const data = new DataTransfer()
    data.setData("text/plain", t)
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}
