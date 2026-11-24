import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, cleanup, content, create, drag, eventually, launch, open, ops, settle, viewAsOnly, visit } from "./harness.ts"

/**
 * The grid as a database: multi-select tags, ranges with copy and paste, row
 * selection with bulk actions, column resize/reorder/hide, and per-viewer
 * search, sort and filters. Plus the compatibility story: tables written with
 * the old value shapes still load and edit.
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
const columnOf = async (id: string, colId: string) => (await content(id)).state.columns.find((c: { id: string }) => c.id === colId)

async function seeded(title: string) {
  const t = await create("table", title)
  const { state } = await content(t.id)
  const [name, website, status] = state.columns
  const [r0, r1, r2, r3, r4] = state.rowIds as Array<string>
  assert.ok(r0 && r1 && r2 && r3 && r4, "table is seeded with five rows")
  return { id: t.id, rows: [r0, r1, r2, r3, r4] as const, name, website, status }
}

/** A table with Name, Website, Status (select), Tags (multi-select) and Employees (number), three rows filled in. */
async function companies(title: string) {
  const t = await seeded(title)
  const [a, b, c] = t.rows
  const r = await ops(t.id, [
    { type: "addColumn", column: { id: "c_tags", name: "Tags", type: "multiSelect", options: ["Fintech", "AI", "B2B", "Seed"] } },
    { type: "addColumn", column: { id: "c_emp", name: "Employees", type: "number" } },
    {
      type: "setCells",
      cells: [
        { rowId: a, colId: t.name.id, value: "Ramp" },
        { rowId: a, colId: t.status.id, value: "Lead" },
        { rowId: a, colId: "c_tags", value: ["Fintech", "B2B"] },
        { rowId: a, colId: "c_emp", value: 900 },
        { rowId: b, colId: t.name.id, value: "Brex" },
        { rowId: b, colId: t.status.id, value: "Won" },
        { rowId: b, colId: "c_tags", value: ["Fintech"] },
        { rowId: b, colId: "c_emp", value: 1100 },
        { rowId: c, colId: t.name.id, value: "Anthropic" },
        { rowId: c, colId: t.status.id, value: "Won" },
        { rowId: c, colId: "c_tags", value: ["AI"] },
        { rowId: c, colId: "c_emp", value: 1500 },
      ],
    },
  ])
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return t
}

describe("table ux: protocol", () => {
  test("tables written with the old value shapes still load and edit", async () => {
    const t = await seeded("old values")
    const [a, b] = t.rows
    // Exactly what clients sent before multi-select existed: scalars only.
    assert.equal(
      (
        await ops(t.id, [
          { type: "addColumn", column: { id: "c_n", name: "Score", type: "number" } },
          { type: "addColumn", column: { id: "c_ok", name: "OK", type: "checkbox" } },
          { type: "addRows", rowIds: ["r_old"], values: { r_old: { [t.name.id]: "Legacy", c_n: 3, c_ok: true, [t.status.id]: "Won" } } },
          { type: "setCell", rowId: a, colId: t.name.id, value: "Ramp" },
          { type: "setCell", rowId: b, colId: t.website.id, value: null },
          { type: "updateColumn", id: t.status.id, patch: { options: ["Lead", "Won"] } },
        ])
      ).status,
      200,
    )
    const { page, errors } = await open(browser)
    await visit(page, `${BASE}/tables/${t.id}`, page.getByText("Legacy"))
    assert.equal(await cell(page, 6, 2).innerText(), "Won")
    await cell(page, 6, 0).click()
    await page.keyboard.type("Legacy 2")
    await page.keyboard.press("Enter")
    await eventually(async () => (await value(t.id, "r_old", t.name.id)) === "Legacy 2")
    // The status column still edits through its picker.
    await cell(page, 6, 2).click()
    await page.keyboard.press("Enter")
    await page.getByRole("option", { name: "Lead" }).click()
    await eventually(async () => (await value(t.id, "r_old", t.status.id)) === "Lead")
    assert.deepEqual(errors, [])
  })

  test("multi-select values are coerced, converted, renamed and read back for agents", async () => {
    const t = await companies("multi protocol")
    const [a, b, c] = t.rows
    // "a, b" text splits into tags, matched case-insensitively; unknown tags are refused with the options.
    assert.equal((await ops(t.id, [{ type: "setCell", rowId: a, colId: "c_tags", value: "ai, seed" }])).status, 200)
    assert.deepEqual(await value(t.id, a, "c_tags"), ["AI", "Seed"])
    const bad = await ops(t.id, [{ type: "setCell", rowId: a, colId: "c_tags", value: ["AI", "Crypto"] }])
    assert.equal(bad.status, 400)
    assert.match(bad.body.message, /"Tags" has no option "Crypto"\. Options: Fintech, AI, B2B, Seed/)
    // A select holds one option, so two tags are refused.
    const two = await ops(t.id, [{ type: "setCell", rowId: a, colId: t.status.id, value: ["Lead", "Won"] }])
    assert.equal(two.status, 400)
    assert.match(two.body.message, /holds one option, not 2/)

    // setCells is all or nothing.
    const mixed = await ops(t.id, [{ type: "setCells", cells: [{ rowId: b, colId: "c_emp", value: 5 }, { rowId: b, colId: "c_emp", value: "many" }] }])
    assert.equal(mixed.status, 400)
    assert.equal(await value(t.id, b, "c_emp"), 1100)

    // Multi-select → text joins; text → multi-select splits back and takes its options from the values.
    await ops(t.id, [{ type: "updateColumn", id: "c_tags", patch: { type: "text" } }])
    assert.equal(await value(t.id, a, "c_tags"), "AI, Seed")
    await ops(t.id, [{ type: "updateColumn", id: "c_tags", patch: { type: "multiSelect" } }])
    assert.deepEqual(await value(t.id, a, "c_tags"), ["AI", "Seed"])
    // Plain text with commas becomes tags, and its values become options.
    await ops(t.id, [
      { type: "setCell", rowId: c, colId: t.website.id, value: "red, Blue" },
      { type: "updateColumn", id: t.website.id, patch: { type: "multiSelect" } },
    ])
    assert.deepEqual(await value(t.id, c, t.website.id), ["red", "Blue"])
    assert.deepEqual((await columnOf(t.id, t.website.id)).options, ["red", "Blue"])

    // Select ↔ multi-select: one tag each way; two tags can't become a select and stay as they are.
    await ops(t.id, [{ type: "updateColumn", id: t.status.id, patch: { type: "multiSelect" } }])
    assert.deepEqual(await value(t.id, b, t.status.id), ["Won"])
    await ops(t.id, [{ type: "updateColumn", id: "c_tags", patch: { type: "select" } }])
    assert.equal(await value(t.id, b, "c_tags"), "Fintech")
    assert.deepEqual(await value(t.id, a, "c_tags"), ["AI", "Seed"])
    await ops(t.id, [{ type: "updateColumn", id: "c_tags", patch: { type: "multiSelect" } }])
    assert.deepEqual(await value(t.id, b, "c_tags"), ["Fintech"])

    // Renaming an option renames it in every cell, and carries its color.
    await ops(t.id, [{ type: "updateColumn", id: "c_tags", patch: { colors: { Fintech: "green" } } }])
    assert.equal((await ops(t.id, [{ type: "renameOption", id: "c_tags", from: "Fintech", to: "Finance" }])).status, 200)
    assert.deepEqual(await value(t.id, b, "c_tags"), ["Finance"])
    const tags = await columnOf(t.id, "c_tags")
    assert.ok(tags.options.includes("Finance") && !tags.options.includes("Fintech"))
    assert.deepEqual(tags.colors, { Finance: "green" })
    const clash = await ops(t.id, [{ type: "renameOption", id: "c_tags", from: "Finance", to: "ai" }])
    assert.equal(clash.status, 400)
    assert.match(clash.body.message, /already has an option "AI"/)

    // Column order is stored.
    assert.equal((await ops(t.id, [{ type: "moveColumn", id: "c_emp", index: 0 }])).status, 200)
    assert.equal((await content(t.id)).state.columns[0].id, "c_emp")

    // Agents see the options and the tags.
    const text: string = (await content(t.id)).text
    assert.match(text, /c_tags="Tags"\(multiSelect: [^)]*Finance/)
    assert.match(text, /c_tags=\["AI","Seed"\]/)
  })
})

describe("table ux: multi-select", () => {
  test("tag picker: type to filter, Enter picks or creates, Backspace removes; kanban still groups by select", async () => {
    const t = await companies("tag picker")
    const [a] = t.rows
    const { page, errors } = await open(browser, "owner", { width: 1600, height: 800 })
    await visit(page, `${BASE}/tables/${t.id}`, page.getByText("Ramp"))
    await cell(page, 1, 3).click()
    // Typing on a tag cell opens the picker with what you typed.
    await page.keyboard.type("se")
    const picker = page.getByRole("dialog", { name: "Choose Tags" })
    await picker.waitFor()
    const offered = await picker.getByRole("option").allInnerTexts()
    assert.equal(offered.length, 2)
    assert.equal(offered[0], "Seed")
    assert.match(offered[1] ?? "", /Create\s*se/)
    await page.keyboard.press("Enter")
    await eventually(async () => JSON.stringify(await value(t.id, a, "c_tags")) === JSON.stringify(["Fintech", "B2B", "Seed"]))

    // A new name is created as an option and added.
    await page.keyboard.type("Climate")
    await page.keyboard.press("Enter")
    await eventually(async () => JSON.stringify(await value(t.id, a, "c_tags")) === JSON.stringify(["Fintech", "B2B", "Seed", "Climate"]))
    const tags = await columnOf(t.id, "c_tags")
    assert.ok(tags.options.includes("Climate"))
    assert.ok(tags.colors?.Climate, "a new option gets a color")

    // Backspace on an empty search removes the last tag; Esc closes and the keyboard drives the grid again.
    await page.keyboard.press("Backspace")
    await eventually(async () => JSON.stringify(await value(t.id, a, "c_tags")) === JSON.stringify(["Fintech", "B2B", "Seed"]))
    await page.keyboard.press("Escape")
    assert.equal(await picker.count(), 0)
    await page.keyboard.press("ArrowLeft")
    assert.equal(await cell(page, 1, 2).getAttribute("aria-selected"), "true")

    // Rendered as tags in the grid.
    assert.deepEqual(await cell(page, 1, 3).locator("span[title]").allInnerTexts(), ["Fintech", "B2B", "Seed"])

    // Kanban groups by the select (one lane per card) and shows the tags on cards.
    await page.getByRole("tab", { name: "Kanban" }).click()
    const won = page.locator("section", { has: page.locator("header", { hasText: /^Won/ }) })
    await won.locator("article", { hasText: "Brex" }).waitFor()
    assert.match(await page.locator("article", { hasText: "Ramp" }).innerText(), /Fintech[\s\S]*B2B[\s\S]*Seed/)
    assert.equal(await page.getByRole("combobox", { name: /Group by/ }).count(), 0, "multi-selects aren't offered for grouping")
    assert.deepEqual(errors, [])
  })

  test("options editor: rename follows into cells, colors, add", async () => {
    const t = await companies("options editor")
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, `${BASE}/tables/${t.id}`, page.getByText("Ramp"))
    await page.getByRole("columnheader", { name: /Tags/ }).hover()
    await page.getByRole("button", { name: "Tags options" }).click()
    const rename = page.getByRole("textbox", { name: "Option 1" })
    await rename.fill("Finance")
    await page.keyboard.press("Enter")
    await eventually(async () => JSON.stringify(await value(t.id, t.rows[1], "c_tags")) === JSON.stringify(["Finance"]))
    await page.getByRole("button", { name: "Color of AI" }).click()
    await page.getByRole("group", { name: "Colors for AI" }).getByRole("button", { name: "purple" }).click()
    await eventually(async () => (await columnOf(t.id, "c_tags")).colors?.AI === "purple")
    await page.getByRole("textbox", { name: "Add an option" }).fill("Series A")
    await page.keyboard.press("Enter")
    await eventually(async () => (await columnOf(t.id, "c_tags")).options.at(-1) === "Series A")
    assert.deepEqual(errors, [])
  })
})

describe("table ux: ranges", () => {
  test("drag and shift-click select a range; copy TSV, paste with new rows and misfits, clear; others see the range", viewAsOnly, async () => {
    const t = await companies("ranges")
    const [a, b, c, d, e] = t.rows
    const { page, errors } = await open(browser, "owner", { width: 1600, height: 800 })
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    const guest = await open(browser, "guest", { width: 1600, height: 800 })
    await visit(page, `${BASE}/tables/${t.id}`, page.getByText("Ramp"))
    await visit(guest.page, `${BASE}/tables/${t.id}`, guest.page.getByText("Ramp"))

    // Drag from Ramp's name to Brex's status: a 2x3 block.
    const from = (await cell(page, 1, 0).boundingBox())!
    const to = (await cell(page, 2, 2).boundingBox())!
    await page.mouse.move(from.x + 20, from.y + 10)
    await page.mouse.down()
    await page.mouse.move(to.x + 20, to.y + 10, { steps: 6 })
    await page.mouse.up()
    assert.equal(await page.locator('[role=gridcell][aria-selected="true"]').count(), 6)
    await page.keyboard.press("ControlOrMeta+c")
    await eventually(async () => (await page.evaluate(() => navigator.clipboard.readText())) === "Ramp\t\tLead\nBrex\t\tWon")

    // The guest sees the range in the owner's color.
    await eventually(async () => ((await cell(guest.page, 2, 1).getAttribute("style")) ?? "").includes("color-mix"))

    // Shift-click extends from the cursor.
    await cell(page, 1, 3).click()
    await cell(page, 3, 4).click({ modifiers: ["Shift"] })
    assert.equal(await page.locator('[role=gridcell][aria-selected="true"]').count(), 6)
    await page.keyboard.press("ControlOrMeta+c")
    await eventually(async () => (await page.evaluate(() => navigator.clipboard.readText())) === "Fintech, B2B\t900\nFintech\t1100\nAI\t1500")

    // Paste a 4-row block at row 4: two rows exist, two are added; "lots" doesn't fit Employees and is reported.
    await page.evaluate(() =>
      navigator.clipboard.writeText('Plaid\thttps://plaid.com\tlead\t"fintech, ai"\t1,200\nStripe\thttps://stripe.com\tWon\tB2B\tlots\nNotion\t\tReplied\t\t300\nLinear\t\t\tSeed\t50\n'),
    )
    await cell(page, 4, 0).click()
    await page.keyboard.press("ControlOrMeta+v")
    await page.getByRole("status").getByText(/Pasted 19 of 20 cells\. Skipped 1 cell that didn't fit: Employees \(1\)\. For example, row 5: "Employees" is a Number column, and "lots" isn't a number\./).waitFor()
    await eventually(async () => (await content(t.id)).state.rowIds.length === 7)
    const after = (await content(t.id)).state
    const added = after.rowIds.slice(5)
    assert.equal(await value(t.id, d, t.name.id), "Plaid")
    assert.equal(await value(t.id, d, t.status.id), "Lead")
    assert.deepEqual(await value(t.id, d, "c_tags"), ["Fintech", "AI"])
    assert.equal(await value(t.id, d, "c_emp"), 1200)
    assert.equal(await value(t.id, e, "c_emp"), undefined)
    assert.equal(after.cells[`${added[0]}:${t.name.id}`]?.v, "Notion")
    assert.equal(after.cells[`${added[1]}:c_tags`]?.v?.[0], "Seed")
    // The pasted block stays selected.
    assert.equal(await page.locator('[role=gridcell][aria-selected="true"]').count(), 20)

    // One value pasted over a range fills it.
    await page.evaluate(() => navigator.clipboard.writeText("Won"))
    await cell(page, 1, 2).click()
    await cell(page, 3, 2).click({ modifiers: ["Shift"] })
    await page.keyboard.press("ControlOrMeta+v")
    await eventually(async () => (await value(t.id, a, t.status.id)) === "Won" && (await value(t.id, c, t.status.id)) === "Won")

    // Delete clears the range (and nothing outside it).
    await cell(page, 1, 3).click()
    await page.keyboard.press("Shift+ArrowDown")
    await page.keyboard.press("Shift+ArrowRight")
    await page.keyboard.press("Delete")
    await eventually(async () => (await value(t.id, a, "c_tags")) === undefined && (await value(t.id, b, "c_emp")) === undefined)
    assert.equal(await value(t.id, c, "c_emp"), 1500)
    assert.equal(await value(t.id, a, t.name.id), "Ramp")

    // Guests can copy but not paste.
    await cell(guest.page, 1, 0).click()
    await guest.page.keyboard.press("ControlOrMeta+v")
    await settle()
    assert.equal(await value(t.id, a, t.name.id), "Ramp")
    assert.deepEqual([...errors, ...guest.errors], [])
  })
})

describe("table ux: rows", () => {
  test("check rows (shift for a range), set a field on all, clear, delete", async () => {
    const t = await companies("row selection")
    const [a, b, c, d] = t.rows
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 800 })
    await visit(page, `${BASE}/tables/${t.id}`, page.getByText("Ramp"))
    await page.getByRole("row").nth(1).hover()
    await page.getByRole("checkbox", { name: "Select row 1" }).click()
    // Once any row is checked, every checkbox shows without hovering.
    assert.ok(await page.getByRole("checkbox", { name: "Select row 3" }).isVisible())
    await page.getByRole("checkbox", { name: "Select row 3" }).click({ modifiers: ["Shift"] })
    const bar = page.getByRole("toolbar", { name: "Selected rows" })
    assert.match(await bar.innerText(), /3 selected/)

    await bar.getByRole("button", { name: "Set field…" }).click()
    await bar.getByRole("combobox", { name: "Field to set" }).selectOption({ label: "Status" })
    await bar.getByRole("combobox", { name: "Value" }).selectOption("Replied")
    await bar.getByRole("button", { name: "Set 3 rows" }).click()
    await eventually(async () => {
      const s = (await content(t.id)).state
      return [a, b, c].every((r) => s.cells[`${r}:${t.status.id}`]?.v === "Replied") && !s.cells[`${d}:${t.status.id}`]
    })

    // Multi-select bulk values take "a, b".
    await bar.getByRole("button", { name: "Set field…" }).click()
    await bar.getByRole("combobox", { name: "Field to set" }).selectOption({ label: "Tags" })
    await bar.getByRole("textbox", { name: "Value" }).fill("seed, ai")
    await bar.getByRole("button", { name: "Set 3 rows" }).click()
    await eventually(async () => JSON.stringify(await value(t.id, c, "c_tags")) === JSON.stringify(["Seed", "AI"]))

    // Delete asks once more, then removes exactly the checked rows.
    await bar.getByRole("button", { name: "Delete 3 rows" }).click()
    assert.equal((await content(t.id)).state.rowIds.length, 5)
    await bar.getByRole("button", { name: /Delete 3 rows\? Click again/ }).click()
    await eventually(async () => (await content(t.id)).state.rowIds.length === 2)
    assert.deepEqual((await content(t.id)).state.rowIds, [d, t.rows[4]])
    assert.equal(await bar.count(), 0)

    // Esc clears a selection without touching anything.
    await page.getByRole("row").nth(1).hover()
    await page.getByRole("checkbox", { name: "Select row 1" }).click()
    await cell(page, 2, 0).click()
    await page.keyboard.press("Escape")
    assert.equal(await bar.count(), 0)
    assert.equal((await content(t.id)).state.rowIds.length, 2)
    assert.deepEqual(errors, [])
  })
})

describe("table ux: columns", () => {
  test("resize, drag to reorder, and hide just for me", async () => {
    const t = await companies("columns")
    const { page, errors } = await open(browser, "owner", { width: 1600, height: 800 })
    const other = await open(browser, "owner", { width: 1600, height: 800 })
    await visit(page, `${BASE}/tables/${t.id}`, page.getByText("Ramp"))
    await visit(other.page, `${BASE}/tables/${t.id}`, other.page.getByText("Ramp"))

    // Drag Name's right edge 80px wider; the width is stored for everyone.
    const edge = (await page.getByRole("separator", { name: "Resize Name" }).boundingBox())!
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 10)
    await page.mouse.down()
    await page.mouse.move(edge.x + edge.width / 2 + 80, edge.y + 10, { steps: 5 })
    await page.mouse.up()
    await eventually(async () => (await columnOf(t.id, t.name.id)).width === 300)

    // Drag Employees before Website.
    const emp = (await page.getByRole("columnheader", { name: /Employees/ }).boundingBox())!
    const web = (await page.getByRole("columnheader", { name: /Website/ }).boundingBox())!
    await drag(page, { x: emp.x + 40, y: emp.y + emp.height / 2 }, { x: web.x + 20, y: web.y + web.height / 2 })
    await eventually(async () => (await content(t.id)).state.columns.map((c: { name: string }) => c.name).join() === "Name,Employees,Website,Status,Tags")
    await eventually(async () => (await other.page.getByRole("columnheader").allInnerTexts()).join() === "Name,Employees,Website,Status,Tags")

    // Hide Website from its menu: gone for me, still there for the other viewer and in the data.
    await page.getByRole("columnheader", { name: /Website/ }).hover()
    await page.getByRole("button", { name: "Website options" }).click()
    await page.getByRole("button", { name: /Hide field/ }).click()
    assert.deepEqual(await page.getByRole("columnheader").allInnerTexts(), ["Name", "Employees", "Status", "Tags"])
    await page.getByRole("button", { name: "1 hidden" }).waitFor()
    assert.equal((await other.page.getByRole("columnheader").allInnerTexts()).length, 5)
    await page.getByRole("button", { name: "1 hidden" }).click()
    await page.getByRole("button", { name: "Show all" }).click()
    assert.equal((await page.getByRole("columnheader").allInnerTexts()).length, 5)
    assert.deepEqual([...errors, ...other.errors], [])
  })
})

describe("table ux: find, sort, filter", () => {
  test("per-viewer search, sort and filters don't change anyone else's view", async () => {
    const t = await companies("find sort filter")
    const { page, errors } = await open(browser, "owner", { width: 1600, height: 800 })
    const other = await open(browser, "owner", { width: 1600, height: 800 })
    await visit(page, `${BASE}/tables/${t.id}`, page.getByText("Ramp"))
    await visit(other.page, `${BASE}/tables/${t.id}`, other.page.getByText("Ramp"))
    // The value is the cell's last line (another viewer's cell may also carry a presence name tag).
    const names = async (p: Page) =>
      (await p.locator(`[data-cell$=":${t.name.id}"]`).allInnerTexts()).map((x) => x.split("\n").at(-1) ?? "").filter(Boolean)

    // Search (Cmd/Ctrl+F from the grid) highlights matches; Enter steps through them, selecting each.
    await cell(page, 5, 0).click()
    await page.keyboard.press("ControlOrMeta+f")
    await page.keyboard.type("p")
    assert.equal(await page.locator("mark").count(), 2)
    await page.keyboard.press("Enter")
    const selected = () => page.locator('[role=gridcell][aria-selected="true"]').innerText()
    await page.getByText("1/2").waitFor()
    await eventually(async () => (await selected()) === "Ramp")
    await page.keyboard.press("Enter")
    await page.getByText("2/2").waitFor()
    await eventually(async () => (await selected()) === "Anthropic")
    await page.keyboard.press("Escape")
    assert.equal(await page.locator("mark").count(), 0)

    // Sort by Employees, largest first, from the header menu.
    await page.getByRole("columnheader", { name: /Employees/ }).hover()
    await page.getByRole("button", { name: "Employees options" }).click()
    await page.getByRole("button", { name: /Sort Z → A/ }).click()
    assert.deepEqual(await names(page), ["Anthropic", "Brex", "Ramp"])
    await page.getByRole("button", { name: "Sorted by Employees" }).waitFor()
    assert.deepEqual(await names(other.page), ["Ramp", "Brex", "Anthropic"])
    assert.equal((await content(t.id)).state.rowIds[0], t.rows[0])

    // Filter: Status is Won.
    await page.getByRole("button", { name: "Filter" }).click()
    await page.getByRole("button", { name: "Add filter" }).click()
    await page.getByRole("combobox", { name: "Filter field" }).selectOption({ label: "Status" })
    await page.getByRole("combobox", { name: "Filter value" }).selectOption("Won")
    await eventually(async () => (await names(page)).join() === "Anthropic,Brex")
    await page.getByText("2 of 5 rows").waitFor()
    // Tags "has" and "is empty" filters.
    await page.getByRole("combobox", { name: "Filter field" }).selectOption({ label: "Tags" })
    await page.getByRole("combobox", { name: "Filter value" }).selectOption("Fintech")
    await eventually(async () => (await names(page)).join() === "Brex,Ramp")
    await page.getByRole("combobox", { name: "Filter condition" }).selectOption({ label: "is empty" })
    // Rows minus the header and the summary footer.
    await eventually(async () => (await page.getByRole("row").count()) - 2 === 2)
    await page.getByRole("combobox", { name: "Filter condition" }).selectOption({ label: "has" })
    await page.getByRole("combobox", { name: "Filter value" }).selectOption("Fintech")
    await page.keyboard.press("Escape")
    await eventually(async () => (await names(page)).join() === "Brex,Ramp")

    // Editing a row so it stops matching doesn't make it vanish under the cursor.
    await cell(page, 1, 3).click()
    await page.keyboard.press("Enter")
    await page.getByRole("dialog", { name: "Choose Tags" }).getByRole("option", { name: "Fintech" }).click()
    await eventually(async () => (await value(t.id, t.rows[1], "c_tags")) === undefined)
    await page.keyboard.press("Escape")
    assert.deepEqual(await names(page), ["Brex", "Ramp"])

    await page.getByRole("button", { name: "Reset view" }).click()
    assert.deepEqual(await names(page), ["Ramp", "Brex", "Anthropic"])
    assert.deepEqual(await names(other.page), ["Ramp", "Brex", "Anthropic"])
    assert.deepEqual([...errors, ...other.errors], [])
  })
})
