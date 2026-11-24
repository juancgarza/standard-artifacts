import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { BASE, cleanup, create, eventually, launch, open, settle, visit } from "./harness.ts"

/** The collapsible sidebar: a header button and ⌘\, remembered, with a hover peek while collapsed. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

describe("collapsible sidebar", () => {
  test("collapse, stay collapsed after a reload, peek on hover, open from the page header or ⌘\\", async () => {
    const b = await create("board", `Sidebar e2e ${Date.now()}`)
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 820 })
    await visit(page, BASE, page.getByRole("button", { name: "Collapse sidebar" }))
    const column = page.locator("[data-sidebar]")
    const main = page.locator("main")
    const wide = (await main.boundingBox())!.width

    await page.getByRole("button", { name: "Collapse sidebar" }).click()
    await eventually(async () => (await column.getAttribute("data-sidebar")) === "collapsed")
    await eventually(async () => (await column.boundingBox())!.width === 0)
    assert.ok((await main.boundingBox())!.width >= wide + 240, "the page takes the sidebar's width")
    // Home has no header, so the toggle sits in its corner.
    await page.locator('[data-sidebar-toggle="page"]').waitFor()

    // Remembered per browser.
    await page.reload()
    await page.locator('[data-sidebar-toggle="page"]').waitFor()
    assert.equal(await column.getAttribute("data-sidebar"), "collapsed")

    // Peek from the window's left edge; it slides away when the pointer leaves.
    const peek = page.locator("[data-sidebar-peek]")
    assert.equal(await peek.getAttribute("data-sidebar-peek"), "closed")
    await page.mouse.move(700, 400)
    await page.mouse.move(2, 400)
    await eventually(async () => (await peek.getAttribute("data-sidebar-peek")) === "open")
    await page.mouse.move(120, 300, { steps: 4 })
    await settle(400)
    assert.equal(await peek.getAttribute("data-sidebar-peek"), "open", "moving into the peek keeps it")
    await page.mouse.move(900, 400, { steps: 4 })
    await eventually(async () => (await peek.getAttribute("data-sidebar-peek")) === "closed")

    // Hovering the toggle peeks too; picking an artifact there navigates and closes the peek.
    await page.locator('[data-sidebar-toggle="page"]').hover()
    await eventually(async () => (await peek.getAttribute("data-sidebar-peek")) === "open")
    await peek.getByRole("link", { name: b.title }).click()
    await page.waitForURL(`**/boards/${b.id}`)
    await eventually(async () => (await peek.getAttribute("data-sidebar-peek")) === "closed")

    // On an artifact, the toggle is in the page header, and ⌘\ opens the sidebar again.
    const headerToggle = page.locator('header [data-sidebar-toggle="page"]')
    await headerToggle.waitFor()
    await page.mouse.click(900, 500)
    await page.keyboard.press("Meta+Backslash")
    await eventually(async () => (await column.getAttribute("data-sidebar")) === "open")
    await eventually(async () => (await column.boundingBox())!.width === 248)
    assert.equal(await headerToggle.count(), 0)
    assert.equal(await page.locator("[data-sidebar-peek]").count(), 0)
    // ⌘\ also collapses.
    await page.keyboard.press("Meta+Backslash")
    await eventually(async () => (await column.getAttribute("data-sidebar")) === "collapsed")
    await headerToggle.click()
    await eventually(async () => (await column.getAttribute("data-sidebar")) === "open")
    assert.deepEqual(errors, [])
  })

  test("small screens keep the drawer and show no collapse button", async () => {
    const { page, errors } = await open(browser, "owner", { width: 400, height: 760 })
    await visit(page, BASE, page.getByRole("button", { name: "Open menu" }))
    assert.equal(await page.locator('[data-sidebar-toggle]:visible').count(), 0)
    await page.getByRole("button", { name: "Open menu" }).click()
    await page.getByRole("button", { name: "Close menu" }).first().waitFor()
    assert.equal(await page.locator('[data-sidebar-toggle]:visible').count(), 0)
    assert.deepEqual(errors, [])
  })
})
