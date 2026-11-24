import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { BASE, cleanup, content, create, drag, eventually, launch, open, ops, presence, settle, viewAsOnly, visit } from "./harness.ts"

/** Two browsers per surface: an owner who edits and a guest who must stay read-only. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

describe("table", () => {
  test("edits sync live, guests are read-only, kanban drag, record panel", viewAsOnly, async () => {
    const t = await create("table", "ui table")
    const seeded = await content(t.id)
    const [name, , status] = seeded.state.columns
    await ops(t.id, [
      // The citation sits on Name: moving the card rewrites Status, and a new value drops the old value's sources.
      { type: "setCell", rowId: seeded.state.rowIds[0], colId: name.id, value: "Ramp", sources: ["https://ramp.com/about"] },
      { type: "setCell", rowId: seeded.state.rowIds[0], colId: status.id, value: "Lead" },
    ])
    // Wide enough that all five kanban lanes (four options + "No status") fit without scrolling.
    const owner = await open(browser, "owner", { width: 1920, height: 800 })
    const guest = await open(browser, "guest")
    await visit(owner.page, `${BASE}/tables/${t.id}`, owner.page.getByRole("gridcell").first())
    await visit(guest.page, `${BASE}/tables/${t.id}`, guest.page.getByRole("gridcell").first())

    // Owner types into row 2; guest sees it.
    await owner.page.getByRole("row").nth(2).getByRole("gridcell").first().click()
    await owner.page.keyboard.type("Ada Lovelace")
    await owner.page.keyboard.press("Enter")
    await guest.page.getByText("Ada Lovelace").waitFor()
    assert.equal((await content(t.id)).state.cells[`${seeded.state.rowIds[1]}:${name.id}`].v, "Ada Lovelace")

    // Guest can't edit.
    assert.ok(await guest.page.getByText("View only").isVisible())
    const before = JSON.stringify((await content(t.id)).state.cells)
    await guest.page.getByRole("gridcell").first().dblclick()
    await guest.page.keyboard.type("hack")
    await guest.page.keyboard.press("Enter")
    await settle()
    assert.equal(JSON.stringify((await content(t.id)).state.cells), before)

    // Kanban: drag Ramp from Lead to Won; the guest's board follows.
    await owner.page.getByRole("tab", { name: "Kanban" }).click()
    const card = owner.page.locator("article", { hasText: "Ramp" })
    const won = owner.page.locator("section", { has: owner.page.locator("header", { hasText: /^Won/ }) })
    await won.scrollIntoViewIfNeeded()
    const a = (await card.boundingBox())!
    const b = (await won.boundingBox())!
    await drag(owner.page, { x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: b.x + 40, y: b.y + 60 })
    await eventually(async () => (await content(t.id)).state.cells[`${seeded.state.rowIds[0]}:${status.id}`]?.v === "Won")

    // Record panel from the source badge: full values, clickable source, Esc closes.
    await owner.page.getByRole("tab", { name: "Grid" }).click()
    // The source badge lists the sources; "Open row" opens the record panel.
    await owner.page.getByRole("button", { name: "1 source", exact: true }).first().click()
    await owner.page.getByRole("dialog", { name: "Sources" }).getByRole("button", { name: "Open row" }).click()
    const panel = owner.page.getByRole("complementary", { name: "Record" })
    await panel.waitFor()
    assert.equal(await panel.locator('a[href="https://ramp.com/about"]').count(), 1)
    await owner.page.keyboard.press("Escape")
    assert.equal(await panel.count(), 0)

    assert.deepEqual([...owner.errors, ...guest.errors], [])
  })
})

describe("board", () => {
  test("create, edit, move, connect, delete; guest sees it all; agent cursor", viewAsOnly, async () => {
    const b = await create("board", "ui board")
    const owner = await open(browser)
    const guest = await open(browser, "guest")
    await visit(owner.page, `${BASE}/boards/${b.id}`, owner.page.getByText("Drop ideas here"))
    await visit(guest.page, `${BASE}/boards/${b.id}`, guest.page.getByText("Drop ideas here"))
    const canvas = (await owner.page.getByLabel("Board canvas").boundingBox())!

    await owner.page.getByRole("button", { name: "Rectangle" }).click()
    await owner.page.mouse.click(canvas.x + canvas.width * 0.72, canvas.y + canvas.height * 0.45)
    const rect = await eventually(async () => (await content(b.id)).state.items.find((s: { kind: string }) => s.kind === "rect"))
    const rectEl = owner.page.locator(`[data-shape-id="${rect.id}"]`)
    await rectEl.dblclick()
    await owner.page.keyboard.type("Research")
    await owner.page.mouse.click(canvas.x + 40, canvas.y + canvas.height - 40)
    await eventually(async () => (await content(b.id)).state.items.find((s: { id: string }) => s.id === rect.id)?.text === "Research")

    const note = (await content(b.id)).state.items.find((s: { kind: string }) => s.kind === "note")
    const nb = (await owner.page.locator(`[data-shape-id="${note.id}"]`).boundingBox())!
    await drag(owner.page, { x: nb.x + 30, y: nb.y + 30 }, { x: nb.x + 130, y: nb.y + 90 })
    await eventually(async () => (await content(b.id)).state.items.find((s: { id: string }) => s.id === note.id).x > note.x + 50)

    await owner.page.getByRole("button", { name: "Connector" }).click()
    const from = (await owner.page.locator(`[data-shape-id="${note.id}"]`).boundingBox())!
    const to = (await rectEl.boundingBox())!
    await drag(owner.page, { x: from.x + from.width / 2, y: from.y + from.height / 2 }, { x: to.x + to.width / 2, y: to.y + to.height / 2 })
    const arrow = await eventually(async () => (await content(b.id)).state.items.find((s: { kind: string }) => s.kind === "arrow"))
    assert.equal(arrow.from, note.id)
    assert.equal(arrow.to, rect.id)

    await guest.page.getByText("Research").waitFor()
    assert.equal(await guest.page.getByRole("button", { name: /^(Select|Hand|Sticky note|Rectangle|Ellipse|Text|Frame|Connector)$/ }).count(), 2)

    await presence(b.id, "e2e-board", { cursor: { x: 0, y: 0 }, thinking: true, status: "Clustering ideas" })
    await owner.page.getByText("Clustering ideas").waitFor()

    await owner.page.getByRole("button", { name: "Select" }).click()
    await rectEl.click()
    await owner.page.keyboard.press("Delete")
    await eventually(async () => !(await content(b.id)).state.items.some((s: { id: string; kind: string }) => s.id === rect.id || s.kind === "arrow"))
    assert.deepEqual([...owner.errors, ...guest.errors], [])
  })

  test("images: the toolbar uploads and places one", async () => {
    const b = await create("board", "ui images")
    const owner = await open(browser)
    await visit(owner.page, `${BASE}/boards/${b.id}`, owner.page.getByText("Drop ideas here"))
    const png = await owner.page.screenshot()
    await owner.page.locator('input[type="file"]').setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: png })
    const image = await eventually(async () => (await content(b.id)).state.items.find((s: { kind: string }) => s.kind === "image"))
    assert.match(image.src, /^\/api\/v1\/artifacts\/.+\/assets\//)
    await owner.page.locator(`[data-shape-id="${image.id}"] img`).waitFor()
    const loaded = await owner.page.locator(`[data-shape-id="${image.id}"] img`).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
    assert.ok(loaded, "image renders")
  })
})

describe("doc", () => {
  test("markdown shortcuts, split and merge, guest read-only, agent block", viewAsOnly, async () => {
    const d = await create("doc", "ui doc")
    const owner = await open(browser)
    const guest = await open(browser, "guest")
    const blocks = owner.page.locator("[data-block-id] [role=textbox]")
    await visit(owner.page, `${BASE}/docs/${d.id}`, blocks.first())
    await visit(guest.page, `${BASE}/docs/${d.id}`, guest.page.locator("[data-block-id]").first())
    await blocks.first().click()
    for (const [kind, text] of [["type", "# Launch plan"], ["press", "Enter"], ["type", "We ship the table first."], ["press", "Enter"], ["type", "- one"], ["press", "Enter"], ["type", "two"], ["press", "Enter"], ["press", "Enter"], ["type", "[] write MCP tools"]]) {
      if (kind === "type") await owner.page.keyboard.type(text!)
      else await owner.page.keyboard.press(text!)
    }
    await eventually(async () => (await content(d.id)).text === "# Launch plan\n\nWe ship the table first.\n\n- one\n\n- two\n\n- [ ] write MCP tools")

    await blocks.nth(1).click()
    await owner.page.keyboard.press("Home")
    for (let i = 0; i < 7; i++) await owner.page.keyboard.press("ArrowRight")
    await owner.page.keyboard.press("Enter")
    await eventually(async () => (await content(d.id)).state.items[1]?.text === "We ship")
    assert.equal(await blocks.nth(1).innerText(), "We ship")
    await owner.page.keyboard.press("Backspace")
    await eventually(async () => (await content(d.id)).state.items[1]?.text === "We ship the table first.")
    assert.equal(await blocks.nth(1).innerText(), "We ship the table first.")

    await guest.page.locator("[data-block-id]", { hasText: "Launch plan" }).waitFor()
    const before = (await content(d.id)).text
    await guest.page.locator("[data-block-id] [role=textbox]", { hasText: "Launch plan" }).click()
    await guest.page.keyboard.type("hack")
    await settle(600)
    assert.equal((await content(d.id)).text, before)

    const first = (await content(d.id)).state.items[1].id
    await ops(d.id, [{ type: "insert", item: { id: "k_agent", type: "quote", text: "Agent: lead with enrichment." }, after: first }])
    await presence(d.id, "e2e-doc", { blockId: "k_agent", thinking: true })
    await owner.page.getByText("is writing…").waitFor()
    await owner.page.getByText("lead with enrichment").waitFor()
    assert.deepEqual([...owner.errors, ...guest.errors], [])
  })
})
