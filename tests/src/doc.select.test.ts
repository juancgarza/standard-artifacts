import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, cleanup, content, create, eventually, launch, ops, visit } from "./harness.ts"

/**
 * Selecting across blocks with a drag that starts inside a block's text (browsers
 * clamp that to one editable; the doc extends it), and editing that selection.
 */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

async function threeBlocks(title: string) {
  const d = await create("doc", title)
  const first = (await content(d.id)).state.items[0].id
  await ops(d.id, [
    { type: "update", id: first, patch: { text: "Alpha one two three" } },
    { type: "insert", item: { id: "k_b", type: "paragraph", text: "Bravo middle line" }, after: first },
    { type: "insert", item: { id: "k_c", type: "paragraph", text: "Charlie four five six" }, after: "k_b" },
  ], "owner")
  return d
}

async function openAndDrag(d: { id: string }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"])
  const page = await ctx.newPage()
  const boxes = page.locator("[data-block-id] [role=textbox]")
  await visit(page, `${BASE}/docs/${d.id}`, boxes.nth(2))
  const a = (await boxes.nth(0).boundingBox())!
  const c = (await boxes.nth(2).boundingBox())!
  await page.mouse.move(a.x + 60, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + 80, a.y + a.height / 2, { steps: 3 })
  await page.mouse.move(c.x + 70, c.y + c.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  return page
}

const texts = async (id: string) => ((await content(id)).state.items as Array<{ text: string }>).map((b) => b.text)

describe("doc cross-block selection", () => {
  test("a drag from inside a block spans blocks; copy and Ask Claude work", async () => {
    const d = await threeBlocks("select span")
    const page = await openAndDrag(d)
    const spanned = await page.evaluate(() => {
      const s = window.getSelection()
      return s && s.rangeCount ? s.getRangeAt(0).toString() : ""
    })
    assert.match(spanned, /two three[\s\S]*Bravo middle line[\s\S]*Charlie/)
    assert.ok(await page.getByRole("button", { name: /Ask Claude/ }).first().isVisible())
    await page.keyboard.press("ControlOrMeta+c")
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Bravo middle line/)
  })

  test("Backspace merges around the selection", async () => {
    const d = await threeBlocks("select delete")
    const page = await openAndDrag(d)
    await page.keyboard.press("Backspace")
    await eventually(async () => {
      const t = await texts(d.id)
      return t.length === 1 && t[0]!.startsWith("Alpha") && t[0]!.endsWith("six") && !t[0]!.includes("Bravo")
    })
    await page.keyboard.type("!")
    await eventually(async () => (await texts(d.id))[0]?.includes("!"))
  })

  test("typing replaces it; Enter splits there", async () => {
    const typed = await threeBlocks("select type")
    const page = await openAndDrag(typed)
    await page.keyboard.type("X")
    await eventually(async () => {
      const t = await texts(typed.id)
      return t.length === 1 && t[0]!.includes("X") && !t[0]!.includes("Bravo")
    })
    const split = await threeBlocks("select enter")
    const page2 = await openAndDrag(split)
    await page2.keyboard.press("Enter")
    await eventually(async () => {
      const t = await texts(split.id)
      return t.length === 2 && t[0]!.startsWith("Alpha") && t[1]!.endsWith("six")
    })
  })
})
