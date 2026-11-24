import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { alignmentOf, alignmentText, snapMove, snapResize } from "../../packages/protocol/src/alignment.ts"
import { BASE, cleanup, content, create, eventually, launch, mcpSession, open, ops, settle } from "./harness.ts"

/**
 * Alignment on boards: the red guides people get while dragging, and the same
 * answer as text for agents (board_check_alignment, and the note on a move).
 */

type Shape = { id: string; kind: string; x: number; y: number; w: number; h: number; text?: string; from?: string; to?: string }
const rect = (id: string, x: number, y: number, w = 160, h = 100, text?: string): Shape => ({ id, kind: "rect", x, y, w, h, ...(text && { text }) })
// The functions only read ids, kinds, boxes and text, so plain objects stand in for a decoded board.
const report = (items: Array<Shape>, options?: { ids?: Array<string>; tolerance?: number }) => alignmentOf({ items } as never, options)

describe("alignment report", () => {
  test("a column of same-size shapes is one finding, with its gaps", () => {
    const r = report([rect("s_a", 0, 0), rect("s_b", 0, 140), rect("s_c", 0, 280)])
    assert.deepEqual(r.near, [])
    const column = r.aligned.find((g) => g.edges.includes("left"))!
    assert.deepEqual(column.edges, ["left", "center", "right"])
    assert.deepEqual(column.at, [0, 80, 160])
    assert.deepEqual(column.ids, ["s_a", "s_b", "s_c"])
    assert.deepEqual(column.gaps, [40, 40])
    assert.equal(column.spacing, "even")
  })

  test("a shape just off a line others share gets one fix, not one per edge", () => {
    const r = report([rect("s_a", 0, 0), rect("s_b", 0, 140), rect("s_c", 3, 400)])
    assert.equal(r.near.length, 1)
    assert.deepEqual(r.near[0], { id: "s_c", kind: "position", edges: ["left", "center", "right"], with: ["s_a", "s_b"], off: 3, fix: { id: "s_c", x: 0 } })
    // The fix settles it.
    assert.deepEqual(report([rect("s_a", 0, 0), rect("s_b", 0, 140), rect("s_c", 0, 400)]).near, [])
  })

  test("the smaller group moves to the bigger one; between two shapes, either way is reported once", () => {
    const pair = report([rect("s_a", 0, 0), rect("s_b", 400, 5)])
    assert.equal(pair.near.length, 1)
    assert.deepEqual(pair.near[0]!.fix, { id: "s_b", y: 0 })
    const group = report([rect("s_a", 0, 5), rect("s_b", 400, 0), rect("s_c", 800, 0)])
    assert.deepEqual(group.near.map((m) => m.fix), [{ id: "s_a", y: 0 }])
  })

  test("lined up on one side but a little wide: resize, since a move would break the side that's right", () => {
    const r = report([rect("s_a", 0, 0), rect("s_b", 0, 140), rect("s_c", 0, 280, 164)])
    assert.equal(r.near.length, 1)
    assert.equal(r.near[0]!.kind, "size")
    assert.equal(r.near[0]!.off, 4)
    assert.deepEqual(r.near[0]!.fix, { id: "s_c", w: 160 })
    assert.match(alignmentText({ items: [] } as never, { ...r, checked: 3 }), /s_c is 4 wider than s_a, s_b: left edges line up, right edges don't/)
  })

  test("nearly even gaps come with the moves that even them out; far-off shapes don't count as near", () => {
    const r = report([rect("s_a", 0, 0), rect("s_b", 0, 140), rect("s_c", 0, 284), rect("s_far", 500, 900)])
    const column = r.aligned.find((g) => g.edges.includes("left"))!
    assert.equal(column.spacing, "almost")
    assert.deepEqual(column.gaps, [40, 44])
    assert.deepEqual(column.fixes, [{ id: "s_b", y: 142 }])
    assert.deepEqual(r.near, [])
  })

  test("arrows are left out, `ids` narrows the findings, and the tolerance is the caller's", () => {
    const items = [rect("s_a", 0, 0), rect("s_b", 400, 5), rect("s_c", 0, 600), { id: "s_x", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_a", to: "s_b" }]
    assert.equal(report(items).checked, 3)
    assert.equal(report(items, { ids: ["s_c"] }).near.length, 0)
    assert.equal(report(items, { ids: ["s_c"] }).aligned.length, 1)
    assert.equal(report(items, { ids: ["s_b"] }).near.length, 1)
    assert.equal(report(items, { tolerance: 2 }).near.length, 0)
  })

  test("text for agents: near misses first, each with a board_update patch", () => {
    const items = [rect("s_a", 0, 0, 160, 100, "Plan"), rect("s_b", 0, 140), rect("s_c", 3, 400)]
    const text = alignmentText({ items } as never, report(items))
    assert.match(text, /^Checked 3 shapes, tolerance 8: 1 aligned group, 1 almost aligned, 0 almost evenly spaced\./)
    assert.match(text, /- s_c: left\+center\+right is 3 right of s_a, s_b\. Fix: \{"id":"s_c","x":0\}/)
    assert.match(text, /- left\+center\+right at x=0\/80\/160: s_a\("Plan"\), s_b/)
    const tidy = [rect("s_a", 0, 0), rect("s_b", 0, 140)]
    assert.match(alignmentText({ items: tidy } as never, report(tidy)), /Nothing is nearly aligned/)
  })
})

describe("snapping", () => {
  const a = { x: 0, y: 0, w: 160, h: 100 }

  test("a moved box jumps to the nearest line within reach, and reports the lines it shares", () => {
    const s = snapMove({ x: 3, y: 300, w: 160, h: 100 }, [a], 6)
    assert.deepEqual([s.dx, s.dy], [-3, 0])
    // Same width, so left, centre and right all line up; each line runs the length of both boxes.
    assert.deepEqual(s.guides, [
      { axis: "x", at: 0, from: 0, to: 400 },
      { axis: "x", at: 80, from: 0, to: 400 },
      { axis: "x", at: 160, from: 0, to: 400 },
    ])
    assert.deepEqual(snapMove({ x: 30, y: 300, w: 160, h: 100 }, [a], 6), { dx: 0, dy: 0, guides: [] })
  })

  test("edges snap to other edges and centres: a box can sit flush against its neighbour", () => {
    const s = snapMove({ x: 164, y: 48, w: 100, h: 100 }, [a], 6)
    assert.deepEqual([s.dx, s.dy], [-4, 2])
    assert.deepEqual(s.guides.map((g) => `${g.axis}${g.at}`), ["x160", "y50", "y100"])
  })

  test("resizing snaps the right and bottom edges, never below the minimum", () => {
    const s = snapResize({ x: 0, y: 300, w: 157, h: 60 }, [a], 6, { w: 40, h: 30 })
    assert.deepEqual([s.w, s.h], [160, 60])
    assert.deepEqual(s.guides, [{ axis: "x", at: 160, from: 0, to: 360 }])
    assert.equal(snapResize({ x: 0, y: 300, w: 78, h: 60 }, [a], 6, { w: 79, h: 30 }).w, 80)
    assert.equal(snapResize({ x: 0, y: 300, w: 83, h: 60 }, [a], 6, { w: 82, h: 30 }).w, 83)
  })
})

describe("alignment on a live board", () => {
  let browser: Browser
  before(async () => {
    browser = await launch()
  })
  after(async () => {
    await browser?.close()
    await cleanup()
  })

  const items = async (id: string): Promise<Array<Shape>> => (await content(id)).state.items
  /** A (0,0) and B (400,0) in a row; C (403,300) sits 3 right of B's column. */
  async function board(name: string) {
    const b = await create("board", name)
    await ops(b.id, [
      { type: "remove", ids: (await items(b.id)).map((s) => s.id) },
      { type: "insert", item: { ...rect("s_a", 0, 0, 160, 100, "A"), color: "blue" } },
      { type: "insert", item: { ...rect("s_b", 400, 0, 160, 100, "B"), color: "green" } },
      { type: "insert", item: { ...rect("s_c", 403, 300, 160, 100, "C"), color: "pink" } },
    ])
    return b
  }

  test("dragging near a neighbour's line snaps onto it and shows the guide; ⌘ places freely", async () => {
    const b = await board("align drag")
    const { page, errors } = await open(browser)
    await page.goto(`${BASE}/boards/${b.id}`)
    await page.locator('[data-shape-id="s_c"]').waitFor()
    await settle(300)
    const box = async (id: string) => (await page.locator(`[data-shape-id="${id}"]`).boundingBox())!
    const guides = page.locator("[data-guide]")
    const [a, c] = [await box("s_a"), await box("s_c")]
    const grab = { x: c.x + c.width / 2, y: c.y + c.height / 2 }
    // Bring C's left to within 3 screen px of A's left; down the page nothing else is close.
    const to = { x: grab.x + (a.x + 3 - c.x), y: grab.y + 40 }

    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await guides.first().waitFor()
    assert.equal(await page.locator('[data-guide="x"]').count(), 3, "left, centre and right of two same-width shapes")
    assert.equal(await page.locator('[data-guide="y"]').count(), 0)
    const line = (await page.locator('[data-guide="x"]').first().boundingBox())!
    assert.ok(Math.abs(line.x - a.x) <= 1, "the guide runs down A's left edge")
    assert.ok(line.height >= a.height + c.height, "from the top of A to the bottom of C")
    await page.mouse.up()
    assert.equal(await guides.count(), 0, "guides go when the drag ends")
    const snapped = await eventually(async () => {
      const s = (await items(b.id)).find((x) => x.id === "s_c")!
      return s.y > 300 && s
    })
    assert.equal(snapped.x, 0, "C's left is exactly A's")

    // Held ⌘: the same drag, back to 3 px off, stays where the pointer put it.
    const c2 = await box("s_c")
    const from = { x: c2.x + c2.width / 2, y: c2.y + c2.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.keyboard.down("Meta")
    await page.mouse.move(from.x + 3, from.y + 40, { steps: 10 })
    assert.equal(await guides.count(), 0)
    await page.mouse.up()
    await page.keyboard.up("Meta")
    const free = await eventually(async () => {
      const s = (await items(b.id)).find((x) => x.id === "s_c")!
      return s.y > snapped.y && s
    })
    assert.ok(free.x > 0 && free.x < 8, `placed freely at x=${free.x}`)
    assert.deepEqual(errors, [])
  })

  test("agents get the same answer: board_check_alignment, and a note when a move lands just off", async () => {
    const b = await board("align mcp")
    const mcp = await mcpSession()
    const tools = (await mcp.request("tools/list")).result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>
    assert.equal(tools.find((t) => t.name === "board_check_alignment")?.annotations.readOnlyHint, true)

    const check = await mcp.tool("board_check_alignment", { artifact: b.id })
    assert.equal(check.error, false, check.text)
    assert.match(check.text, /Checked 3 shapes, tolerance 8: 1 aligned group, 1 almost aligned/)
    assert.match(check.text, /- s_c\("C"\): left\+center\+right is 3 right of s_b\. Fix: \{"id":"s_c","x":400\}/)
    assert.match(check.text, /- top\+middle\+bottom at y=0\/50\/100: s_a\("A"\), s_b\("B"\)/)

    // The fix is a board_update entry as it stands; afterwards nothing is off.
    const fixed = await mcp.tool("board_update", { artifact: b.id, shapes: [{ id: "s_c", x: 400 }] })
    assert.equal(fixed.text, "Updated 1 shape")
    assert.match((await mcp.tool("board_check_alignment", { artifact: b.id })).text, /Nothing is nearly aligned/)

    // A move that lands just off a line says so in its own result.
    const moved = await mcp.tool("board_update", { artifact: b.id, shapes: [{ id: "s_c", y: 305, x: 0 }, { id: "s_a", y: 4 }] })
    assert.match(moved.text, /^Updated 2 shapes\n\nAlmost aligned:\n- s_a\("A"\): top\+middle\+bottom is 4 below s_b\. Fix: \{"id":"s_a","y":0\}$/)
    const added = await mcp.tool("board_add", { artifact: b.id, items: [{ text: "D", kind: "rect", x: 402, y: 600 }] })
    assert.match(added.text, /Almost aligned:\n- s_\w+\("D"\): left\+center\+right is 2 right of s_b\. Fix: /)
    // Recoloring isn't a move, and auto-placed shapes are lined up for you.
    assert.equal((await mcp.tool("board_update", { artifact: b.id, shapes: [{ id: "s_a", color: "pink" }] })).text, "Updated 1 shape")

    const narrowed = await mcp.tool("board_check_alignment", { artifact: b.id, shapes: ["s_c"], tolerance: 2 })
    assert.match(narrowed.text, /0 almost aligned/)
    const unknown = await mcp.tool("board_check_alignment", { artifact: b.id, shapes: ["s_nope"] })
    assert.equal(unknown.error, true)
    assert.match(unknown.text, /No shape .*s_nope/)
  })
})
