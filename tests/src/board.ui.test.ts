import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, cleanup, content, create, drag, eventually, launch, open, ops, settle, viewAsOnly } from "./harness.ts"

/** Boards: arrows (connected, free, re-attached), nudging, frames, marquee, labels, and old-style arrows. */

type Shape = { id: string; kind: string; x: number; y: number; w: number; h: number; from?: string; to?: string; x2?: number; y2?: number; text?: string; color?: string }
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
const arrows = async (id: string) => (await items(id)).filter((s) => s.kind === "arrow")
const mid = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

/** A board with three rectangles in a row (A, B, C) and nothing else. */
async function board(name: string) {
  const b = await create("board", name)
  const seeded = await items(b.id)
  await ops(b.id, [
    { type: "remove", ids: seeded.map((s) => s.id) },
    { type: "insert", item: { id: "s_a", kind: "rect", x: 0, y: 0, w: 160, h: 100, color: "blue", text: "A" } },
    { type: "insert", item: { id: "s_b", kind: "rect", x: 400, y: 0, w: 160, h: 100, color: "green", text: "B" } },
    { type: "insert", item: { id: "s_c", kind: "rect", x: 400, y: 300, w: 160, h: 100, color: "pink", text: "C" } },
  ])
  return b
}

async function openBoard(id: string, as: "owner" | "guest" = "owner") {
  const { page, errors } = await open(browser, as)
  await page.goto(`${BASE}/boards/${id}`)
  await page.locator('[data-shape-id="s_a"]').waitFor()
  await settle(300)
  return { page, errors, box: async (shapeId: string) => (await page.locator(`[data-shape-id="${shapeId}"]`).boundingBox())! }
}

const arrowTool = (page: Page) => page.getByRole("button", { name: "Arrow connector" })

describe("board arrows", () => {
  test("connect two shapes, with a snap highlight while hovering the target", async () => {
    const b = await board("arrows connect")
    const { page, errors, box } = await openBoard(b.id)
    await arrowTool(page).click()
    assert.ok(await page.getByText("Drag to draw an arrow").isVisible(), "the tool explains itself")

    const a = mid(await box("s_a"))
    const target = mid(await box("s_b"))
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(target.x - 20, target.y, { steps: 10 })
    await page.mouse.move(target.x, target.y, { steps: 3 })
    assert.equal(await page.locator('[data-shape-id="s_b"][data-snap]').count(), 1, "target is highlighted")
    await page.mouse.up()

    const arrow = await eventually(async () => (await arrows(b.id))[0])
    assert.equal(arrow.from, "s_a")
    assert.equal(arrow.to, "s_b")
    // One-shot, like the other creation tools: back to Select with the arrow selected.
    assert.equal(await page.getByRole("button", { name: "Select" }).getAttribute("aria-pressed"), "true")
    assert.equal(await page.locator('[data-arrow-end]').count(), 2)
    assert.match((await content(b.id)).text, /arrow s_a\("A"\) -> s_b\("B"\)/)
    assert.deepEqual(errors, [])
  })

  test("free arrows: into empty space, from empty space, and fully free; a click draws nothing", async () => {
    const b = await board("arrows free")
    const { page, errors, box } = await openBoard(b.id)
    const a = await box("s_a")
    const c = await box("s_c")

    await arrowTool(page).click()
    await drag(page, mid(a), { x: a.x + a.width / 2, y: a.y + a.height + 120 })
    const first = await eventually(async () => (await arrows(b.id))[0])
    assert.equal(first.from, "s_a")
    assert.equal(first.to, undefined)
    assert.ok(first.y2! > 100, "the free end is where the pointer was released")

    await page.keyboard.press("a")
    await drag(page, { x: a.x, y: c.y + c.height / 2 }, mid(c))
    const second = await eventually(async () => (await arrows(b.id)).find((s) => s.to === "s_c"))
    assert.equal(second.from, undefined)

    await page.keyboard.press("a")
    await drag(page, { x: a.x, y: a.y + a.height + 250 }, { x: a.x + 100, y: a.y + a.height + 260 })
    await eventually(async () => (await arrows(b.id)).length === 3)

    await page.keyboard.press("a")
    await page.mouse.click(a.x - 30, a.y + a.height + 40)
    await settle()
    assert.equal((await arrows(b.id)).length, 3)
    assert.match((await content(b.id)).text, /arrow \(-?\d+,-?\d+\) -> \(-?\d+,-?\d+\)/)

    // Moving a free arrow moves its free ends; its attached end stays put.
    const line = (await page.locator(`[data-arrow-id="${first.id}"]`).boundingBox())!
    await page.keyboard.press("Escape")
    await drag(page, mid(line), { x: line.x + line.width / 2 + 80, y: line.y + line.height / 2 })
    const moved = await eventually(async () => {
      const s = await find(b.id, first.id)
      return s && s.x2! > first.x2! + 40 && s
    })
    assert.equal(moved.from, "s_a")
    assert.deepEqual(errors, [])
  })

  test("attach and detach ends by dragging the handles; recolor and delete", async () => {
    const b = await board("arrows ends")
    await ops(b.id, [{ type: "insert", item: { id: "s_ab", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_b" } }])
    const { page, errors, box } = await openBoard(b.id)

    const line = (await page.locator('[data-arrow-id="s_ab"]').boundingBox())!
    await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2)
    const end = (await page.locator('[data-arrow-end="to"]').boundingBox())!
    const bb = await box("s_b")
    await drag(page, mid(end), { x: bb.x + bb.width / 2, y: bb.y + bb.height + 80 })
    const detached = await eventually(async () => {
      const s = await find(b.id, "s_ab")
      return s && !s.to && s
    })
    assert.equal(detached.from, "s_a")
    assert.ok(detached.y2! > 100)

    const free = (await page.locator('[data-arrow-end="to"]').boundingBox())!
    await drag(page, mid(free), mid(await box("s_c")))
    await eventually(async () => (await find(b.id, "s_ab"))?.to === "s_c")

    await page.getByRole("button", { name: "Color pink" }).click()
    await eventually(async () => (await find(b.id, "s_ab"))?.color === "pink")
    await page.keyboard.press("Delete")
    await eventually(async () => !(await find(b.id, "s_ab")))
    assert.equal((await items(b.id)).length, 3, "deleting an arrow leaves its shapes")
    assert.deepEqual(errors, [])
  })

  test("old-style arrows (from/to, x=y=w=h=0) render and behave; protocol rules", async () => {
    const b = await board("arrows compat")
    await ops(b.id, [{ type: "insert", item: { id: "s_old", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_b" } }])
    const { page, errors, box } = await openBoard(b.id)
    // A horizontal line has a zero-height box, which Playwright calls hidden: wait for it to exist.
    await page.locator('[data-arrow-id="s_old"] line').first().waitFor({ state: "attached" })

    // It follows its shape when the shape moves.
    const before = (await page.locator('[data-arrow-id="s_old"]').boundingBox())!
    const a = await box("s_a")
    await drag(page, { x: a.x + 20, y: a.y + 20 }, { x: a.x + 20, y: a.y + 160 })
    await eventually(async () => (await find(b.id, "s_a"))!.y > 60)
    await eventually(async () => (await page.locator('[data-arrow-id="s_old"]').boundingBox())!.height > before.height + 40)

    // The API keeps the old rules for connected arrows, and accepts free ends only with a point.
    assert.equal((await ops(b.id, [{ type: "insert", item: { id: "s_x1", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a" } }])).status, 400)
    assert.equal((await ops(b.id, [{ type: "insert", item: { id: "s_x2", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_missing" } }])).status, 400)
    assert.equal((await ops(b.id, [{ type: "insert", item: { id: "s_x3", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_a" } }])).status, 400)
    assert.equal((await ops(b.id, [{ type: "update", id: "s_old", patch: { to: null } }])).status, 400, "detaching needs a point")
    assert.equal((await ops(b.id, [{ type: "update", id: "s_a", patch: { kind: "arrow" } }])).status, 400)
    const ok = await ops(b.id, [
      { type: "insert", item: { id: "s_half", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_c", x2: 900, y2: 900 } },
      { type: "update", id: "s_old", patch: { color: "purple" } },
    ])
    assert.equal(ok.status, 200)
    assert.match((await content(b.id)).text, /s_half: arrow s_c\("C"\) -> \(900,900\)/)

    // Removing a shape removes every arrow attached to it, including half-free ones.
    await ops(b.id, [{ type: "remove", ids: ["s_c"] }])
    assert.equal(await find(b.id, "s_half"), undefined)
    await page.locator('[data-shape-id="s_b"]').click()
    await page.keyboard.press("Delete")
    await eventually(async () => !(await find(b.id, "s_old")))
    await eventually(async () => (await page.locator('[data-arrow-id="s_old"]').count()) === 0)
    assert.deepEqual(errors, [])
  })
})

describe("board editing", () => {
  test("arrow keys nudge the selection, one update per key press", async () => {
    const b = await board("nudge")
    const { page, errors, box } = await openBoard(b.id)
    await page.mouse.click(mid(await box("s_a")).x, mid(await box("s_a")).y)
    const seq = (await content(b.id)).seq
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Shift+ArrowDown")
    await page.keyboard.press("ArrowLeft")
    const a = await eventually(async () => {
      const s = await find(b.id, "s_a")
      return s && s.y === 10 && s
    })
    assert.equal(a.x, 0)
    assert.equal((await content(b.id)).seq, seq + 3)
    assert.deepEqual(errors, [])
  })

  test("moving a frame carries what's inside it", async () => {
    const b = await board("frame")
    await ops(b.id, [
      { type: "insert", item: { id: "s_f", kind: "frame", x: -40, y: -60, w: 640, h: 200, text: "Sprint", color: "gray" }, after: null },
      { type: "insert", item: { id: "s_ab", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_b" } },
    ])
    const { page, errors, box } = await openBoard(b.id)
    // Arrows draw above frames (they used to be washed out underneath the frame's fill).
    const order = await page.evaluate(() => {
      const frame = document.querySelector('[data-shape-id="s_f"]')!
      const arrow = document.querySelector('[data-arrow-id="s_ab"]')!
      return frame.compareDocumentPosition(arrow) & Node.DOCUMENT_POSITION_FOLLOWING
    })
    assert.ok(order, "arrow layer comes after the frame")

    const f = await box("s_f")
    await drag(page, { x: f.x + 10, y: f.y + f.height - 10 }, { x: f.x + 10, y: f.y + f.height + 90 })
    const moved = await eventually(async () => {
      const all = await items(b.id)
      const get = (id: string) => all.find((s) => s.id === id)!
      return get("s_f").y > 0 && get("s_a").y > 50 && get("s_b").y > 50 && all
    })
    const get = (id: string) => moved.find((s) => s.id === id)!
    assert.equal(Math.round(get("s_a").y - get("s_f").y), 60, "contents keep their place in the frame")
    assert.equal(get("s_c").y, 300, "shapes outside the frame stay")
    assert.deepEqual(errors, [])
  })

  test("double-clicking an arrow edits its label instead of dropping a note", async () => {
    const b = await board("arrow label")
    await ops(b.id, [{ type: "insert", item: { id: "s_ab", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_b" } }])
    const { page, errors } = await openBoard(b.id)
    const line = (await page.locator('[data-arrow-id="s_ab"]').boundingBox())!
    await page.mouse.dblclick(line.x + line.width / 2, line.y + line.height / 2)
    await page.keyboard.type("leads to")
    await page.keyboard.press("Enter")
    await eventually(async () => (await find(b.id, "s_ab"))?.text === "leads to")
    await page.locator('[data-arrow-id="s_ab"] text', { hasText: "leads to" }).waitFor()
    assert.equal((await items(b.id)).filter((s) => s.kind === "note").length, 0)
    assert.deepEqual(errors, [])
  })

  test("drag a selection box on empty canvas to select several shapes, then move them together", async () => {
    const b = await board("marquee")
    const { page, errors, box } = await openBoard(b.id)
    const a = await box("s_a")
    const bb = await box("s_b")
    // From above-left of A to inside B: touches A and B, not C.
    await drag(page, { x: a.x - 30, y: a.y - 30 }, { x: bb.x + 20, y: bb.y + 20 })
    assert.equal(await page.getByLabel("Board canvas").getByRole("button", { name: "Delete" }).isVisible(), true)
    await drag(page, mid(a), { x: a.x + a.width / 2, y: a.y + a.height / 2 + 100 })
    const all = await eventually(async () => {
      const all = await items(b.id)
      return all.find((s) => s.id === "s_b")!.y > 40 && all
    })
    assert.ok(all.find((s) => s.id === "s_a")!.y > 40)
    assert.equal(all.find((s) => s.id === "s_c")!.y, 300)
    assert.deepEqual(errors, [])
  })

  test("guests can select and pan but not edit, nudge, or draw arrows", viewAsOnly, async () => {
    const b = await board("guest")
    await ops(b.id, [{ type: "insert", item: { id: "s_ab", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_b" } }])
    const { page, errors, box } = await openBoard(b.id, "guest")
    assert.equal(await arrowTool(page).count(), 0)
    const before = (await content(b.id)).seq
    const a = await box("s_a")
    await page.mouse.click(mid(a).x, mid(a).y)
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Delete")
    await page.mouse.dblclick(a.x - 80, a.y + a.height + 80)
    const line = (await page.locator('[data-arrow-id="s_ab"]').boundingBox())!
    await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2)
    await page.keyboard.press("Backspace")
    await settle(500)
    assert.equal((await content(b.id)).seq, before)
    assert.equal(await page.locator("[data-arrow-end]").count(), 0, "no end handles for guests")
    assert.deepEqual(errors, [])
  })
})
