import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, cleanup, content, create, drag, eventually, launch, open, ops, presence, settle, viewAsOnly, visit } from "./harness.ts"
import { designToHtml, designTreeError, htmlToDesign, styleError, type DesignTree } from "../../packages/protocol/src/design.ts"

/** Boards: design frames (HTML/CSS-native layers rendered as real DOM) for people and agents. */

type Shape = { id: string; kind: string; x: number; y: number; w: number; h: number; text?: string; html?: string; design?: DesignTree; from?: string; to?: string }

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
const tree = async (id: string, shapeId = "s_d") => (await find(id, shapeId))!.design!

/** A small card: root (flex column) > heading, text, button. */
const CARD: DesignTree = {
  root: "r",
  nodes: {
    r: { id: "r", tag: "div", style: { display: "flex", "flex-direction": "column", gap: "12px", padding: "24px", background: "#f6f7fb" }, children: ["h", "p", "btn"] },
    h: { id: "h", tag: "h1", text: "Hello design", style: { margin: "0", "font-size": "28px" }, children: [] },
    p: { id: "p", tag: "p", text: "Body text", style: { margin: "0", color: "#555555" }, children: [] },
    btn: { id: "btn", tag: "button", text: "Click me", style: { padding: "8px 16px", background: "#2f6fed", color: "#ffffff", border: "0", "border-radius": "8px", "align-self": "flex-start" }, children: [] },
  },
}

/** A board holding one design frame (s_d) and one note (s_n). */
async function board(name: string, design: DesignTree = CARD) {
  const b = await create("board", name)
  const seeded = await items(b.id)
  await ops(b.id, [
    { type: "remove", ids: seeded.map((s) => s.id) },
    { type: "insert", item: { id: "s_n", kind: "note", x: -300, y: 0, w: 200, h: 140, color: "yellow", text: "Note" } },
    { type: "insert", item: { id: "s_d", kind: "design", x: 0, y: 0, w: 420, h: 260, text: "Card", design } },
  ])
  return b
}

async function openBoard(id: string, as: "owner" | "guest" = "owner") {
  const { page, errors } = await open(browser, as, { width: 1400, height: 820 })
  await visit(page, `${BASE}/boards/${id}`, page.locator('[data-shape-id="s_d"] [data-node-id="btn"]'))
  await settle(300)
  const node = (nodeId: string) => page.locator(`[data-shape-id="s_d"] [data-node-id="${nodeId}"]`)
  const at = async (nodeId: string) => {
    const b = (await node(nodeId).boundingBox())!
    return { x: b.x + Math.min(12, b.width / 2), y: b.y + b.height / 2 }
  }
  return { page, errors, node, at }
}

const layers = (page: Page) => page.getByRole("complementary", { name: "Layers" })
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" })
const selectedLayer = (page: Page) => layers(page).locator('[role="treeitem"][aria-selected="true"]').getAttribute("data-layer-id")

describe("design html", () => {
  test("html → nodes → html is stable, keeps structure, styles and mixed text", () => {
    const html = `<style>.card { padding: 24px; border-radius: 14px } h1 { margin: 0 }</style>
      <section class="card" style="display:flex;flex-direction:column;gap:8px">
        <h1>Ship <em>faster</em></h1>
        <p>Read the <a href="https://example.com/docs">docs</a>, then go.</p>
        <img src="https://example.com/a.png" alt="Shot">
        <ul><li>One<li>Two</ul>
        <button type="button">Start &amp; go</button>
      </section>`
    const t1 = htmlToDesign(html)
    assert.equal(designTreeError(t1), undefined)
    const out = designToHtml(t1)
    assert.equal(designToHtml(htmlToDesign(out)), out, "a second round trip changes nothing")
    const root = t1.nodes[t1.root]!
    assert.equal(root.tag, "section")
    assert.deepEqual(root.style, { padding: "24px", "border-radius": "14px", display: "flex", "flex-direction": "column", gap: "8px" }, "<style> rules are inlined, then inline styles win")
    assert.match(out, /<p>Read the <a href="https:\/\/example.com\/docs">docs<\/a>, then go.<\/p>/, "mixed text keeps its spaces and stays inline")
    assert.match(out, /<h1 style="margin: 0">Ship <em>faster<\/em><\/h1>/)
    assert.match(out, /<li>One<\/li>\n\s+<li>Two<\/li>/, "unclosed <li>s are closed")
    assert.match(out, /Start &amp; go/)

    // Ids survive a round trip through HTML with data-node attributes (what agents edit).
    const withIds = designToHtml(t1, { ids: true })
    const t2 = htmlToDesign(withIds)
    assert.deepEqual(Object.keys(t2.nodes).sort(), Object.keys(t1.nodes).sort())
    assert.deepEqual(t2, t1)
  })

  test("a design-system snippet keeps its look: tokens, variants, pseudo-elements, icons and line breaks", () => {
    const html = `<style>
        :root { --ink: #141414; --bg: #fff; --line: #ececea; --r: 10px; --t-md: 14px; --font: "Inter", system-ui, sans-serif }
        * { box-sizing: border-box }
        body { margin: 0; font-family: var(--font); color: var(--ink) }
        .btn { font: inherit; font-size: var(--t-md); border: 1px solid transparent; background: var(--muted, #f1f1ef); border-radius: var(--r) }
        .btn:hover { background: red }
        .btn[data-variant="primary"] { background: var(--ink); color: var(--bg) }
        .btn[data-variant="outline"] { border-color: var(--line); background: var(--bg) !important }
        .btn.wide { background: blue; color: var(--nope) }
        .row > .cell { padding: 4px }
        .row .cell + .cell { border-left: 1px solid var(--line) }
        .row > :first-child { font-weight: 600 }
        .cell:not(.muted) { color: var(--ink) }
        .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor }
        .tag::after { content: " \\2192 " attr(data-to) }
        .kbd { font: 500 11px/1 var(--font) }
        .orb { --h: 220; --c: hsl(var(--h) 36% 54%); background: var(--c); mask: var(--star) center/contain no-repeat; --star: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 0Z'/%3E%3C/svg%3E") }
        .i { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5 }
        .done::after { content: ""; position: absolute; transform: rotate(45deg) }
      </style>
      <div class="app">
        <button class="btn" data-variant="primary"><svg class="i" viewBox="0 0 24 24" onload="x()"><path d="M5 12h14" stroke="var(--bg)"/></svg>Run</button>
        <button class="btn wide" data-variant="outline">Edit</button>
        <div class="row"><span class="cell">a</span><span class="cell muted">b</span><span class="cell">c</span></div>
        <span class="badge">Ready</span><span class="tag" data-to="Merck">OC</span><span class="kbd">K</span>
        <span class="orb" style="--h: 20"></span><span class="done"></span>
        <div class="hmi">VEL 182<br>E-214 <b>PARO</b></div>
      </div>`
    const t = htmlToDesign(html)
    assert.equal(designTreeError(t), undefined)
    const all = Object.values(t.nodes)
    const byText = (text: string) => all.find((n) => n.text === text)!
    const holding = (text: string) => all.find((n) => n.children.some((c) => t.nodes[c]?.text === text))!
    const out = designToHtml(t)
    assert.doesNotMatch(out, /var\(|--|:hover|red|\bclass=/, "nothing unresolved is stored")

    // Tokens are replaced by their values; body's rules land on the root, and font: inherit leaves the family to inheritance.
    assert.deepEqual(t.nodes[t.root]!.style, { margin: "0", "font-family": "Inter, system-ui, sans-serif", color: "#141414" })
    const run = holding("Run")
    assert.deepEqual(run.style, { "box-sizing": "border-box", "font-weight": "inherit", "line-height": "inherit", "font-size": "14px", border: "1px solid transparent", "border-radius": "10px", background: "#141414", color: "#fff" })
    // A later border-color still follows the border it refines; !important beats a more specific rule; an unknown token drops only its own declaration.
    const edit = byText("Edit")
    assert.deepEqual(Object.entries(edit.style!).filter(([k]) => /^(border|background|color)/.test(k)), [["border", "1px solid transparent"], ["border-radius", "10px"], ["border-color", "#ececea"], ["background", "#fff"]])

    // Child, sibling, positional and :not selectors.
    assert.deepEqual(byText("a").style, { "box-sizing": "border-box", padding: "4px", "font-weight": "600", color: "#141414" })
    assert.deepEqual(byText("b").style, { "box-sizing": "border-box", padding: "4px", "border-left": "1px solid #ececea" })
    assert.deepEqual(byText("c").style, { "box-sizing": "border-box", padding: "4px", "border-left": "1px solid #ececea", color: "#141414" })

    // ::before and ::after become layers at the start and end; content text and attr() are read.
    const badge = holding("Ready")
    assert.deepEqual(t.nodes[badge.children[0]!]!.style, { width: "6px", height: "6px", "border-radius": "50%", background: "currentColor" })
    assert.deepEqual(holding("OC").children.map((c) => t.nodes[c]!.text), ["OC", " →Merck"], "a hex escape takes the space that ends it, as in CSS")
    assert.deepEqual(byText("K").style, { "box-sizing": "border-box", "font-style": "normal", "font-weight": "500", "font-size": "11px", "line-height": "1", "font-family": "Inter, system-ui, sans-serif" })
    assert.ok(all.some((n) => n.style?.transform === "rotate(45deg)" && n.style.position === "absolute"), "transforms are kept, clipped to the frame")

    // A custom property set inline feeds the ones computed from it; a readable SVG url() is stored as base64.
    const orb = all.find((n) => n.style?.mask)!
    assert.equal(orb.style!.background, "hsl(20 36% 54%)")
    assert.match(orb.style!.mask!, /^url\(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+\) center\/contain no-repeat$/)
    assert.equal(styleError("mask", orb.style!.mask!), undefined)

    // An inline <svg> becomes an image that paints as it did: stylesheet paint, currentColor and tokens are written in.
    const icon = t.nodes[run.children[0]!]!
    assert.equal(icon.tag, "img")
    assert.deepEqual(icon.style, { "box-sizing": "border-box", width: "16px", height: "16px" })
    assert.equal(
      Buffer.from(icon.attrs!.src!.split(",")[1]!, "base64").toString(),
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="fill:none;stroke:#fff;stroke-width:1.5"><path d="M5 12h14" stroke="#fff"/></svg>',
    )

    // <br> is a line break: the element keeps lines, and writes them back as <br>.
    const hmi = holding("VEL 182\nE-214 ")
    assert.equal(hmi.style!["white-space"], "pre-line")
    assert.match(out, /white-space: pre-line">VEL 182<br>E-214 <strong/)
    assert.equal(designToHtml(htmlToDesign(out)), out, "a second round trip changes nothing")
  })

  test("hostile input: scripts, handlers, javascript: urls, CSS exfiltration and escapes are dropped", () => {
    const hostile = `<div onclick="steal()" style="position: fixed; top: 0; inset: 0; z-index: 99999; background: url(https://ok.example/bg.png); color: red">
      <script>fetch("/api/v1/artifacts")</script><style>@import url(https://evil.example/x.css); div { background: url(http://evil.example/beacon) }</style>
      <a href="javascript:alert(1)" onmouseover="x()">bad link</a>
      <a href="https://ok.example">good link</a>
      <img src="x" onerror="alert(1)"><img src="http://evil.example/a.png"><img src="data:image/png;base64,iVBORw0KGgo=" alt="ok">
      <p style="background-image: url('javascript:alert(1)'); width: expression(alert(1)); color: var(--secret)">p1</p>
      <p style="background: url(//evil.example/x); border: 1px solid \\72 ed; font-family: 'Comic Sans', Arial">p2</p>
      <p style="background: url(/api/v1/artifacts); -moz-binding: url(x); behavior: url(x.htc)">p3</p>
      <iframe src="https://evil.example"></iframe><object data="x"></object><svg><script>alert(1)</script></svg><form action="https://evil.example"><input name="q" placeholder="Search" onfocus="x()"></form>
      <template><img src=x onerror=alert(1)></template><!-- <script>alert(1)</script> -->
    </div>`
    const t = htmlToDesign(hostile)
    assert.equal(designTreeError(t), undefined)
    const out = designToHtml(t)
    for (const bad of [/script/i, /\bon\w+=/i, /javascript:/i, /fixed/, /http:\/\//, /evil/, /expression/, /var\(/, /@import/, /iframe|object|<svg|template/i, /\\/, /Comic/, /behavior|binding/, /\/api\//])
      assert.doesNotMatch(out, bad, `no ${bad}`)
    assert.match(out, /background: url\(https:\/\/ok.example\/bg.png\)/, "https images are allowed")
    assert.match(out, /<a href="https:\/\/ok.example">good link<\/a>/)
    assert.match(out, /<a>bad link<\/a>/, "the bad link keeps its text, not its href")
    assert.match(out, /src="data:image\/png;base64,iVBORw0KGgo="/)
    assert.match(out, /font-family: Arial/, "unsafe fonts are dropped from a stack")
    assert.match(out, /<input placeholder="Search">/, "the input keeps only allowed attributes (and the form loses its action)")
    assert.doesNotMatch(out, /z-index/, "an out-of-range z-index is dropped")
    // An inline <svg> becomes an image, which can't run anything; its script is gone all the same.
    const svg = Buffer.from(/src="data:image\/svg\+xml;base64,([^"]+)"/.exec(out)![1]!, "base64").toString()
    assert.equal(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

    for (const [prop, value] of [
      ["position", "fixed"],
      ["background", "url(http://x.example/a.png)"],
      ["background", "url(javascript:alert(1))"],
      ["background", "url(https://x.example/a.png) ; color: red"],
      ["width", "expression(alert(1))"],
      ["color", "var(--x)"],
      ["color", "red !important"],
      ["color", "\\72 ed"],
      ["color", "red /* x */"],
      ["background", "image-set(url(https://x.example/a.png) 1x)"],
      ["list-style", "url(https://x.example/a.png)"],
      ["behavior", "url(x.htc)"],
    ])
      assert.ok(styleError(prop!, value!), `${prop}: ${value} is rejected`)
  })
})

describe("design ops", () => {
  test("concurrent edits to different layers (and different properties of one layer) all land", async () => {
    const b = await board("design concurrent")
    // Two writers at once, as two people editing different layers would.
    const results = await Promise.all([
      ops(b.id, [{ type: "designNode", shape: "s_d", node: "h", patch: { text: "From A", style: { color: "#111111" } } }]),
      ops(b.id, [{ type: "designNode", shape: "s_d", node: "btn", patch: { text: "From B" } }]),
      ops(b.id, [{ type: "designNode", shape: "s_d", node: "h", patch: { style: { "font-size": "32px" } } }]),
      ops(b.id, [{ type: "designInsert", shape: "s_d", parent: "r", root: "new", nodes: [{ id: "new", tag: "p", text: "Inserted", children: [] }] }]),
    ])
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body))
    const t = await tree(b.id)
    assert.equal(t.nodes.h!.text, "From A")
    assert.deepEqual(t.nodes.h!.style, { margin: "0", "font-size": "32px", color: "#111111" }, "per-property merge")
    assert.equal(t.nodes.btn!.text, "From B")
    assert.deepEqual(t.nodes.r!.children, ["h", "p", "btn", "new"])

    // Move, remove (with descendants), and removing what someone else already removed is fine.
    assert.equal((await ops(b.id, [{ type: "designMove", shape: "s_d", id: "btn", parent: "r", index: 0 }])).status, 200)
    assert.equal((await ops(b.id, [{ type: "designRemove", shape: "s_d", ids: ["new"] }, { type: "designRemove", shape: "s_d", ids: ["new"] }])).status, 200)
    assert.deepEqual((await tree(b.id)).nodes.r!.children, ["btn", "h", "p"])
    // Style null removes a property; text null removes the text.
    await ops(b.id, [{ type: "designNode", shape: "s_d", node: "p", patch: { style: { color: null }, text: null } }])
    const p = (await tree(b.id)).nodes.p!
    assert.deepEqual([p.style, p.text], [{ margin: "0" }, undefined])

    const reject = async (op: unknown, why: string) => assert.notEqual((await ops(b.id, [op])).status, 200, why)
    await reject({ type: "designNode", shape: "s_d", node: "h", patch: { style: { position: "fixed" } } }, "position: fixed")
    await reject({ type: "designNode", shape: "s_d", node: "h", patch: { style: { background: "url(http://evil.example/x)" } } }, "http url")
    await reject({ type: "designNode", shape: "s_d", node: "h", patch: { attrs: { onclick: "x()" } } }, "event handler attr")
    await reject({ type: "designNode", shape: "s_d", node: "btn", patch: { attrs: { href: "https://x.example" } } }, "href on a button")
    await reject({ type: "designInsert", shape: "s_d", parent: "r", root: "a", nodes: [{ id: "a", tag: "a", attrs: { href: "javascript:alert(1)" }, text: "x", children: [] }] }, "javascript: href")
    await reject({ type: "designInsert", shape: "s_d", parent: "r", root: "s", nodes: [{ id: "s", tag: "script", text: "alert(1)", children: [] }] }, "script tag")
    await reject({ type: "designInsert", shape: "s_d", parent: "h", root: "x", nodes: [{ id: "x", tag: "span", text: "x", children: [] }] }, "into a text layer")
    await reject({ type: "designInsert", shape: "s_d", parent: "r", root: "p", nodes: [{ id: "p", tag: "p", text: "dup", children: [] }] }, "duplicate id")
    await reject({ type: "designMove", shape: "s_d", id: "r", parent: "h", index: 0 }, "moving the root")
    await reject({ type: "designRemove", shape: "s_d", ids: ["r"] }, "removing the root")
    await reject({ type: "designNode", shape: "s_n", node: "h", patch: { text: "x" } }, "design op on a note")
    assert.deepEqual((await tree(b.id)).nodes.r!.children, ["btn", "h", "p"])
  })

  test("existing shapes, embeds and arrows are unaffected; design rules are enforced", async () => {
    const b = await create("board", "design compat")
    const seeded = await items(b.id)
    const old = [
      { id: "s_n", kind: "note", x: 0, y: 0, w: 200, h: 140, color: "yellow", text: "Old note" },
      { id: "s_r", kind: "rect", x: 300, y: 0, w: 160, h: 100, color: "blue", text: "Box" },
      { id: "s_a", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_n", to: "s_r" },
      { id: "s_h", kind: "html", x: 0, y: 300, w: 300, h: 200, html: "<p>embed</p>", text: "Embed" },
    ]
    await ops(b.id, [{ type: "remove", ids: seeded.map((s) => s.id) }, ...old.map((item) => ({ type: "insert", item }))])
    const before = (await content(b.id)).text
    assert.equal((await ops(b.id, [{ type: "insert", item: { id: "s_d", kind: "design", x: 600, y: 0, w: 420, h: 260, text: "Card", design: CARD } }])).status, 200)
    await ops(b.id, [{ type: "designNode", shape: "s_d", node: "h", patch: { text: "Changed" } }])
    const after = await content(b.id)
    assert.deepEqual(after.state.items.slice(0, 4).map(({ by: _by, ...s }: { by?: string }) => s), old, "existing shapes are untouched")
    assert.equal(after.text, `${before.replace("shapes: 4", "shapes: 5")}\ns_d: design at (600,0) 420x260 "Card" (4 layers; read it with board_get_design)`)

    const reject = async (op: unknown) => assert.notEqual((await ops(b.id, [op])).status, 200, JSON.stringify(op).slice(0, 100))
    await reject({ type: "update", id: "s_n", patch: { design: CARD } })
    await reject({ type: "update", id: "s_n", patch: { kind: "design" } })
    await reject({ type: "update", id: "s_d", patch: { kind: "html" } })
    await reject({ type: "insert", item: { id: "s_x", kind: "rect", x: 0, y: 0, w: 10, h: 10, design: CARD } })
    await reject({ type: "insert", item: { id: "s_x", kind: "design", x: 0, y: 0, w: 10, h: 10 } })
    // Malformed trees: a cycle, an orphan, a missing root, oversized content.
    const cyc = { root: "r", nodes: { r: { id: "r", tag: "div", children: ["a"] }, a: { id: "a", tag: "div", children: ["r"] } } }
    const orphan = { root: "r", nodes: { r: { id: "r", tag: "div", children: [] }, a: { id: "a", tag: "div", children: [] } } }
    const big = { root: "r", nodes: { r: { id: "r", tag: "div", children: Array.from({ length: 40 }, (_, i) => `p${i}`) }, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, { id: `p${i}`, tag: "p", text: "x".repeat(6000), children: [] }])) } }
    for (const design of [cyc, orphan, { root: "zz", nodes: {} }, big]) await reject({ type: "update", id: "s_d", patch: { design } })
    assert.equal((await items(b.id)).length, 5)

    const { page, errors } = await open(browser)
    await visit(page, `${BASE}/boards/${b.id}`, page.locator('[data-shape-id="s_d"] [data-node-id="h"]'))
    assert.equal(await page.locator('[data-shape-id="s_n"]').textContent(), "Old note")
    assert.equal(await page.locator('[data-arrow-id="s_a"]').count(), 1)
    assert.equal(await page.locator('[data-shape-id="s_h"] iframe').count(), 1, "embeds stay sandboxed iframes")
    assert.equal(await page.locator('[data-shape-id="s_d"] iframe').count(), 0, "designs are real DOM")
    assert.equal(await page.locator('[data-shape-id="s_d"] [data-node-id="h"]').textContent(), "Changed")
    assert.deepEqual(errors, [])
  })
})

describe("design frames in the browser", () => {
  test("double-click enters and selects the deepest layer; the inspector edits sync to another browser; Esc goes up", async () => {
    const b = await board("design inspector")
    const owner = await openBoard(b.id)
    const other = await openBoard(b.id)
    const { page } = owner

    // One click selects the frame, not a layer.
    await page.mouse.click((await owner.at("btn")).x, (await owner.at("btn")).y)
    assert.equal(await layers(page).count(), 0)
    assert.ok(await page.getByRole("button", { name: "Edit design" }).isVisible())

    // A double-click enters and picks the button (the deepest layer under the pointer), without moving the camera.
    const placed = await page.locator('[data-shape-id="s_d"]').boundingBox()
    await page.mouse.dblclick((await owner.at("btn")).x, (await owner.at("btn")).y)
    await layers(page).waitFor()
    assert.equal(await selectedLayer(page), "btn")
    assert.deepEqual(await page.locator('[data-shape-id="s_d"]').boundingBox(), placed)
    assert.equal(await page.locator('[data-layer-outline="selected"]').count(), 1)
    assert.match((await page.locator('[data-layer-outline="selected"]').textContent())!, /button · Click me/)

    // Fill and text from the inspector.
    const bg = inspector(page).getByLabel("Background", { exact: true })
    assert.equal(await bg.inputValue(), "#2f6fed")
    await bg.fill("#e5484d")
    await bg.press("Enter")
    await inspector(page).getByLabel("Text content").fill("Buy now")
    await inspector(page).getByLabel("Text content").blur()
    // Invalid values are refused, not sent.
    await inspector(page).getByLabel("Width", { exact: true }).fill("expression(alert(1))")
    await inspector(page).getByLabel("Width", { exact: true }).press("Enter")
    assert.equal(await inspector(page).getByLabel("Width", { exact: true }).getAttribute("aria-invalid"), "true")

    const t = await eventually(async () => {
      const t = await tree(b.id)
      return t.nodes.btn!.text === "Buy now" && t.nodes.btn!.style!.background === "#e5484d" && t
    })
    assert.equal(t.nodes.btn!.style!.width, undefined)
    await eventually(async () => (await other.node("btn").textContent()) === "Buy now")
    await eventually(async () => (await other.node("btn").evaluate((el) => getComputedStyle(el).backgroundColor)) === "rgb(229, 72, 77)")
    // The other person sees which layer the owner has selected, in the owner's color.
    await other.page.locator('[data-layer-outline="remote"]').waitFor()

    // Esc: the field gives the keyboard back to the canvas; then up to the parent, then out of the frame.
    await inspector(page).getByLabel("Width", { exact: true }).press("Escape")
    await page.keyboard.press("Escape")
    await eventually(async () => (await selectedLayer(page)) === "r")
    await page.keyboard.press("Escape")
    await eventually(async () => (await layers(page).count()) === 0)
    assert.ok(await find(b.id, "s_d"), "Esc never deletes or leaves the frame broken")
    assert.deepEqual(owner.errors, [])
    assert.deepEqual(other.errors, [])
  })

  test("text edits in place; layers reorder by drag; add, duplicate, wrap and delete layers", async () => {
    const b = await board("design layers")
    const { page, errors, at, node } = await openBoard(b.id)
    await page.mouse.dblclick((await at("h")).x, (await at("h")).y)
    await layers(page).waitFor()
    assert.equal(await selectedLayer(page), "h")
    const h = await at("h")
    // Double-click a selected text layer: edit it right on the canvas.
    await page.mouse.dblclick(h.x, h.y)
    await page.locator('[data-node-id="h"][contenteditable]').waitFor()
    await page.keyboard.type("Typed in place")
    // Canvas shortcuts don't fire while typing (Backspace would delete the layer).
    await page.keyboard.press("Backspace")
    await page.keyboard.press("Enter")
    await eventually(async () => (await tree(b.id)).nodes.h!.text === "Typed in plac")
    assert.equal(await node("h").getAttribute("contenteditable"), null)
    // Escape cancels an in-place edit.
    await page.mouse.dblclick(h.x, h.y)
    await page.keyboard.type("nope")
    await page.keyboard.press("Escape")
    await settle()
    assert.equal((await tree(b.id)).nodes.h!.text, "Typed in plac")
    assert.equal(await node("h").textContent(), "Typed in plac")

    // Drag the button's row above the heading's.
    const row = (id: string) => layers(page).locator(`[data-layer-id="${id}"]`)
    const from = (await row("btn").boundingBox())!
    const to = (await row("h").boundingBox())!
    await drag(page, { x: from.x + 60, y: from.y + from.height / 2 }, { x: to.x + 60, y: to.y + 3 })
    await eventually(async () => (await tree(b.id)).nodes.r!.children.join() === "btn,h,p")
    assert.equal(await node("r").evaluate((el) => [...el.children].map((c) => c.getAttribute("data-node-id")).join()), "btn,h,p", "the canvas follows")

    // Add a text layer into the root, then duplicate, wrap and delete it.
    await layers(page).locator('[data-layer-id="r"]').click()
    await page.getByRole("button", { name: "Add text" }).click()
    const added = await eventually(async () => (await tree(b.id)).nodes.r!.children[3])
    assert.equal((await tree(b.id)).nodes[added]!.text, "Text")
    assert.equal(await selectedLayer(page), added)
    await page.getByRole("button", { name: "Duplicate layer" }).click()
    await eventually(async () => (await tree(b.id)).nodes.r!.children.length === 5)
    await page.getByRole("button", { name: "Wrap in frame" }).click()
    const wrapped = await eventually(async () => {
      const t = await tree(b.id)
      const w = t.nodes.r!.children[4]
      return w && t.nodes[w]!.tag === "div" && t.nodes[w]!.children.length === 1 && t
    })
    assert.equal(Object.keys(wrapped.nodes).length, 7)
    await page.locator('[aria-label="Board canvas"]').focus()
    await page.keyboard.press("Delete")
    await eventually(async () => (await tree(b.id)).nodes.r!.children.length === 4)
    // Delete on the root layer does nothing (the frame is removed from outside, like any shape).
    await layers(page).locator('[data-layer-id="r"]').click()
    await page.keyboard.press("Delete")
    await settle()
    assert.ok(await find(b.id, "s_d"))

    // Copy HTML exports the frame.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.getByRole("button", { name: "Copy HTML" }).click()
    const copied = await eventually(() => page.evaluate(() => navigator.clipboard.readText()))
    assert.match(copied, /^<div style="display: flex; flex-direction: column;[^"]*">\n  <button /)
    assert.deepEqual(errors, [])
  })

  test("on the canvas, Figma-style: entering keeps the camera still, ⌘-click reaches deep, drags reorder, arrows reorder, empty double-click adds nothing", async () => {
    const ROW: DesignTree = {
      root: "r",
      nodes: {
        r: { id: "r", tag: "div", style: { display: "flex", "flex-direction": "column", gap: "12px", padding: "24px" }, children: ["h", "row", "btn"] },
        h: { id: "h", tag: "h1", text: "Title", style: { margin: "0" }, children: [] },
        row: { id: "row", tag: "div", style: { display: "flex", gap: "12px" }, children: ["a", "c"] },
        a: { id: "a", tag: "div", style: { flex: "1", padding: "16px", border: "1px solid #ddd" }, children: ["at"] },
        at: { id: "at", tag: "p", text: "Card A", style: { margin: "0" }, children: [] },
        c: { id: "c", tag: "div", style: { flex: "1", padding: "16px", border: "1px solid #ddd" }, children: ["ct"] },
        ct: { id: "ct", tag: "p", text: "Card C", style: { margin: "0" }, children: [] },
        btn: { id: "btn", tag: "button", text: "Go", style: { "align-self": "flex-start" }, children: [] },
      },
    }
    const b = await board("design figma", ROW)
    const { page, errors, at } = await openBoard(b.id)
    const before = await at("h")
    await page.mouse.dblclick(before.x, before.y)
    await layers(page).waitFor()
    // Nothing moved under the pointer, so the next double-click edits what was clicked.
    assert.deepEqual(await at("h"), before)
    await page.mouse.dblclick(before.x, before.y)
    await page.locator('[data-node-id="h"][contenteditable]').waitFor()
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await eventually(async () => (await layers(page).count()) === 0)

    // ⌘-click from outside picks the deepest layer; Esc goes up to its card.
    const ct = await at("ct")
    await page.keyboard.down("Meta")
    await page.mouse.click(ct.x, ct.y)
    await page.keyboard.up("Meta")
    await eventually(async () => (await selectedLayer(page)) === "ct")
    await page.keyboard.press("Escape")
    assert.equal(await selectedLayer(page), "c")

    // Dragging card C over card A reorders the row, with a drop line while dragging.
    const a = await at("a")
    await page.mouse.move(ct.x, ct.y)
    await page.mouse.down()
    await page.mouse.move(a.x - 4, a.y, { steps: 8 })
    assert.equal(await page.locator("[data-layer-drop]").count(), 1)
    await page.mouse.up()
    await eventually(async () => (await tree(b.id)).nodes.row!.children.join() === "c,a")
    assert.equal(await page.locator("[data-layer-drop]").count(), 0)

    // Arrow keys reorder a layer in a flow.
    const btn = await at("btn")
    await page.mouse.click(btn.x, btn.y)
    await page.keyboard.press("ArrowUp")
    await eventually(async () => (await tree(b.id)).nodes.r!.children.join() === "h,btn,row")

    // Double-clicking empty canvas leaves the board as it was.
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await eventually(async () => (await layers(page).count()) === 0)
    const count = (await items(b.id)).length
    const placed = (await page.locator('[data-shape-id="s_d"]').boundingBox())!
    await page.mouse.dblclick(placed.x + placed.width + 160, placed.y + 40)
    await settle(500)
    assert.equal((await items(b.id)).length, count)

    // Entering from the keyboard (or the toolbar) pans the frame clear of the panels.
    await page.mouse.click(before.x, before.y)
    await page.keyboard.press("Enter")
    await layers(page).waitFor()
    await settle(200)
    const [frame, left, right] = await Promise.all([page.locator('[data-shape-id="s_d"]').boundingBox(), layers(page).boundingBox(), inspector(page).boundingBox()])
    assert.ok(frame!.x >= left!.x + left!.width && frame!.x + frame!.width <= right!.x, "the frame sits between the panels")
    assert.deepEqual(errors, [])
  })

  test("free placement: ⌘-drag lifts a layer out of auto layout; Place and Children switch between Auto layout and Free", async () => {
    const b = await board("design free")
    const { page, errors, at, node } = await openBoard(b.id)
    const btn = await at("btn")
    await page.mouse.dblclick(btn.x, btn.y)
    await layers(page).waitFor()
    const heading = (await node("h").boundingBox())!

    // ⌘ held while dragging: placed where it's dropped, the rest of the column stays put.
    await page.mouse.move(btn.x, btn.y)
    await page.mouse.down()
    await page.keyboard.down("Meta")
    await page.mouse.move(btn.x + 160, btn.y + 20, { steps: 8 })
    assert.equal(await page.locator('[data-layer-hint="free"]').count(), 1)
    assert.equal(await page.locator("[data-layer-drop]").count(), 0, "no reorder line while placing freely")
    await page.mouse.up()
    await page.keyboard.up("Meta")
    const placed = await eventually(async () => ((await tree(b.id)).nodes.btn!.style?.position === "absolute" ? (await tree(b.id)) : null))
    assert.equal(placed.nodes.r!.style?.position, "relative", "the parent becomes the positioning box")
    assert.equal(placed.nodes.btn!.style?.margin, "0")
    const moved = (await node("btn").boundingBox())!
    assert.ok(Math.abs(moved.x - (btn.x - 12 + 160)) <= 2 && Math.abs(moved.y + moved.height / 2 - (btn.y + 20)) <= 2, "lands where it was dropped")
    assert.deepEqual(await node("h").boundingBox(), heading)

    // A free layer drags without ⌘; Place → Auto layout puts it back in the column.
    const place = inspector(page).getByRole("radiogroup", { name: "Place" })
    assert.equal(await place.getByRole("radio", { checked: true }).textContent(), "Free")
    await place.getByText("Auto layout").click()
    await eventually(async () => (await tree(b.id)).nodes.btn!.style?.position === undefined)

    // Children → Free pins every child where it is (nothing moves) and keeps the container's height.
    const before = await Promise.all(["h", "p", "btn"].map(async (id) => (await node(id).boundingBox())!))
    await layers(page).locator('[data-layer-id="r"]').click()
    await inspector(page).getByRole("radiogroup", { name: "Children" }).getByText("Free").click()
    await eventually(async () => ["h", "p", "btn"].every((id) => tree(b.id).then((t) => t.nodes[id]!.style?.position === "absolute")))
    await settle(200)
    const after = await Promise.all(["h", "p", "btn"].map(async (id) => (await node(id).boundingBox())!))
    for (const [i, r] of after.entries()) assert.ok(Math.abs(r.x - before[i]!.x) <= 1 && Math.abs(r.y - before[i]!.y) <= 1 && Math.abs(r.width - before[i]!.width) <= 1.5, `child ${i} stays put`)
    assert.match((await tree(b.id)).nodes.r!.style?.height ?? "", /^\d+px$/)
    assert.equal(await inspector(page).getByRole("radiogroup", { name: "Direction" }).count(), 0, "flow settings hide while children are free")
    await inspector(page).getByRole("radiogroup", { name: "Children" }).getByText("Auto layout").click()
    await eventually(async () => ["h", "p", "btn"].every((id) => tree(b.id).then((t) => t.nodes[id]!.style?.position === undefined)))
    assert.deepEqual(errors, [])
  })

  test("guests can select layers and read the inspector, but not edit", viewAsOnly, async () => {
    const b = await board("design guest")
    const { page, errors, at, node } = await openBoard(b.id, "guest")
    await page.mouse.dblclick((await at("p")).x, (await at("p")).y)
    await layers(page).waitFor()
    assert.equal(await selectedLayer(page), "p")
    assert.equal(await inspector(page).getByLabel("Text content").inputValue(), "Body text")
    assert.equal(await inspector(page).getByLabel("Text content").getAttribute("readonly"), "")
    assert.equal(await inspector(page).getByLabel("Width", { exact: true }).getAttribute("readonly"), "")
    for (const name of ["Add text", "Delete layer", "Add design frame", "Move layer up"]) assert.equal(await page.getByRole("button", { name }).count(), 0, name)
    assert.ok(await page.getByRole("button", { name: "Copy layer HTML" }).isVisible(), "guests can copy the selected layer")
    // No in-place editing, and keys don't change anything.
    await page.mouse.dblclick((await at("p")).x, (await at("p")).y)
    assert.equal(await node("p").getAttribute("contenteditable"), null)
    await page.keyboard.press("Delete")
    await settle()
    assert.deepEqual(await tree(b.id), CARD)
    const denied = await ops(b.id, [{ type: "designNode", shape: "s_d", node: "p", patch: { text: "x" } }], "guest")
    assert.notEqual(denied.status, 200)
    assert.deepEqual(errors, [])
  })

  test("the toolbar adds a starter; pasted HTML offers a design frame; ⌘⇧V pastes one, sanitized", async () => {
    const b = await board("design paste")
    const { page, errors } = await openBoard(b.id)
    await page.getByRole("button", { name: "Add design frame" }).click()
    const starter = await eventually(async () => (await items(b.id)).find((s) => s.kind === "design" && s.id !== "s_d"))
    assert.match(designToHtml(starter.design!), /<h2[^>]*>Design frame<\/h2>/)
    await layers(page).waitFor()
    await page.getByRole("button", { name: "Done" }).click()

    // A plain paste still makes an embed (as before) and offers to make it a design.
    await page.locator('[aria-label="Board canvas"]').focus()
    await paste(page, `<div style="padding:20px"><h1>Pasted</h1><script>document.title="x"</script></div>`)
    const embed = await eventually(async () => (await items(b.id)).find((s) => s.kind === "html"))
    await page.getByRole("button", { name: "Make it a design frame" }).click()
    const converted = await eventually(async () => {
      const all = await items(b.id)
      return !all.some((s) => s.id === embed.id) && all.find((s) => s.kind === "design" && s.text === "Pasted")
    })
    assert.deepEqual([converted.x, converted.y, converted.w, converted.h], [embed.x, embed.y, embed.w, embed.h])
    assert.equal(designToHtml(converted.design!), `<div style="padding: 20px">\n  <h1>Pasted</h1>\n</div>`)

    // ⌘⇧V (or Ctrl+Shift+V) goes straight to a design; hostile markup never reaches the page.
    await page.getByRole("button", { name: "Done" }).click()
    await page.locator('[aria-label="Board canvas"]').focus()
    const hostile = `<section style="position:fixed;inset:0;z-index:9999;background:url(http://evil.example/b)"><img src="x" onerror="window.__pwned=1"><a href="javascript:window.__pwned=1">x</a><p onclick="window.__pwned=1" style="color:red">Hostile</p><script>window.__pwned=1</script><iframe src="https://example.com"></iframe></section>`
    await page.locator('[aria-label="Board canvas"]').dispatchEvent("keydown", { key: "v", metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true })
    await paste(page, hostile)
    const pasted = await eventually(async () => (await items(b.id)).find((s) => s.kind === "design" && s.text !== "Pasted" && s.id !== "s_d" && s.id !== starter.id))
    assert.equal(designTreeError(pasted.design!), undefined)
    const html = designToHtml(pasted.design!)
    assert.doesNotMatch(html, /fixed|evil|onerror|onclick|javascript|script|iframe/)
    const frame = page.locator(`[data-shape-id="${pasted.id}"]`)
    await frame.locator("p").waitFor()
    assert.equal(await frame.locator("p").textContent(), "Hostile")
    assert.equal(await frame.locator("script, iframe, [onerror], [onclick], [href]").count(), 0)
    assert.equal(await page.evaluate(() => "__pwned" in window), false)
    assert.deepEqual(errors, [])
  })
})

describe("design frames over MCP", () => {
  test("board_add_design, board_get_design and board_update_design; people see the agent's layer", async () => {
    const b = await create("board", "design mcp")
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
      const tools = (await rpc("tools/list", {})).result.tools as Array<{ name: string }>
      for (const name of ["board_add_design", "board_get_design", "board_update_design"]) assert.ok(tools.some((t) => t.name === name), name)

      const hero = `<section style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:48px;background:#0f172a;color:#f8fafc;text-align:center">
        <h1 style="margin:0;font-size:40px">Ship together</h1>
        <p style="margin:0;color:#94a3b8">People and agents on one canvas.</p>
        <button style="padding:12px 20px;border:0;border-radius:10px;background:#38bdf8;color:#0f172a;font-weight:700" onclick="steal()">Get started</button>
        <script>steal()</script>
      </section>`
      const added = await tool("board_add_design", { artifact: b.id, html: hero, title: "Hero", x: 0, y: 0, w: 640, h: 360 })
      assert.equal(added.error, false, added.text)
      const shape = (await items(b.id)).find((s) => s.kind === "design")!
      assert.match(added.text, new RegExp(`Added design frame ${shape.id}`))
      assert.deepEqual([shape.x, shape.y, shape.w, shape.h, shape.text], [0, 0, 640, 360, "Hero"])
      assert.doesNotMatch(JSON.stringify(shape.design), /steal|script|onclick/)

      const got = await tool("board_get_design", { artifact: b.id, shape: shape.id })
      const t = shape.design!
      const button = Object.values(t.nodes).find((x) => x.tag === "button")!
      const heading = Object.values(t.nodes).find((x) => x.tag === "h1")!
      assert.match(got.text, new RegExp(`${button.id} <button> "Get started"`))
      assert.match(got.text, new RegExp(`data-node="${heading.id}"`))

      // A person is watching while the agent edits one layer.
      const { page, errors } = await open(browser)
      await visit(page, `${BASE}/boards/${b.id}`, page.locator(`[data-node-id="${button.id}"]`))
      const patched = await tool("board_update_design", {
        artifact: b.id,
        shape: shape.id,
        patches: [{ node: button.id, text: "Start free", style: { background: "#22c55e", "font-weight": null } }],
        insert: [{ parent: t.root, html: "<small style='color:#64748b'>No card needed</small>" }],
      })
      assert.equal(patched.error, false, patched.text)
      const t2 = await tree(b.id, shape.id)
      assert.equal(t2.nodes[button.id]!.text, "Start free")
      assert.deepEqual(t2.nodes[button.id]!.style, { padding: "12px 20px", border: "0", "border-radius": "10px", background: "#22c55e", color: "#0f172a" })
      const small = t2.nodes[t2.nodes[t2.root]!.children.at(-1)!]!
      assert.deepEqual([small.tag, small.text], ["small", "No card needed"])
      await page.locator(`[data-node-id="${button.id}"]`).filter({ hasText: "Start free" }).waitFor()
      // The agent's edited layer is outlined in its color, labelled with its name.
      await page.locator('[data-layer-outline="remote"]').waitFor()

      // Replacing from HTML with data-node ids keeps the ids.
      const html = (await tool("board_get_design", { artifact: b.id, shape: shape.id })).text.split("HTML:\n")[1]!
      const replaced = await tool("board_update_design", { artifact: b.id, shape: shape.id, html: html.replace("Ship together", "Build together") })
      assert.equal(replaced.error, false, replaced.text)
      const t3 = await tree(b.id, shape.id)
      assert.equal(t3.nodes[heading.id]!.text, "Build together")
      assert.deepEqual(Object.keys(t3.nodes).sort(), Object.keys(t2.nodes).sort())

      const bad = await tool("board_update_design", { artifact: b.id, shape: shape.id, patches: [{ node: button.id, style: { position: "fixed" } }] })
      assert.equal(bad.error, true)
      assert.match(bad.text, /position: fixed/)
      const notDesign = await tool("board_get_design", { artifact: b.id, shape: "s_nope" })
      assert.equal(notDesign.error, true)
      assert.deepEqual(errors, [])
    } finally {
      proc.kill()
    }
  })

  test("agent presence on a layer shows to people in the agent's color", async () => {
    const b = await board("design presence")
    const { page, errors } = await openBoard(b.id)
    await presence(b.id, "e2e-design", { status: "Restyling", selection: ["s_d"], design: { shape: "s_d", node: "btn" } })
    const outline = page.locator('[data-layer-outline="remote"]')
    await outline.waitFor()
    const [box, btn] = [(await outline.boundingBox())!, (await page.locator('[data-node-id="btn"]').boundingBox())!]
    assert.ok(Math.abs(box.x - btn.x) < 2 && Math.abs(box.width - btn.width) < 2, "the outline sits on the agent's layer")
    await presence(b.id, "e2e-design", {}, 0)
    await eventually(async () => (await outline.count()) === 0)
    assert.deepEqual(errors, [])
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
