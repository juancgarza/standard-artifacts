import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, cleanup, content, create, eventually, launch, open, ops, settle, viewAsOnly } from "./harness.ts"

/**
 * Table edge cases found in QA: typed values, type changes, concurrent deletes,
 * values outside a select's options, column names, and big or empty tables.
 */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

const cell = (page: Page, row: number, col: number) => page.getByRole("row").nth(row).getByRole("gridcell").nth(col)
const value = async (id: string, rowId: string, colId: string) => (await content(id)).state.cells[`${rowId}:${colId}`]?.v

async function seeded(title: string) {
  const t = await create("table", title)
  const { state } = await content(t.id)
  const [name, website, status] = state.columns
  const rows: Array<string> = state.rowIds
  // New tables are seeded with five rows; typing them as a fixed tuple keeps tests free of undefined checks.
  const [r0, r1, r2, r3, r4] = rows
  assert.ok(r0 && r1 && r2 && r3 && r4, "table is seeded with five rows")
  return { id: t.id, rows: [r0, r1, r2, r3, r4] as const, name, website, status }
}

describe("table values", () => {
  test("writes are typed per column, with reasons for what doesn't fit", async () => {
    const t = await seeded("typed writes")
    const r = t.rows[0]
    assert.equal((await ops(t.id, [{ type: "addColumn", column: { id: "c_score", name: "Score", type: "number" } }])).status, 200)
    assert.equal((await ops(t.id, [{ type: "addColumn", column: { id: "c_ok", name: "OK", type: "checkbox" } }])).status, 200)

    const bad = await ops(t.id, [{ type: "setCell", rowId: r, colId: "c_score", value: "abc" }])
    assert.equal(bad.status, 400)
    assert.match(bad.body.message, /"Score" is a Number column, and "abc" isn't a number/)

    const option = await ops(t.id, [{ type: "setCell", rowId: r, colId: t.status.id, value: "Bogus" }])
    assert.equal(option.status, 400)
    assert.match(option.body.message, /no option "Bogus"\. Options: Lead, Contacted, Replied, Won/)

    // Friendly input is normalized the same way in the browser and the cell.
    assert.equal(
      (
        await ops(t.id, [
          { type: "setCell", rowId: r, colId: "c_score", value: "1,200" },
          { type: "setCell", rowId: r, colId: t.status.id, value: "won" },
          { type: "setCell", rowId: r, colId: "c_ok", value: "yes" },
          { type: "setCell", rowId: r, colId: t.name.id, value: 42 },
        ])
      ).status,
      200,
    )
    assert.equal(await value(t.id, r, "c_score"), 1200)
    assert.equal(await value(t.id, r, t.status.id), "Won")
    assert.equal(await value(t.id, r, "c_ok"), true)
    assert.equal(await value(t.id, r, t.name.id), "42")

    // Agent progress and failures carry free text, whatever the column type.
    assert.equal((await ops(t.id, [{ type: "setCell", rowId: r, colId: "c_score", value: "Couldn't find it", status: "error" }])).status, 200)

    // Duplicate ids used to be a bare 500 from SQLite.
    const dup = await ops(t.id, [{ type: "addRows", rowIds: ["r_twin", "r_twin"] }])
    assert.equal(dup.status, 400)
    assert.match(dup.body.message, /Duplicate row id/)
    const badRow = await ops(t.id, [{ type: "addRows", rowIds: ["r_new"], values: { r_new: { c_score: "lots" } } }])
    assert.equal(badRow.status, 400)
    assert.equal((await content(t.id)).state.rowIds.includes("r_new"), false)
  })

  test("typing text into a Number column keeps the draft and says why", async () => {
    const t = await seeded("number input")
    await ops(t.id, [{ type: "addColumn", column: { id: "c_score", name: "Score", type: "number" } }])
    const { page, errors } = await open(browser)
    await page.goto(`${BASE}/tables/${t.id}`)
    await cell(page, 1, 3).click()
    await page.keyboard.type("abc")
    await page.keyboard.press("Enter")

    const editor = page.getByRole("textbox", { name: "Score" })
    assert.equal(await editor.inputValue(), "abc")
    assert.equal(await editor.getAttribute("aria-invalid"), "true")
    assert.match(await page.getByRole("alert").innerText(), /"Score" is a Number column, and "abc" isn't a number/)
    // Clicking another cell doesn't throw the draft away either.
    await cell(page, 2, 0).click()
    assert.equal(await editor.inputValue(), "abc")
    assert.equal(await cell(page, 1, 3).getAttribute("aria-selected"), "true")

    // Fix it in place: Enter saves and moves down.
    await editor.fill("12")
    await page.keyboard.press("Enter")
    await eventually(async () => (await value(t.id, t.rows[0], "c_score")) === 12)
    assert.equal(await cell(page, 2, 3).getAttribute("aria-selected"), "true")

    // Esc cancels a bad draft, and the keyboard still drives the grid afterwards.
    await page.keyboard.type("nope")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Escape")
    assert.equal(await page.getByRole("alert").count(), 0)
    await page.keyboard.press("ArrowUp")
    await page.keyboard.type("7")
    await page.keyboard.press("Enter")
    await eventually(async () => (await value(t.id, t.rows[0], "c_score")) === 7)
    assert.equal(await value(t.id, t.rows[1], "c_score"), undefined)
    assert.deepEqual(errors, [])
  })

  test("record panel: Cmd+Enter saves or explains, Esc reverts then closes", async () => {
    const t = await seeded("record panel")
    await ops(t.id, [{ type: "addColumn", column: { id: "c_score", name: "Score", type: "number" } }])
    const { page, errors } = await open(browser)
    await page.goto(`${BASE}/tables/${t.id}`)
    await cell(page, 1, 0).click()
    await page.keyboard.press(" ")
    const panel = page.getByRole("complementary", { name: "Record" })
    const score = panel.getByRole("textbox", { name: "Score" })
    await score.fill("twelve")
    await page.keyboard.press("Meta+Enter")
    await panel.getByRole("alert").getByText(`"Score" is a Number column, and "twelve" isn't a number`).waitFor()
    assert.equal(await score.inputValue(), "twelve")

    await score.fill("12")
    await page.keyboard.press("Meta+Enter")
    await eventually(async () => (await value(t.id, t.rows[0], "c_score")) === 12)
    // Focus stayed in the panel, so Esc closes it (it used to land on <body> and do nothing).
    await page.keyboard.press("Escape")
    assert.equal(await panel.count(), 0)

    // Esc in a dirty field puts the saved value back before closing anything.
    await page.keyboard.press(" ")
    await score.fill("99")
    await page.keyboard.press("Escape")
    assert.equal(await score.inputValue(), "12")
    await page.keyboard.press("Escape")
    assert.equal(await panel.count(), 0)
    assert.equal(await value(t.id, t.rows[0], "c_score"), 12)
    assert.deepEqual(errors, [])
  })
})

describe("table columns", () => {
  test("changing a column's type converts its values without losing any", async () => {
    const t = await seeded("type change")
    const [a, b, c] = t.rows
    await ops(t.id, [
      { type: "addColumn", column: { id: "c_n", name: "Score", type: "number" } },
      { type: "setCell", rowId: a, colId: "c_n", value: 42 },
      { type: "setCell", rowId: a, colId: t.name.id, value: "Acme" },
      { type: "setCell", rowId: b, colId: t.name.id, value: "Brex" },
      { type: "setCell", rowId: c, colId: t.name.id, value: "acme" },
      { type: "setCell", rowId: a, colId: t.status.id, value: "Won" },
    ])

    // number -> text -> number round-trips.
    await ops(t.id, [{ type: "updateColumn", id: "c_n", patch: { type: "text" } }])
    assert.equal(await value(t.id, a, "c_n"), "42")
    await ops(t.id, [{ type: "updateColumn", id: "c_n", patch: { type: "number" } }])
    assert.equal(await value(t.id, a, "c_n"), 42)

    // text -> select: the values become the options (case-insensitively), so Kanban has real lanes.
    await ops(t.id, [{ type: "updateColumn", id: t.name.id, patch: { type: "select" } }])
    const named = (await content(t.id)).state.columns.find((x: { id: string }) => x.id === t.name.id)
    assert.deepEqual(named.options, ["Acme", "Brex"])
    assert.equal(await value(t.id, c, t.name.id), "Acme")

    // select -> checkbox keeps "Won" (it isn't a yes/no), so switching back restores it.
    await ops(t.id, [{ type: "updateColumn", id: t.status.id, patch: { type: "checkbox" } }])
    assert.equal(await value(t.id, a, t.status.id), "Won")
    await ops(t.id, [{ type: "updateColumn", id: t.status.id, patch: { type: "select" } }])
    assert.equal(await value(t.id, a, t.status.id), "Won")

    // The grid flags a leftover instead of hiding it; the record panel shows it too.
    await ops(t.id, [{ type: "updateColumn", id: t.status.id, patch: { type: "checkbox" } }])
    const { page, errors } = await open(browser)
    await page.goto(`${BASE}/tables/${t.id}`)
    const flagged = cell(page, 1, 2).locator(".text-danger")
    assert.equal(await flagged.innerText(), "Won")
    assert.match((await flagged.getAttribute("title")) ?? "", /Checkbox column/)
    // Toggling it with Space writes a real checkbox value.
    await cell(page, 1, 2).click()
    await page.keyboard.press(" ")
    await eventually(async () => (await value(t.id, a, t.status.id)) === true)
    assert.deepEqual(errors, [])
  })

  test("column names stay unique; Add column picks a free name; the last column can't go", async () => {
    const t = await seeded("column names")
    const clash = await ops(t.id, [{ type: "addColumn", column: { id: "c_x", name: " name ", type: "text" } }])
    assert.equal(clash.status, 400)
    assert.match(clash.body.message, /already a column named "Name"/)

    const { page, errors } = await open(browser)
    await page.goto(`${BASE}/tables/${t.id}`)
    await page.getByRole("columnheader", { name: /Website/ }).getByText("Website").dblclick()
    await page.getByRole("textbox", { name: "Column name" }).fill("Name")
    await page.keyboard.press("Enter")
    await page.getByRole("status").getByText(`There's already a column named "Name"`).waitFor()
    assert.equal(await page.getByRole("columnheader").nth(1).innerText(), "Website")

    // "Column 4" exists, so a new column after deleting one doesn't collide.
    await ops(t.id, [{ type: "addColumn", column: { id: "c_4", name: "Column 4", type: "text" } }])
    await page.getByRole("columnheader", { name: /Column 4/ }).waitFor()
    await page.getByRole("button", { name: "Add column" }).click()
    await page.getByRole("listbox", { name: "Field types" }).getByRole("option", { name: /^Text/ }).click()
    await eventually(async () => (await content(t.id)).state.columns.some((c: { name: string }) => c.name === "Column 5"))

    // Agents can't empty a table of columns (people never could).
    const cols = (await content(t.id)).state.columns
    const all = await ops(t.id, cols.map((c: { id: string }) => ({ type: "removeColumn", id: c.id })))
    assert.equal(all.status, 400)
    assert.match(all.body.message, /needs at least one column/)
    assert.deepEqual(errors, [])
  })
})

describe("table concurrency", () => {
  test("someone deletes the column I'm editing or the row I have open", async () => {
    const t = await seeded("concurrent delete")
    await ops(t.id, [{ type: "setCell", rowId: t.rows[1], colId: t.name.id, value: "Brex" }])
    const { page, errors } = await open(browser)
    await page.goto(`${BASE}/tables/${t.id}`)

    // Typing into Website when an agent deletes the column.
    await cell(page, 1, 1).click()
    await page.keyboard.type("half typed")
    await ops(t.id, [{ type: "removeColumn", id: t.website.id }])
    await page.getByRole("status").getByText("deleted the column you were editing").waitFor()
    // The selection lands on the neighbour and the keyboard still works.
    assert.equal(await cell(page, 1, 1).getAttribute("aria-selected"), "true")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.type("Ada")
    await page.keyboard.press("Enter")
    await eventually(async () => (await value(t.id, t.rows[0], t.name.id)) === "Ada")

    // Record panel open on row 2 when it's deleted elsewhere: it closes and says so.
    await cell(page, 2, 0).click()
    await page.keyboard.press(" ")
    const panel = page.getByRole("complementary", { name: "Record" })
    await panel.waitFor()
    await ops(t.id, [{ type: "removeRows", rowIds: [t.rows[1]] }])
    await page.getByRole("status").getByText("The row you had open was deleted").waitFor()
    assert.equal(await panel.count(), 0)
    assert.deepEqual(errors, [])
  })
})

describe("table selects and kanban", () => {
  test("a value outside the options is shown, not blanked; kanban can group by any select", async () => {
    const t = await seeded("select misfits")
    const r = t.rows[0]
    await ops(t.id, [
      { type: "setCell", rowId: r, colId: t.name.id, value: "Ramp" },
      { type: "setCell", rowId: r, colId: t.status.id, value: "Replied" },
      // Removing an option that's in use leaves the value behind.
      { type: "updateColumn", id: t.status.id, patch: { options: ["Lead", "Won"] } },
      { type: "addColumn", column: { id: "c_tier", name: "Tier", type: "select", options: ["Gold", "Silver"] } },
      { type: "setCell", rowId: r, colId: "c_tier", value: "gold" },
    ])
    assert.equal(await value(t.id, r, "c_tier"), "Gold")

    const { page, errors } = await open(browser, "owner", { width: 1600, height: 800 })
    await page.goto(`${BASE}/tables/${t.id}`)
    await cell(page, 1, 0).click()
    await page.keyboard.press(" ")
    const status = page.getByRole("complementary", { name: "Record" }).getByRole("combobox", { name: "Status" })
    assert.equal(await status.inputValue(), "Replied")
    await page.keyboard.press("Escape")

    await page.getByRole("tab", { name: "Kanban" }).click()
    const card = page.locator("article", { hasText: "Ramp" })
    assert.match(await card.innerText(), /Status: Replied \(not an option\)/)
    await page.getByRole("combobox", { name: /Group by/ }).selectOption({ label: "Tier" })
    await page.locator("section", { has: page.locator("header", { hasText: /^Gold/ }) }).locator("article", { hasText: "Ramp" }).waitFor()
    assert.deepEqual(errors, [])
  })
})

describe("table scale and guests", () => {
  test("200 rows from ops stay editable; guests stay read-only", viewAsOnly, async () => {
    const t = await seeded("big table")
    const rowIds = Array.from({ length: 200 }, (_, i) => `r_big${String(i).padStart(3, "0")}`)
    const values = Object.fromEntries(rowIds.map((r, i) => [r, { [t.name.id]: `Company ${i}`, [t.status.id]: i % 2 ? "Lead" : "Won" }]))
    assert.equal((await ops(t.id, [{ type: "addRows", rowIds, values }])).status, 200)

    const owner = await open(browser)
    const guest = await open(browser, "guest")
    await owner.page.goto(`${BASE}/tables/${t.id}`)
    await guest.page.goto(`${BASE}/tables/${t.id}`)
    await owner.page.getByText("Company 199").waitFor()

    await cell(owner.page, 205, 0).click()
    await owner.page.keyboard.type("Last one")
    await owner.page.keyboard.press("Enter")
    await guest.page.getByText("Last one").waitFor()

    const before = JSON.stringify((await content(t.id)).state.cells)
    await cell(guest.page, 1, 0).click()
    await guest.page.keyboard.press("Backspace")
    await guest.page.keyboard.type("x")
    await guest.page.keyboard.press(" ")
    await guest.page.getByRole("complementary", { name: "Record" }).waitFor()
    await settle()
    assert.equal(JSON.stringify((await content(t.id)).state.cells), before)
    assert.deepEqual([...owner.errors, ...guest.errors], [])
  })
})
