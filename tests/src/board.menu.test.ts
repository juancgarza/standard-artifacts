import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, cleanup, content, create, eventually, launch, open, ops, settle, viewAsOnly } from "./harness.ts"

/** The board's right-click menu: what it's about, submenus and keyboard, and every action it runs. */

type Shape = { id: string; kind: string; x: number; y: number; w: number; h: number; from?: string; to?: string; x2?: number; y2?: number; text?: string; color?: string; textSize?: string }

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
const order = async (id: string) => (await items(id)).map((s) => s.id)

const rect = (id: string, x: number, y: number, extra: Partial<Shape> = {}) => ({ id, kind: "rect", x, y, w: 160, h: 100, color: "blue", text: id.slice(2).toUpperCase(), ...extra })

/** A board holding exactly these shapes. */
async function board(name: string, shapes: Array<Record<string, unknown>>) {
  const b = await create("board", name)
  const seeded = await items(b.id)
  await ops(b.id, [{ type: "remove", ids: seeded.map((s) => s.id) }, ...shapes.map((item) => ({ type: "insert", item }))])
  return b
}

async function openBoard(id: string, first: string, as: "owner" | "guest" = "owner") {
  const { page, errors } = await open(browser, as)
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE })
  await page.goto(`${BASE}/boards/${id}`)
  await page.locator(`[data-shape-id="${first}"]`).waitFor()
  await settle(300)
  return { page, errors }
}

const canvas = (page: Page) => page.locator('[aria-label="Board canvas"]')
const mid = async (page: Page, shapeId: string) => {
  const b = (await page.locator(`[data-shape-id="${shapeId}"]`).boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
const rightClickShape = async (page: Page, shapeId: string) => {
  const p = await mid(page, shapeId)
  await page.mouse.click(p.x, p.y, { button: "right" })
}
/** A spot on the canvas clear of its toolbars and (for these boards) of shapes. */
const rightClickEmpty = async (page: Page) => {
  const b = (await canvas(page).boundingBox())!
  await page.mouse.click(b.x + 40, b.y + 60, { button: "right" })
}
const row = (page: Page, name: string) => page.getByRole("menu").getByRole("menuitem", { name, exact: true })
const pick = (page: Page, name: string) => row(page, name).click()
/** Open a submenu by hovering, as people do, and click a row in it. */
const pickIn = async (page: Page, parent: string, name: string) => {
  await row(page, parent).hover()
  const option = page.getByRole("menu").getByRole("menuitem", { name, exact: true }).or(page.getByRole("menu").getByRole("menuitemradio", { name, exact: true }))
  await option.first().waitFor()
  await option.first().click()
}
const labels = (page: Page) => page.getByRole("menu").first().locator("button[data-menu-label]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.menuLabel))
const shiftClick = async (page: Page, shapeId: string) => {
  const p = await mid(page, shapeId)
  await page.keyboard.down("Shift")
  await page.mouse.click(p.x, p.y)
  await page.keyboard.up("Shift")
}

describe("board context menu", () => {
  test("what it's about: empty canvas, a shape, and a selection it keeps or replaces", async () => {
    const b = await board("menu targets", [rect("s_a", 0, 0), rect("s_b", 300, 0), rect("s_c", 600, 0)])
    const { page, errors } = await openBoard(b.id, "s_a")

    await rightClickEmpty(page)
    const onCanvas = await labels(page)
    assert.ok(onCanvas.includes("Add") && onCanvas.includes("Paste here") && onCanvas.includes("Zoom to fit"))
    assert.ok(!onCanvas.includes("Delete"), "nothing to delete on empty canvas")
    await page.keyboard.press("Escape")
    assert.equal(await page.getByRole("menu").count(), 0)

    // A shape outside the selection replaces it...
    await rightClickShape(page, "s_a")
    const onShape = await labels(page)
    assert.ok(onShape.includes("Edit text") && onShape.includes("Delete") && onShape.includes("Color"))
    assert.ok(!onShape.includes("Align"), "aligning takes two")
    await page.keyboard.press("Escape")
    assert.equal(await page.getByRole("toolbar", { name: "Selection" }).count(), 1, "the shape was selected, and the format bar is back once the menu closes")

    // ...and one inside it keeps it, so the whole group can be acted on.
    await shiftClick(page, "s_b")
    await rightClickShape(page, "s_b")
    const onGroup = await labels(page)
    assert.ok(onGroup.includes("Align") && !onGroup.includes("Edit text") && !onGroup.includes("Distribute"))
    assert.equal(await page.getByRole("toolbar", { name: "Selection" }).count(), 0, "the format bar steps aside for the menu")
    await page.keyboard.press("Escape")

    await rightClickEmpty(page)
    assert.ok((await labels(page)).includes("Add"), "empty canvas clears the selection")
    assert.deepEqual(errors, [])
  })

  test("the browser's menu stays on toolbars and in text being edited, and a press elsewhere closes ours", async () => {
    const b = await board("menu chrome", [rect("s_a", 0, 0)])
    const { page, errors } = await openBoard(b.id, "s_a")
    const prevented = (selector: string) =>
      page.evaluate((sel) => {
        const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
        document.querySelector(sel)!.dispatchEvent(e)
        return e.defaultPrevented
      }, selector)
    assert.equal(await prevented('[aria-label="Sticky note"]'), false, "toolbar")
    assert.equal(await prevented('[data-shape-id="s_a"]'), true, "shape")

    await page.mouse.dblclick(...(Object.values(await mid(page, "s_a")) as [number, number]))
    await page.locator('[data-shape-id="s_a"] textarea').waitFor()
    assert.equal(await prevented('[data-shape-id="s_a"] textarea'), false, "text being edited")
    await page.keyboard.press("Escape")

    await rightClickEmpty(page)
    const m = await mid(page, "s_a")
    await page.mouse.click(m.x, m.y)
    assert.equal(await page.getByRole("menu").count(), 0, "a press outside closes it")
    assert.deepEqual(errors, [])
  })

  test("the keyboard drives it: open, arrows, into and out of a submenu, type to jump", async () => {
    const b = await board("menu keyboard", [rect("s_a", 0, 0)])
    const { page, errors } = await openBoard(b.id, "s_a")
    const m = await mid(page, "s_a")
    await page.mouse.click(m.x, m.y)

    await page.keyboard.press("Shift+F10")
    await page.getByRole("menu").first().waitFor()
    const focused = () => page.evaluate(() => (document.activeElement as HTMLElement).dataset.menuLabel)
    assert.equal(await focused(), "Edit text", "the first row takes focus")
    await page.keyboard.press("ArrowUp")
    assert.equal(await focused(), "Delete", "wraps around")

    await page.keyboard.press("c") // Cut
    await page.keyboard.press("c") // Copy
    await page.keyboard.press("c") // Copy as
    assert.equal(await focused(), "Copy as")
    await page.keyboard.press("c") // Color
    assert.equal(await focused(), "Color")
    await page.keyboard.press("ArrowRight")
    await eventually(async () => (await page.getByRole("menu").count()) === 2)
    assert.equal(await focused(), "Yellow", "into the submenu")
    await page.keyboard.press("ArrowLeft")
    assert.equal(await page.getByRole("menu").count(), 1)
    assert.equal(await focused(), "Color", "back to the row it came from")

    await page.keyboard.press("ArrowRight")
    await eventually(async () => (await focused()) === "Yellow")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Escape")
    assert.equal(await page.getByRole("menu").count(), 1, "Escape closes one level at a time")
    await page.keyboard.press("ArrowRight")
    await eventually(async () => (await focused()) === "Yellow")
    await page.keyboard.press("Enter")
    await eventually(async () => (await find(b.id, "s_a"))?.color === "yellow")
    assert.equal(await page.getByRole("menu").count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Board canvas", "the keyboard goes back to the canvas")
    assert.deepEqual(errors, [])
  })

  test("hovering opens a submenu, and it fits on screen near the edge", async () => {
    const b = await board("menu hover", [rect("s_a", 0, 0)])
    const { page, errors } = await openBoard(b.id, "s_a")
    await rightClickShape(page, "s_a")
    await row(page, "Order").hover()
    const sub = page.getByRole("menu").nth(1)
    await sub.waitFor()
    assert.ok(await sub.getByRole("menuitem", { name: "Bring to front", exact: true }).isVisible())
    // Moving to a row without a submenu closes it, after a beat.
    await row(page, "Duplicate").hover()
    await eventually(async () => (await page.getByRole("menu").count()) === 1)
    await page.keyboard.press("Escape")

    const size = page.viewportSize()!
    await page.mouse.click(size.width - 12, size.height - 90, { button: "right" })
    await page.getByRole("menu").first().waitFor()
    await row(page, "Add").hover()
    await page.getByRole("menu").nth(1).waitFor()
    for (const panel of await page.getByRole("menu").all()) {
      const box = (await panel.boundingBox())!
      assert.ok(box.x >= 0 && box.x + box.width <= size.width && box.y >= 0 && box.y + box.height <= size.height, "both panels are on screen")
    }
    assert.deepEqual(errors, [])
  })

  test("control-click on a Mac is a right-click, not a press", { skip: process.platform !== "darwin" }, async () => {
    const b = await board("menu control click", [rect("s_a", 0, 0)])
    const { page, errors } = await openBoard(b.id, "s_a")
    const p = await mid(page, "s_a")
    await page.keyboard.down("Control")
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x + 60, p.y + 60, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.up("Control")
    await settle()
    const moved = await find(b.id, "s_a")
    assert.deepEqual([moved?.x, moved?.y], [0, 0], "it didn't start a drag")
    // Chrome sends this after the press; a synthetic mouse doesn't, so send it here.
    await page.evaluate(([x, y]) => {
      document.elementFromPoint(x!, y!)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x!, clientY: y!, ctrlKey: true }))
    }, [p.x, p.y])
    assert.ok((await labels(page)).includes("Edit text"))
    assert.deepEqual(errors, [])
  })

  test("adds what you ask for where you asked", async () => {
    const b = await board("menu add", [rect("s_a", 0, 0)])
    const { page, errors } = await openBoard(b.id, "s_a")
    await rightClickEmpty(page)
    await pickIn(page, "Add", "Rectangle")
    const added = await eventually(async () => (await items(b.id)).find((s) => s.id !== "s_a"))
    assert.equal(added.kind, "rect")
    const box = (await canvas(page).boundingBox())!
    const on = (await page.locator(`[data-shape-id="${added.id}"]`).boundingBox())!
    assert.ok(Math.abs(on.x + on.width / 2 - (box.x + 40)) < 2 && Math.abs(on.y + on.height / 2 - (box.y + 60)) < 2, "centered on the click")
    assert.deepEqual(errors, [])
  })

  test("copy and paste shapes: connections survive, ids are new, and it works across boards", async () => {
    const shapes = [rect("s_a", 0, 0, { color: "pink" }), rect("s_b", 300, 0), { id: "s_ar", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_b" }, rect("s_far", 0, 400)]
    const b = await board("menu copy", shapes)
    const { page, errors } = await openBoard(b.id, "s_a")
    const m = await mid(page, "s_a")
    await page.mouse.click(m.x, m.y)
    await shiftClick(page, "s_b")
    await rightClickShape(page, "s_a")
    await pick(page, "Copy")
    await page.getByText("Copied 2 shapes").waitFor()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "A\nB", "their words are the plain text")

    await rightClickEmpty(page)
    await pick(page, "Paste here")
    const after1 = await eventually(async () => {
      const all = await items(b.id)
      return all.length === 7 && all
    })
    const newOnes = after1.filter((s) => !shapes.some((o) => o.id === s.id))
    const arrow = newOnes.find((s) => s.kind === "arrow")!
    const boxes = newOnes.filter((s) => s.kind === "rect")
    assert.deepEqual(boxes.map((s) => s.text).sort(), ["A", "B"])
    assert.equal(boxes.find((s) => s.text === "A")!.color, "pink")
    assert.deepEqual([arrow.from, arrow.to].sort(), boxes.map((s) => s.id).sort(), "the copied arrow joins the copies, not the originals")

    // ⌘V reads the same clipboard, on another board in another tab.
    const other = await board("menu copy target", [rect("s_z", 0, 0)])
    await page.goto(`${BASE}/boards/${other.id}`)
    await page.locator('[data-shape-id="s_z"]').waitFor()
    await settle(300)
    await canvas(page).focus()
    await page.keyboard.press("ControlOrMeta+v")
    const pasted = await eventually(async () => {
      const all = await items(other.id)
      return all.length === 4 && all
    })
    assert.equal(pasted.filter((s) => s.kind === "arrow").length, 1)
    assert.deepEqual(errors, [])
  })

  test("copying only an arrow frees the ends it leaves behind; ⌘C ⌘X ⌘D work without the menu", async () => {
    const b = await board("menu keys", [rect("s_a", 0, 0), rect("s_b", 300, 0), { id: "s_ar", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_b" }, rect("s_f", 600, 300)])
    const { page, errors } = await openBoard(b.id, "s_a")
    await page.mouse.click(...(Object.values(await mid(page, "s_f")) as [number, number]))

    await page.keyboard.press("ControlOrMeta+d")
    const copy = await eventually(async () => (await items(b.id)).find((s) => s.text === "F" && s.id !== "s_f"))
    assert.deepEqual([copy.x, copy.y], [624, 324], "a copy sits just off the original")

    await page.keyboard.press("ControlOrMeta+x")
    await eventually(async () => !(await find(b.id, copy.id)))
    await page.keyboard.press("ControlOrMeta+c")
    assert.equal(await page.getByText("Copied").count(), 0, "nothing selected, nothing to copy")

    // An arrow on its own: right-click it midway between the shapes.
    const a = await mid(page, "s_a")
    const c = await mid(page, "s_b")
    await page.mouse.click((a.x + c.x) / 2, a.y, { button: "right" })
    await pick(page, "Duplicate")
    const free = await eventually(async () => (await items(b.id)).find((s) => s.kind === "arrow" && s.id !== "s_ar"))
    assert.ok(free.from === undefined && free.to === undefined, "its ends aren't attached to anything")
    assert.equal(typeof free.x2, "number")
    assert.deepEqual(errors, [])
  })

  test("prose: ⌘V leaves the board alone, Paste here makes a note", async () => {
    const b = await board("menu prose", [rect("s_a", 0, 0)])
    const { page, errors } = await openBoard(b.id, "s_a")
    await page.evaluate(() => navigator.clipboard.writeText("Just some words"))
    await canvas(page).focus()
    await page.keyboard.press("ControlOrMeta+v")
    await settle()
    assert.equal((await items(b.id)).length, 1)
    await rightClickEmpty(page)
    await pick(page, "Paste here")
    const note = await eventually(async () => (await items(b.id)).find((s) => s.kind === "note"))
    assert.equal(note.text, "Just some words")
    assert.deepEqual(errors, [])
  })

  test("align, distribute and frame selection", async () => {
    const b = await board("menu arrange", [rect("s_a", 0, 0), rect("s_b", 300, 80), rect("s_c", 900, 200)])
    const { page, errors } = await openBoard(b.id, "s_a")
    await page.mouse.click(...(Object.values(await mid(page, "s_a")) as [number, number]))
    await shiftClick(page, "s_b")
    await shiftClick(page, "s_c")

    await rightClickShape(page, "s_a")
    await pickIn(page, "Distribute", "Horizontally")
    await eventually(async () => (await find(b.id, "s_b"))?.x === 450)

    await rightClickShape(page, "s_a")
    await pickIn(page, "Align", "Bottom")
    await eventually(async () => (await items(b.id)).every((s) => s.y + s.h === 300))

    await rightClickShape(page, "s_a")
    await pick(page, "Frame selection")
    const frame = await eventually(async () => (await items(b.id)).find((s) => s.kind === "frame"))
    assert.deepEqual([frame.x, frame.y, frame.w, frame.h], [-32, 168, 1124, 164], "around them, with room")
    assert.equal((await order(b.id))[0], frame.id, "behind everything")

    // A frame's own: its contents, and fitting to them.
    await page.locator(`[data-frame-header="${frame.id}"]`).click({ button: "right" })
    await pick(page, "Select contents")
    await eventually(async () => (await page.locator('[data-shape-id="s_b"]').locator("> div").last().evaluate((el) => getComputedStyle(el).outlineStyle)) === "solid")
    await rightClickShape(page, "s_a")
    await pick(page, "Delete")
    await eventually(async () => !(await find(b.id, "s_c")))
    await page.locator(`[data-frame-header="${frame.id}"]`).click({ button: "right" })
    assert.ok(!(await labels(page)).includes("Delete frame and contents"), "nothing inside it any more")
    assert.deepEqual(errors, [])
  })

  test("order steps past what it overlaps; shapes stay above frames", async () => {
    const b = await board("menu order", [
      { id: "s_fr", kind: "frame", x: -100, y: -100, w: 800, h: 500, color: "gray", text: "F" },
      rect("s_a", 0, 0),
      rect("s_away", 600, 300, { w: 40, h: 40 }),
      rect("s_b", 50, 50),
      rect("s_c", 100, 80),
    ])
    const { page, errors } = await openBoard(b.id, "s_a")

    await rightClickShape(page, "s_c")
    assert.equal(await row(page, "Order").isVisible(), true)
    await row(page, "Order").hover()
    await page.getByRole("menu").nth(1).waitFor()
    assert.equal(await row(page, "Bring forward").isDisabled(), true, "nothing above it")
    await pick(page, "Send backward")
    await eventually(async () => (await order(b.id)).join() === "s_fr,s_a,s_away,s_c,s_b")

    const top = await page.locator('[data-shape-id="s_a"]').boundingBox()
    await page.mouse.click(top!.x + 10, top!.y + 10, { button: "right" })
    await pickIn(page, "Order", "Bring forward")
    // Past s_c, the nearest it touches, not the s_away it doesn't.
    await eventually(async () => (await order(b.id)).join() === "s_fr,s_away,s_c,s_a,s_b")
    await page.mouse.click(top!.x + 10, top!.y + 10, { button: "right" })
    await pickIn(page, "Order", "Send to back")
    await eventually(async () => (await order(b.id))[1] === "s_a")
    await page.mouse.click(top!.x + 10, top!.y + 10, { button: "right" })
    await row(page, "Order").hover()
    await page.getByRole("menu").nth(1).waitFor()
    assert.equal(await row(page, "Send backward").isDisabled(), true, "only a frame is below it")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")

    await page.keyboard.press("ControlOrMeta+Shift+BracketRight")
    await eventually(async () => (await order(b.id)).at(-1) === "s_a")
    assert.deepEqual(errors, [])
  })

  test("reaches what's buried, turns shapes into each other, reverses and connects", async () => {
    const b = await board("menu kinds", [rect("s_low", 0, 0, { text: "Bottom" }), rect("s_top", 20, 20, { text: "Top" }), rect("s_o", 400, 0)])
    const { page, errors } = await openBoard(b.id, "s_top")

    const top = (await page.locator('[data-shape-id="s_top"]').boundingBox())!
    await page.mouse.click(top.x + 40, top.y + 40, { button: "right" })
    await row(page, "Select").hover()
    const buried = page.getByRole("menu").nth(1).getByRole("menuitemradio")
    await buried.first().waitFor()
    assert.deepEqual(await buried.allInnerTexts(), ["Rectangle · Top", "Rectangle · Bottom"])
    await buried.nth(1).click()
    await page.keyboard.press("ArrowRight")
    await eventually(async () => (await find(b.id, "s_low"))?.x === 1)

    await page.mouse.click(top.x + 40, top.y + 40, { button: "right" })
    await pickIn(page, "Turn into", "Ellipse")
    await eventually(async () => (await find(b.id, "s_top"))?.kind === "ellipse")

    await page.mouse.click(...(Object.values(await mid(page, "s_top")) as [number, number]))
    await shiftClick(page, "s_o")
    await rightClickShape(page, "s_o")
    await pick(page, "Connect with arrow")
    const arrow = await eventually(async () => (await items(b.id)).find((s) => s.kind === "arrow"))
    assert.equal(arrow.from, "s_top")
    assert.equal(arrow.to, "s_o")

    const t = await mid(page, "s_top")
    const o = await mid(page, "s_o")
    await page.mouse.click((t.x + o.x) / 2, (t.y + o.y) / 2, { button: "right" })
    await pick(page, "Reverse direction")
    await eventually(async () => {
      const a = await find(b.id, arrow.id)
      return a?.from === "s_o" && a?.to === "s_top"
    })
    assert.deepEqual(errors, [])
  })

  test("inside a design frame it's about the layer", async () => {
    const design = {
      root: "n_root",
      nodes: {
        n_root: { id: "n_root", tag: "div", style: { display: "flex", "flex-direction": "column", padding: "20px", height: "100%" }, children: ["n_one", "n_two"] },
        n_one: { id: "n_one", tag: "p", text: "First", children: [] },
        n_two: { id: "n_two", tag: "p", text: "Second", children: [] },
      },
    }
    const b = await board("menu design", [{ id: "s_d", kind: "design", x: 0, y: 0, w: 400, h: 240, design, text: "Mock" }])
    const { page, errors } = await openBoard(b.id, "s_d")
    const tree = async () => (await find(b.id, "s_d") as unknown as { design: typeof design }).design

    await rightClickShape(page, "s_d")
    await pick(page, "Edit design")
    await page.getByRole("toolbar", { name: "Design" }).waitFor()

    await page.locator('[data-node-id="n_two"]').click({ button: "right" })
    assert.ok((await labels(page)).includes("Delete layer"))
    assert.equal(await row(page, "Move down").isDisabled(), true, "already last")
    await pick(page, "Move up")
    await eventually(async () => (await tree()).nodes.n_root.children.join() === "n_two,n_one")

    await page.locator('[data-node-id="n_two"]').click({ button: "right" })
    await row(page, "Select").hover()
    const chain = page.getByRole("menu").nth(1).getByRole("menuitemradio")
    await chain.first().waitFor()
    assert.deepEqual(await chain.allInnerTexts(), ["Second", "Mock"], "the layer, then what holds it")
    await chain.nth(1).click()
    await page.locator('[data-node-id="n_two"]').click({ button: "right" })
    await pick(page, "Delete layer")
    await eventually(async () => !(await tree()).nodes.n_two)
    assert.deepEqual(errors, [])
  })

  test("read-only people get what doesn't change anything", viewAsOnly, async () => {
    const b = await board("menu guest", [rect("s_a", 0, 0)])
    const { page, errors } = await openBoard(b.id, "s_a", "guest")
    await rightClickShape(page, "s_a")
    const onShape = await labels(page)
    assert.ok(onShape.includes("Copy") && onShape.includes("Zoom to selection"))
    for (const edit of ["Cut", "Paste here", "Duplicate", "Delete", "Color", "Edit text", "Order", "Frame selection"]) assert.ok(!onShape.includes(edit), `${edit} isn't for guests`)
    await page.keyboard.press("Escape")

    await rightClickEmpty(page)
    assert.deepEqual(await labels(page), ["Select all", "Zoom to fit", "Zoom to 100%"])
    assert.deepEqual(errors, [])
  })
})
