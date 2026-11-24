import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, call, cleanup, content, create, eventually, launch, open, ops, viewAsOnly, visit } from "./harness.ts"

/**
 * Artifact columns: a cell holds a list of references to other artifacts or
 * items in them, including rows of its own table. Stored as ids, read as titles,
 * and never showing a viewer the title of something they can't open.
 */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
const LINKS = "c_links"
const value = async (id: string, rowId: string, colId = LINKS) => (await content(id)).state.cells[`${rowId}:${colId}`]?.v
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A table with Name, Website, Status and Links (artifact), and Ada and Grace in its first two rows. */
async function people(title: string) {
  const t = await create("table", title)
  const { state } = await content(t.id)
  const [name, website] = state.columns as Array<{ id: string }>
  const [ada, grace, third] = state.rowIds as [string, string, string]
  const seeded = await ops(t.id, [
    { type: "addColumn", column: { id: LINKS, name: "Links", type: "artifact" } },
    { type: "setCell", rowId: ada, colId: name!.id, value: "Ada" },
    { type: "setCell", rowId: grace, colId: name!.id, value: "Grace" },
  ])
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body))
  return { ...t, ada, grace, third, nameId: name!.id, websiteId: website!.id }
}

const cellAt = (page: Page, rowId: string, colId = LINKS) => page.locator(`[data-cell="${rowId}:${colId}"]`)
const picker = (page: Page) => page.getByRole("dialog", { name: "Link an artifact" })

async function openTable(page: Page, id: string) {
  await visit(page, `${BASE}/tables/${id}`, page.getByText("Ada", { exact: true }))
}

describe("artifact cells: what they store", () => {
  test("ids, items and links are kept in one form, without repeats; anything else is refused", async () => {
    const t = await people("links store")
    const write = (v: unknown) => ops(t.id, [{ type: "setCell", rowId: t.ada, colId: LINKS, value: v }])

    assert.equal((await write(["d_one", "b_two#s_plan", "d_one"])).status, 200)
    assert.deepEqual(await value(t.id, t.ada), ["d_one", "b_two#s_plan"])

    // Text splits like a multi-select, and a link from any host keeps only what it points at.
    assert.equal((await write(`d_one, https://standardartifacts.com/tables/${t.id}/r_x\nhttp://localhost:5173/issues/i_abc/12`)).status, 200)
    assert.deepEqual(await value(t.id, t.ada), ["d_one", `${t.id}#r_x`, "i_abc#12"])

    for (const bad of ["Acme", "../../share/exit", ["d_one", "not a ref"], "https://example.com/pricing", 5, true]) {
      const r = await write(bad)
      assert.equal(r.status, 400, `${JSON.stringify(bad)} should be refused`)
      assert.match(r.body.message, /"Links" links to artifacts/)
    }
    assert.deepEqual(await value(t.id, t.ada), ["d_one", `${t.id}#r_x`, "i_abc#12"], "a refused write changes nothing")

    const many = Array.from({ length: 101 }, (_, i) => `d_${i}`).join(",")
    assert.match((await write(many)).body.message, /up to 100 links/)

    assert.equal((await write(null)).status, 200)
    assert.equal(await value(t.id, t.ada), undefined)
  })

  test("changing a column's type converts what converts and loses nothing", async () => {
    const t = await people("links convert")
    const setType = (type: string) => ops(t.id, [{ type: "updateColumn", id: t.websiteId, patch: { type } }])
    await ops(t.id, [
      { type: "setCell", rowId: t.ada, colId: t.websiteId, value: "d_one, b_two#s_plan" },
      { type: "setCell", rowId: t.grace, colId: t.websiteId, value: "Acme" },
    ])
    assert.equal((await setType("artifact")).status, 200)
    assert.deepEqual(await value(t.id, t.ada, t.websiteId), ["d_one", "b_two#s_plan"])
    assert.equal(await value(t.id, t.grace, t.websiteId), "Acme", "left as it was, for the grid to flag")

    assert.equal((await setType("text")).status, 200)
    assert.equal(await value(t.id, t.ada, t.websiteId), "d_one, b_two#s_plan")
    assert.equal(await value(t.id, t.grace, t.websiteId), "Acme")
  })
})

describe("artifact cells in the grid", () => {
  test("the picker links several things, including a row of this table; X and Backspace remove; chips open them", async () => {
    const t = await people(`Team ${stamp()}`)
    const d = await create("doc", `Brief ${stamp()}`)
    const b = await create("board", `Plan ${stamp()}`)
    const { page, errors } = await open(browser)
    await openTable(page, t.id)

    await cellAt(page, t.ada).click()
    await page.keyboard.press("Enter")
    const search = picker(page).getByRole("textbox")

    // A doc has no items to choose from, so it's picked at once. The picker stays open and starts over.
    await search.fill(d.title)
    await page.keyboard.press("Enter")
    await eventually(async () => same(await value(t.id, t.ada), [d.id]))
    await eventually(async () => (await search.inputValue()) === "")

    // This table is on the list, and one of its rows can be chosen.
    await search.fill(t.title)
    await page.keyboard.press("Enter")
    await picker(page).getByRole("option", { name: "Grace" }).click()
    await eventually(async () => same(await value(t.id, t.ada), [d.id, `${t.id}#${t.grace}`]))

    await search.fill(b.title)
    await page.keyboard.press("Enter")
    await picker(page).getByRole("option", { name: "Whole board" }).click()
    await eventually(async () => same(await value(t.id, t.ada), [d.id, `${t.id}#${t.grace}`, b.id]))

    // Linking the same thing twice changes nothing.
    await search.fill(d.title)
    await page.keyboard.press("Enter")
    assert.deepEqual(await value(t.id, t.ada), [d.id, `${t.id}#${t.grace}`, b.id])

    // Removing keeps the picker open, with the keyboard in its search.
    await page.getByRole("button", { name: `Remove ${d.title}` }).click()
    await eventually(async () => same(await value(t.id, t.ada), [`${t.id}#${t.grace}`, b.id]))
    assert.equal(await search.evaluate((el) => el === document.activeElement), true)
    await page.keyboard.press("Backspace")
    await eventually(async () => same(await value(t.id, t.ada), [`${t.id}#${t.grace}`]))

    // Esc closes it and the keyboard drives the grid again.
    await page.keyboard.press("Escape")
    await picker(page).waitFor({ state: "detached" })
    await page.keyboard.press("ArrowDown")
    await page.locator(`[data-cell="${t.grace}:${LINKS}"][aria-selected="true"]`).waitFor()

    // A chip can fill its cell, so the first click selects it and a double-click edits it.
    const chip = cellAt(page, t.ada).locator(`[data-chip="${t.id}"]`).getByText("Grace")
    await chip.click()
    await page.locator(`[data-cell="${t.ada}:${LINKS}"][aria-selected="true"]`).waitFor()
    assert.ok(!page.url().includes(t.grace), "the first click only selects")
    // The keyboard still drives the grid, so Enter edits rather than following the link.
    await page.keyboard.press("Enter")
    await picker(page).waitFor()
    await page.keyboard.press("Escape")
    await picker(page).waitFor({ state: "detached" })
    await cellAt(page, t.grace).click()
    await chip.dblclick()
    await picker(page).waitFor()
    assert.ok(!page.url().includes(t.grace), "a double-click edits")
    await page.keyboard.press("Escape")
    await picker(page).waitFor({ state: "detached" })

    // Once selected, a click opens it: a row on its own page, in the record panel.
    await chip.click()
    await page.waitForURL(`**/tables/${t.id}/${t.grace}`)
    await page.getByRole("complementary", { name: "Record" }).waitFor()
    assert.deepEqual(errors, [])
  })

  test("the picker draws over the grid's sticky header and footer, with its links in view", async () => {
    const t = await people(`Layers ${stamp()}`)
    const docs = await Promise.all(["One", "Two", "Three"].map((n) => create("doc", `${n} ${stamp()}`)))
    await ops(t.id, [{ type: "setCell", rowId: t.ada, colId: LINKS, value: docs.map((d) => d.id) }])
    const { page, errors } = await open(browser, "owner", { width: 1280, height: 520 })
    await openTable(page, t.id)
    await cellAt(page, t.ada).click({ position: { x: 170, y: 18 } })
    await page.keyboard.press("Enter")
    await picker(page).waitFor()
    await page.waitForTimeout(200)

    const list = page.getByRole("list", { name: "Links links" })
    /** Points down the middle of `el` that are on screen, and what's on top wherever that isn't `el`. */
    const covering = (el: HTMLElement | SVGElement) => {
      const box = el.getBoundingClientRect()
      const covers: Array<string> = []
      let points = 0
      for (let y = box.top + 4; y < Math.min(box.bottom, window.innerHeight); y += 12) {
        points++
        const hit = document.elementFromPoint(box.left + box.width / 2, y)
        if (!hit || !el.contains(hit)) covers.push(`${Math.round(y)}: ${hit?.tagName} ${hit?.getAttribute("role") ?? ""} ${hit?.className}`.slice(0, 90))
      }
      return { points, covers, top: Math.round(box.top), bottom: Math.round(box.bottom) }
    }
    for (const part of [list, picker(page)]) {
      const seen = await part.evaluate(covering)
      assert.ok(seen.points > 0, "it's on screen")
      assert.deepEqual(seen.covers, [], `nothing covers it: ${JSON.stringify(seen)}`)
    }
    assert.deepEqual(errors, [])
  })

  test("typing on a cell searches, and pasting an app link adds it, in the cell or in the picker", async () => {
    const t = await people(`Paste ${stamp()}`)
    const d = await create("doc", `Memo ${stamp()}`)
    const b = await create("board", `Roadmap ${stamp()}`)
    const { page, errors } = await open(browser)
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await openTable(page, t.id)

    // A pasted link becomes a reference, and text that isn't one is reported.
    await page.evaluate((text) => navigator.clipboard.writeText(text), `${BASE}/docs/${d.id}`)
    await cellAt(page, t.ada).click()
    await page.keyboard.press("ControlOrMeta+v")
    await eventually(async () => same(await value(t.id, t.ada), [d.id]))
    await cellAt(page, t.ada).getByText(d.title).waitFor()

    await page.evaluate(() => navigator.clipboard.writeText("not a link"))
    await cellAt(page, t.grace).click()
    await page.keyboard.press("ControlOrMeta+v")
    await page.getByRole("status").getByText(/links to artifacts/).waitFor()
    assert.equal(await value(t.id, t.grace), undefined)

    // In the picker, a link adds to what's there; other text stays a search.
    await page.evaluate((text) => navigator.clipboard.writeText(text), `${BASE}/boards/${b.id}/s_plan`)
    await cellAt(page, t.ada).click()
    await page.keyboard.press("Enter")
    await picker(page).getByRole("textbox").waitFor()
    await page.keyboard.press("ControlOrMeta+v")
    await eventually(async () => same(await value(t.id, t.ada), [d.id, `${b.id}#s_plan`]))
    await page.keyboard.press("Escape")

    await cellAt(page, t.grace).click()
    await page.keyboard.type("Roadm")
    assert.equal(await picker(page).getByRole("textbox").inputValue(), "Roadm")
    await picker(page).getByRole("option", { name: b.title }).waitFor()
    assert.deepEqual(errors, [])
  })

  test("chips follow renames; search, filters and sorting read titles, not ids", async () => {
    const t = await people(`View ${stamp()}`)
    const unique = stamp()
    const alpha = await create("doc", `Alpha ${unique}`)
    const zulu = await create("doc", `Zulu ${unique}`)
    await ops(t.id, [
      { type: "setCell", rowId: t.ada, colId: LINKS, value: [zulu.id] },
      { type: "setCell", rowId: t.grace, colId: LINKS, value: [alpha.id] },
    ])
    const { page, errors } = await open(browser)
    await openTable(page, t.id)
    const names = async () =>
      (await page.locator(`[data-cell$=":${t.nameId}"]`).allInnerTexts()).map((x) => x.split("\n").at(-1) ?? "").filter(Boolean)
    assert.deepEqual(await names(), ["Ada", "Grace"])

    // Sorted by what people see: Alpha before Zulu, whatever order the ids are in.
    await page.getByRole("columnheader", { name: /Links/ }).hover()
    await page.getByRole("button", { name: "Links options" }).click()
    await page.getByRole("button", { name: /Sort A → Z/ }).click()
    await eventually(async () => (await names()).join() === "Grace,Ada")

    // Search finds the title and not the id.
    await cellAt(page, t.ada, t.nameId).click()
    await page.keyboard.press("ControlOrMeta+f")
    await page.keyboard.type(`Zulu ${unique}`)
    await page.keyboard.press("Enter")
    await page.getByText("1/1").waitFor()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type(zulu.id)
    await page.getByText("1/1").waitFor({ state: "detached" })
    await page.keyboard.press("Escape")

    // So does a filter.
    await page.getByRole("button", { name: "Filter" }).click()
    await page.getByRole("button", { name: "Add filter" }).click()
    await page.getByRole("combobox", { name: "Filter field" }).selectOption({ label: "Links" })
    await page.getByRole("textbox", { name: "Filter value" }).fill("alpha")
    await eventually(async () => (await names()).join() === "Grace")
    await page.getByRole("combobox", { name: "Filter condition" }).selectOption({ label: "is empty" })
    await eventually(async () => !(await names()).includes("Grace"))

    // The chip reads the current title. A new page, since this one only hears of renames it makes.
    const renamed = `Renamed ${stamp()}`
    assert.equal((await call("PATCH", `/artifacts/${alpha.id}`, { title: renamed })).status, 200)
    const fresh = await open(browser)
    await openTable(fresh.page, t.id)
    await cellAt(fresh.page, t.grace).locator(`[data-chip="${alpha.id}"]`).getByText(renamed).waitFor()
    assert.deepEqual([...errors, ...fresh.errors], [])
  })

  test("the record panel and kanban cards show the same links; viewers can't edit them", viewAsOnly, async () => {
    const t = await people(`Record ${stamp()}`)
    const d = await create("doc", `Spec ${stamp()}`)
    const e = await create("doc", `Notes ${stamp()}`)
    await ops(t.id, [{ type: "setCell", rowId: t.ada, colId: LINKS, value: [d.id] }])
    const { page, errors } = await open(browser)
    await openTable(page, t.id)

    await cellAt(page, t.ada, t.nameId).click()
    await page.keyboard.press(" ")
    const panel = page.getByRole("complementary", { name: "Record" })
    await panel.locator(`[data-chip="${d.id}"]`).waitFor()
    await panel.getByRole("button", { name: "Edit Links" }).click()
    await picker(page).getByRole("textbox").fill(e.title)
    await page.keyboard.press("Enter")
    await eventually(async () => same(await value(t.id, t.ada), [d.id, e.id]))
    await page.keyboard.press("Escape")
    await picker(page).waitFor({ state: "detached" })
    await panel.waitFor()
    await panel.locator(`[data-chip="${e.id}"]`).waitFor()
    await panel.getByRole("button", { name: "Close" }).click()

    await page.getByRole("tab", { name: "Kanban" }).click()
    await page.locator("article", { hasText: "Ada" }).locator(`[data-chip="${d.id}"]`).waitFor()
    await page.getByRole("tab", { name: "Grid" }).click()

    const viewer = await open(browser, "viewer")
    await openTable(viewer.page, t.id)
    await cellAt(viewer.page, t.ada).locator(`[data-chip="${d.id}"]`).waitFor()
    await cellAt(viewer.page, t.grace).click()
    await viewer.page.keyboard.press("Enter")
    assert.equal(await picker(viewer.page).count(), 0)
    assert.deepEqual([...errors, ...viewer.errors], [])
  })

  test("what's gone says so; a share-link guest sees no title and fetches nothing it can't open", async () => {
    const t = await people(`Shared ${stamp()}`)
    const secret = `Secret ${stamp()}`
    const b = await create("board", secret)
    await ops(b.id, [{ type: "insert", item: { id: "s_plan", kind: "note", x: 0, y: 0, w: 240, h: 160, color: "green", text: "The hidden plan" } }])
    // Wide enough to show every chip: one clipped by its cell doesn't load its item's name.
    await ops(t.id, [
      { type: "updateColumn", id: LINKS, patch: { width: 700 } },
      { type: "setCell", rowId: t.ada, colId: LINKS, value: [b.id, `${b.id}#s_plan`] },
      { type: "setCell", rowId: t.grace, colId: LINKS, value: ["d_doesnotexist", `${b.id}#s_gone`] },
    ])

    const owner = await open(browser)
    await openTable(owner.page, t.id)
    // Item chips show their artifact's title until the item's name loads.
    await cellAt(owner.page, t.ada).getByText("The hidden plan").waitFor()
    await cellAt(owner.page, t.ada).getByText(secret).waitFor()
    await eventually(async () => (await cellAt(owner.page, t.grace).getByText("Unavailable").count()) === 2)

    const link = await call("POST", `/artifacts/${t.id}/link`)
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const guest = await ctx.newPage()
    const fetched: Array<string> = []
    guest.on("response", (r) => r.url().includes(b.id) && fetched.push(`${r.status()} ${r.url()}`))
    await guest.goto(`${BASE}${link.body.path}`)
    await guest.getByText("Ada", { exact: true }).waitFor()
    await eventually(async () => (await cellAt(guest, t.ada).getByText("Unavailable").count()) === 2)
    const text = await guest.locator("body").innerText()
    assert.ok(!text.includes(secret) && !text.includes("The hidden plan"), "the guest must not see what it links to")
    assert.deepEqual(fetched, [], "the guest's page must not ask for it")
  })

  test("a doc's previews of the table and Home's show titles, and a new column can be added from the + menu", async () => {
    const t = await people(`Preview ${stamp()}`)
    const linked = await create("doc", `Linked ${stamp()}`)
    await ops(t.id, [{ type: "setCell", rowId: t.ada, colId: LINKS, value: [linked.id] }])
    const d = await create("doc", "links preview")
    await ops(d.id, [
      { type: "insert", item: { id: "k_table", type: "embed", text: "", ref: { artifactId: t.id } } },
      { type: "insert", item: { id: "k_row", type: "embed", text: "", ref: { artifactId: t.id, item: t.ada } } },
    ])
    const { page, errors } = await open(browser)
    await visit(page, `${BASE}/docs/${d.id}`, page.locator('[data-block-id="k_table"]').getByText(linked.title))
    await page.locator('[data-block-id="k_row"]').getByText(linked.title).waitFor()
    const shown = await page.locator('[data-block-id="k_table"], [data-block-id="k_row"]').allInnerTexts()
    assert.ok(!shown.join(" ").includes(linked.id), "previews read titles, not ids")

    // Home shows a table's first three columns, so put Links among them. Its title is then on two cards: the doc's and the table's.
    await ops(t.id, [{ type: "removeColumn", id: t.websiteId }])
    await page.goto(`${BASE}/`)
    await eventually(async () => (await page.getByText(linked.title).count()) >= 2, 15000)
    assert.ok(!(await page.locator("body").innerText()).includes(linked.id), "Home reads titles, not ids")

    await openTable(page, t.id)
    await page.getByRole("button", { name: "Add column" }).click()
    await page.getByRole("listbox", { name: "Field types" }).getByRole("option", { name: /^Artifact/ }).click()
    await eventually(async () => (await content(t.id)).state.columns.filter((c: { type: string }) => c.type === "artifact").length === 2)
    assert.deepEqual(errors, [])
  })
})
