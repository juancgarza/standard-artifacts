import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { BASE, call, cleanup, create, launch, open, viewAsOnly, visit } from "./harness.ts"

/** Archive from the page menu, find it on the Archived page, restore it, and delete for good from there. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

describe("archive", () => {
  test("archive from the menu, restore from the Archived page", async () => {
    const stamp = Date.now()
    const b = await create("board", `Archive ui ${stamp}`)
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 820 })
    const nav = page.getByRole("navigation", { name: "Workspace" })

    await visit(page, `${BASE}/boards/${b.id}`, page.getByRole("button", { name: "More" }))
    await page.getByRole("button", { name: "More" }).click()
    await page.getByRole("menuitem", { name: "Archive board" }).click()
    await page.waitForURL(`${BASE}/`)
    await nav.getByRole("link", { name: "Archived" }).click()

    const row = page.locator("main").getByRole("listitem").filter({ hasText: b.title })
    await row.getByRole("button", { name: "Restore" }).waitFor()
    assert.equal(await nav.getByText(b.title).count(), 0, "gone from the sidebar")

    await row.getByRole("button", { name: "Restore" }).click()
    await row.waitFor({ state: "detached" })
    await nav.getByText(b.title).first().waitFor()
    const artifacts = (await call("GET", "/workspace")).body.artifacts as Array<{ id: string }>
    assert.ok(artifacts.some((a) => a.id === b.id), "back in the workspace")
    assert.deepEqual(errors, [])
  })

  test("delete for good from the Archived page asks first", async () => {
    const b = await create("doc", `Archive delete ${Date.now()}`)
    await call("POST", `/artifacts/${b.id}/archive`)
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 820 })

    await visit(page, `${BASE}/archived`, page.getByRole("heading", { name: "Archived" }))
    const row = page.locator("main").getByRole("listitem").filter({ hasText: b.title })
    await row.getByRole("button", { name: "Delete", exact: true }).click()
    await row.getByRole("button", { name: "Cancel" }).click()
    assert.equal((await call("GET", "/artifacts/archived")).body.some((a: { id: string }) => a.id === b.id), true, "Cancel keeps it")

    await row.getByRole("button", { name: "Delete", exact: true }).click()
    await row.getByRole("button", { name: "Delete for good" }).click()
    await row.waitFor({ state: "detached" })
    assert.equal((await call("GET", "/artifacts/archived")).body.some((a: { id: string }) => a.id === b.id), false)
    assert.deepEqual(errors, [])
  })

  test("viewers get no Archived link", viewAsOnly, async () => {
    const { page } = await open(browser, "viewer", { width: 1400, height: 820 })
    const nav = page.getByRole("navigation", { name: "Workspace" })
    await visit(page, BASE, nav.getByRole("link", { name: "Home" }))
    assert.equal(await nav.getByRole("link", { name: "Archived" }).count(), 0)
  })
})
