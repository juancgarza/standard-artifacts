import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Locator, Page } from "playwright-core"
import { BASE, call, cleanup, content, create, createFolder, eventually, launch, open, settle, socket, viewAsOnly, visit } from "./harness.ts"

/** Tabs in the shell: a strip over the page, one tab per page, and hidden tabs that hold no connection. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

const strip = (page: Page) => page.locator("[data-tab-strip]")
const tabNames = (page: Page) => page.locator('[data-tab-strip] [role="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))
const tab = (page: Page, title: string) => page.locator('[data-tab-strip] [role="tab"]', { hasText: title })
const row = (page: Page, title: string) => page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: title }).first()
const activeTab = (page: Page) => page.locator('[data-tab-strip] [role="tab"][aria-selected="true"]').getAttribute("aria-label")

async function shown(locator: Locator) {
  await locator.waitFor({ state: "visible" })
}

async function pageWithRows(titles: { kind: "board" | "doc" | "table"; label: string }[], size = { width: 1400, height: 820 }) {
  const stamp = Date.now()
  const made = await Promise.all(titles.map(({ kind, label }) => create(kind, `${label} ${stamp}`)))
  const { page, errors } = await open(browser, "owner", size)
  await visit(page, BASE, row(page, made[0]!.title))
  return { page, errors, made }
}

describe("tabs", () => {
  test("the strip shows even with one tab, whose + opens another; a click changes the tab, ⌘-click opens one behind it, an open page is never opened twice", async () => {
    const { page, errors, made } = await pageWithRows([
      { kind: "doc", label: "Tabs one" },
      { kind: "doc", label: "Tabs two" },
      { kind: "doc", label: "Tabs three" },
    ])
    const [one, two, three] = made as [(typeof made)[0], (typeof made)[0], (typeof made)[0]]

    // Nothing to discover: the strip is there from the first page, and + works with a mouse.
    assert.equal(await strip(page).getAttribute("data-tab-strip"), "open")
    await shown(strip(page))
    assert.ok((await strip(page).boundingBox())!.height >= 36, "one tab still shows the strip")
    assert.deepEqual(await tabNames(page), ["Home"])
    assert.equal(await page.locator("[data-tab-strip]").getByRole("button", { name: /^Close/ }).count(), 0, "the last tab can't be closed")

    await row(page, one.title).click()
    await page.waitForURL(`**/docs/${one.id}`)
    assert.deepEqual(await tabNames(page), [one.title], "a click changes the tab rather than adding one")

    await page.locator("[data-tab-strip]").getByRole("button", { name: "New tab", exact: true }).click()
    await page.waitForURL(`${BASE}/`)
    assert.deepEqual(await tabNames(page), [one.title, "Home"], "+ opens a tab")
    await page.locator("[data-tab-strip]").getByRole("button", { name: "Close Home" }).click()
    await page.waitForURL(`**/docs/${one.id}`)
    assert.deepEqual(await tabNames(page), [one.title])

    await row(page, two.title).click({ modifiers: ["Meta"] })
    await eventually(async () => (await tabNames(page)).length === 2)
    assert.ok(page.url().endsWith(one.id), "⌘-click stays on the current page")
    assert.equal(page.context().pages().length, 1, "and doesn't open a browser tab")
    assert.deepEqual(await tabNames(page), [one.title, two.title])

    await row(page, three.title).click({ button: "middle" })
    await eventually(async () => (await tabNames(page)).length === 3)
    assert.equal(await page.locator("[data-open-in-tab]").count() >= 2, true, "the sidebar marks what's open elsewhere")

    await row(page, three.title).click()
    await page.waitForURL(`**/docs/${three.id}`)
    await eventually(async () => (await activeTab(page)) === three.title)
    assert.equal((await tabNames(page)).length, 3, "a link to an open page jumps to its tab")

    // Back and Forward move across tabs, because the address is always the active tab.
    await page.goBack()
    await page.waitForURL(`**/docs/${one.id}`)
    await eventually(async () => (await activeTab(page)) === one.title)
    assert.equal((await tabNames(page)).length, 3)

    // A press selects: a browser's tabs do, and a drag starts from the same press.
    await page.mouse.move(0, 0)
    const box = (await tab(page, two.title).boundingBox())!
    await page.mouse.move(box.x + 20, box.y + 10)
    await page.mouse.down()
    await page.waitForURL(`**/docs/${two.id}`)
    await page.mouse.up()

    // Reloading keeps the set and the active tab.
    await page.reload()
    await shown(tab(page, three.title))
    assert.deepEqual(await tabNames(page), [one.title, three.title, two.title])
    assert.equal(await activeTab(page), two.title)
    assert.ok(page.url().endsWith(two.id))

    // Closing the active tab moves to its neighbour, and Back doesn't bring the closed page back.
    await page.getByRole("button", { name: `Close ${two.title}` }).click()
    await page.waitForURL(`**/docs/${three.id}`)
    await eventually(async () => (await activeTab(page)) === three.title)
    assert.deepEqual(await tabNames(page), [one.title, three.title])

    await tab(page, one.title).hover()
    await page.getByRole("button", { name: `Close ${one.title}` }).click()
    await eventually(async () => (await tabNames(page)).length === 1)
    assert.equal(await strip(page).getAttribute("data-tab-strip"), "open", "down to one tab, the strip stays")
    assert.ok(page.url().endsWith(three.id))
    assert.deepEqual(errors, [])
    await page.context().close()
  })

  test("drag to reorder; pin, close others and close to the right from the menu", async () => {
    const { page, errors, made } = await pageWithRows([
      { kind: "doc", label: "Order a" },
      { kind: "doc", label: "Order b" },
      { kind: "doc", label: "Order c" },
      { kind: "doc", label: "Order d" },
    ])
    const [a, b, c, d] = made.map((m) => m.title) as [string, string, string, string]
    await row(page, a).click()
    await page.waitForURL(`**/${made[0]!.id}`)
    for (const title of [d, c, b]) await row(page, title).click({ modifiers: ["Meta"] })
    await eventually(async () => (await tabNames(page)).length === 4)
    assert.deepEqual(await tabNames(page), [a, b, c, d], "new tabs open right after the current one")

    const from = (await tab(page, a).boundingBox())!
    const to = (await tab(page, b).boundingBox())!
    await page.mouse.move(from.x + 30, from.y + 12)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width * 0.8, from.y + 12, { steps: 10 })
    await settle(50)
    await page.mouse.up()
    assert.deepEqual(await tabNames(page), [b, a, c, d])
    assert.equal(await page.locator("[data-tab-id][data-dragging]").count(), 0)
    assert.equal(await page.locator("[data-tab-id]").first().evaluate((e) => (e as HTMLElement).style.transform), "")

    // Pinned tabs go first, show only an icon, and survive closing the others.
    await tab(page, d).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Pin tab" }).click()
    assert.deepEqual(await tabNames(page), [d, b, a, c])
    assert.ok((await page.locator(`[data-tab-id][data-pinned]`).boundingBox())!.width < 40)

    await tab(page, b).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Close to the right" }).click()
    assert.deepEqual(await tabNames(page), [d, b])

    // A link followed from a pinned tab opens a new tab, and the pin stays on its page.
    await page.locator('[data-tab-id][data-pinned] [role="tab"]').click()
    await page.waitForURL(`**/${made[3]!.id}`)
    await row(page, a).click()
    await page.waitForURL(`**/${made[0]!.id}`)
    assert.deepEqual(await tabNames(page), [d, a, b])

    await tab(page, b).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Close others" }).click()
    assert.deepEqual(await tabNames(page), [d, b], "pinned tabs stay")
    await eventually(async () => (await activeTab(page)) === b)

    // The sidebar's menu opens in a new tab too; pages' own links keep the browser's menu.
    await row(page, c).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Open in new tab" }).click()
    await eventually(async () => (await tabNames(page)).includes(c))
    assert.deepEqual(errors, [])
    await page.context().close()
  })

  test("a hidden tab keeps its state but no connection, and nobody sees you on it", async () => {
    const { page, errors, made } = await pageWithRows([
      { kind: "board", label: "Kept board" },
      { kind: "doc", label: "Kept doc" },
    ])
    const [board, doc] = made as [(typeof made)[0], (typeof made)[0]]

    // Someone else in the board's room, watching who's there.
    const watcher = socket(board.id, "agent")
    await watcher.ready
    await eventually(() => watcher.messages.some((m) => m.type === "init"))
    const humans = () => {
      const here = new Map<string, string>()
      for (const m of watcher.messages) {
        if (m.type === "init") for (const x of m.members) here.set(x.connectionId, x.actor.type)
        if (m.type === "join") here.set(m.member.connectionId, m.member.actor.type)
        if (m.type === "leave") here.delete(m.connectionId)
      }
      return [...here.values()].filter((t) => t !== "agent").length
    }

    await row(page, board.title).click()
    await page.waitForURL(`**/boards/${board.id}`)
    await eventually(() => humans() === 1)

    // Zoom in, so there's a camera to lose.
    const zoom = page.getByRole("button", { name: "Zoom", exact: true })
    await shown(zoom)
    const original = await zoom.textContent()
    await zoom.click()
    await page.getByRole("menuitem", { name: /Zoom in/ }).click()
    await page.keyboard.press("Escape")
    await eventually(async () => (await zoom.textContent()) !== original)
    const zoomed = await zoom.textContent()

    await row(page, doc.title).click({ modifiers: ["Meta"] })
    await tab(page, doc.title).click()
    await page.waitForURL(`**/docs/${doc.id}`)
    await eventually(() => humans() === 0, 8000)

    // Typing right before leaving must reach the cell, even though the room is closing.
    const text = `kept ${Date.now()}`
    const block = page.locator("[data-block-id] [role=textbox]").first()
    await block.click()
    await page.keyboard.type(text)
    await tab(page, board.title).click()
    await page.waitForURL(`**/boards/${board.id}`)
    await eventually(async () => JSON.stringify(await content(doc.id)).includes(text), 8000)

    // Back on the board: the same camera, the same content at once, and in the room again.
    assert.equal(await zoom.textContent(), zoomed, "the camera comes back as it was")
    await eventually(() => humans() === 1, 8000)

    // And the doc shows what was typed the moment it's back, with no empty flash.
    await tab(page, doc.title).click()
    await page.waitForURL(`**/docs/${doc.id}`)
    assert.ok((await block.textContent())?.includes(text))
    await settle(600)
    assert.equal(((await block.textContent())?.match(new RegExp(text, "g")) ?? []).length, 1, "and only once")
    const stored = JSON.stringify((await content(doc.id)).state.items)
    assert.equal((stored.match(new RegExp(text, "g")) ?? []).length, 1, "the cell has it once too")

    // Hidden pages don't answer the keyboard: only one board is listening.
    assert.equal(await page.locator("header:visible").count(), 1)
    watcher.ws.close()
    assert.deepEqual(errors, [])
    await page.context().close()
  })

  test("right-click archives and deletes artifacts, and deletes folders; viewers don't get either", viewAsOnly, async () => {
    const stamp = Date.now()
    const archived = await create("doc", `Menu archive ${stamp}`)
    const deleted = await create("doc", `Menu delete ${stamp}`)
    const open_ = await create("doc", `Menu open ${stamp}`)
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 820 })
    await visit(page, BASE, row(page, archived.title))
    const item = (name: string) => page.getByRole("menuitem", { name })
    const statusOf = async (id: string) => (await call("GET", `/artifacts/${id}/content`)).status

    // Archive is one click, and undoable: the content is still there.
    await row(page, archived.title).click({ button: "right" })
    await item("Archive doc").click()
    await row(page, archived.title).waitFor({ state: "detached" })
    assert.ok((await call("GET", "/artifacts/archived")).body.some((a: { id: string }) => a.id === archived.id))

    // Delete asks first; Cancel and Escape leave it alone.
    await row(page, deleted.title).click({ button: "right" })
    await item("Delete doc…").click()
    const confirm = page.getByRole("alertdialog", { name: "Delete this doc?" })
    await confirm.getByText(deleted.title).waitFor()
    await confirm.getByRole("button", { name: "Cancel" }).click()
    await item("Delete doc…").click()
    await page.keyboard.press("Escape")
    await confirm.waitFor({ state: "detached" })
    assert.equal(await statusOf(deleted.id), 200)
    await row(page, deleted.title).click({ button: "right" })
    await item("Delete doc…").click()
    await page.keyboard.press("Enter")
    await row(page, deleted.title).waitFor({ state: "detached" })
    assert.equal(await statusOf(deleted.id), 404)

    // Removing the page you're on leaves it, and its tab goes.
    await row(page, open_.title).click()
    await page.waitForURL(`**/docs/${open_.id}`)
    await row(page, open_.title).click({ button: "right" })
    await item("Delete doc…").click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
    await page.waitForURL(`${BASE}/`)
    assert.ok(!(await tabNames(page)).includes(open_.title))

    // Folders: no archive; deleting says where the contents go, and moves them there.
    const parent = await createFolder(`Menu parent ${stamp}`)
    const folder = await createFolder(`Menu folder ${stamp}`, parent.id)
    const inside = await create("doc", `Menu inside ${stamp}`)
    await call("POST", `/artifacts/${inside.id}/move`, { folderId: folder.id })
    await page.goto(`${BASE}/folders/${folder.id}`)
    const folderRow = page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: folder.name }).first()
    await folderRow.click({ button: "right" })
    await item("Delete folder…").waitFor()
    assert.equal(await page.getByRole("menuitem", { name: /Archive/ }).count(), 0)
    await item("Delete folder…").click()
    await page.getByRole("alertdialog").getByText(`will move to ${parent.name}`).waitFor()
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete folder" }).click()
    await page.waitForURL(`**/folders/${parent.id}`)
    const workspace = (await call("GET", "/workspace")).body
    assert.equal(workspace.folders.some((f: { id: string }) => f.id === folder.id), false)
    assert.equal(workspace.artifacts.find((a: { id: string }) => a.id === inside.id)?.folderId, parent.id)
    assert.deepEqual(errors, [])
    await page.context().close()

    const viewer = await open(browser, "viewer", { width: 1400, height: 820 })
    await visit(viewer.page, BASE, row(viewer.page, inside.title))
    await row(viewer.page, inside.title).click({ button: "right" })
    await viewer.page.getByRole("menuitem", { name: "Open", exact: true }).waitFor()
    assert.equal(await viewer.page.getByRole("menuitem", { name: /Archive|Delete/ }).count(), 0)
    await viewer.page.context().close()
  })

  test("a table cell being edited when you leave is saved", async () => {
    const { page, errors, made } = await pageWithRows([
      { kind: "table", label: "Saved table" },
      { kind: "doc", label: "Saved other" },
    ])
    const [table, other] = made as [(typeof made)[0], (typeof made)[0]]
    await row(page, table.title).click()
    await page.waitForURL(`**/tables/${table.id}`)
    await row(page, other.title).click({ modifiers: ["Meta"] })
    await eventually(async () => (await tabNames(page)).length === 2)

    const cell = page.locator('[role="gridcell"]').nth(1)
    await shown(cell)
    await cell.dblclick()
    const text = `cell ${Date.now()}`
    await page.keyboard.type(text)
    await tab(page, other.title).click()
    await page.waitForURL(`**/docs/${other.id}`)
    await eventually(async () => JSON.stringify(await content(table.id)).includes(text), 8000)
    assert.deepEqual(errors, [])
    await page.context().close()
  })

  test("tab shortcuts, and a keyboard that types with ⌥ keeps its characters", async () => {
    const { page, errors, made } = await pageWithRows([
      { kind: "doc", label: "Keys a" },
      { kind: "doc", label: "Keys b" },
    ])
    const [a, b] = made as [(typeof made)[0], (typeof made)[0]]
    await row(page, a.title).click()
    await page.waitForURL(`**/docs/${a.id}`)
    await row(page, b.title).click({ modifiers: ["Meta"] })
    await eventually(async () => (await tabNames(page)).length === 2)

    // What a Mac sends: the physical key, and the character ⌥ makes on this layout.
    const press = (code: string, key: string) =>
      page.evaluate(
        ({ code, key }) => {
          const e = new KeyboardEvent("keydown", { code, key, altKey: true, bubbles: true, cancelable: true })
          window.dispatchEvent(e)
          return e.defaultPrevented
        },
        { code, key },
      )
    const mac = await page.evaluate(() => /Mac|iP(hone|ad)/.test(navigator.platform))

    assert.equal(await press("BracketRight", "‘"), true)
    await page.waitForURL(`**/docs/${b.id}`)
    await eventually(async () => (await activeTab(page)) === b.title)

    if (mac) assert.equal(await press("BracketLeft", "["), false, "on a Spanish Mac this key types [, so it isn't ours")
    assert.ok(page.url().endsWith(b.id))

    assert.equal(await press("KeyT", "†"), true)
    await page.waitForURL(`${BASE}/`)
    await eventually(async () => (await tabNames(page)).includes("Home"))
    assert.equal(await press("KeyW", "∑"), true)
    await eventually(async () => !(await tabNames(page)).includes("Home"))

    // Search: ⌘↵ opens a result behind the current page.
    const [c] = await Promise.all([create("doc", `Keys c ${Date.now()}`)])
    await page.reload()
    await shown(tab(page, b.title))
    const before = page.url()
    await page.keyboard.press("Meta+k")
    await page.getByRole("combobox", { name: /Search boards/ }).fill(c.title)
    await page.getByRole("option", { name: c.title }).waitFor()
    await page.keyboard.press("Meta+Enter")
    await eventually(async () => (await tabNames(page)).includes(c.title))
    assert.equal(page.url(), before)
    assert.deepEqual(errors, [])
    await page.context().close()
  })

  test("archiving closes the tab; many tabs shrink, then scroll, with a list; a new window starts from the saved set", async () => {
    const { page, errors, made } = await pageWithRows([
      { kind: "doc", label: "Many a" },
      { kind: "doc", label: "Many b" },
    ])
    const [a, b] = made as [(typeof made)[0], (typeof made)[0]]
    await row(page, a.title).click()
    await page.waitForURL(`**/docs/${a.id}`)
    await row(page, b.title).click({ modifiers: ["Meta"] })
    await eventually(async () => (await tabNames(page)).length === 2)

    // The archived page's tab goes; with Home not open yet, this tab becomes Home.
    await page.getByRole("button", { name: "More", exact: true }).click()
    await page.getByRole("menuitem", { name: "Archive doc" }).click()
    await page.waitForURL(`${BASE}/`)
    await eventually(async () => {
      const names = await tabNames(page)
      return names.includes("Home") && !names.includes(a.title)
    })
    await call("POST", `/artifacts/${a.id}/restore`)

    // A window that isn't this one starts from what was saved, plus its own address.
    const second = await page.context().newPage()
    await visit(second, `${BASE}/docs/${b.id}`, tab(second, "Home"))
    assert.deepEqual((await tabNames(second)).sort(), ["Home", b.title].sort())
    assert.equal(await activeTab(second), b.title)
    await second.close()

    // Open plenty, at a narrow size: tabs stop at 120px, then the strip scrolls and offers the list.
    await page.setViewportSize({ width: 900, height: 700 })
    const more = await Promise.all(Array.from({ length: 8 }, (_, i) => create("table", `Many t${i} ${Date.now()}`)))
    await page.reload()
    await shown(tab(page, "Home"))
    await page.evaluate((hrefs) => {
      for (const href of hrefs) {
        const a = document.createElement("a")
        a.href = href
        document.body.append(a)
        a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, button: 0 }))
        a.remove()
      }
    }, more.map((m) => `/tables/${m.id}`))
    await eventually(async () => (await tabNames(page)).length === 10)
    const widths = await page.locator("[data-tab-id]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
    assert.ok(widths.every((w) => w >= 119.5 && w <= 200.5), `widths ${widths}`)
    const list = page.getByRole("button", { name: "All open tabs" })
    await shown(list)
    assert.equal((await list.textContent())?.trim(), "10")
    assert.ok((await page.getByRole("button", { name: "New tab", exact: true }).boundingBox())!.x < 900, "+ stays on screen")
    await list.click()
    await page.getByRole("menuitem", { name: more[7]!.title }).click()
    await page.waitForURL(`**/tables/${more[7]!.id}`)
    const box = (await tab(page, more[7]!.title).boundingBox())!
    assert.ok(box.x >= 248 && box.x + box.width <= 900, "the list brings the tab into view")
    assert.deepEqual(errors, [])
    await page.context().close()
  })

  test("small screens get a count and a list; a share-link guest gets no tabs", async () => {
    const doc = await create("doc", `Phone ${Date.now()}`)
    const { page, errors } = await open(browser, "owner", { width: 390, height: 780 })
    const count = page.getByRole("button", { name: /^Open tabs/ })
    await visit(page, `${BASE}/docs/${doc.id}`, count)
    assert.equal(await count.textContent(), "1")
    assert.equal(await strip(page).isVisible(), false)
    await count.click()
    await page.getByRole("button", { name: "New tab", exact: true }).click()
    await page.waitForURL(`${BASE}/`)
    await eventually(async () => (await count.textContent()) === "2")
    await count.click()
    await page.getByRole("dialog", { name: "Open tabs" }).getByRole("button", { name: doc.title, exact: true }).click()
    await page.waitForURL(`**/docs/${doc.id}`)
    assert.deepEqual(errors, [])
    await page.context().close()

    const shared = await create("doc", `Link only ${Date.now()}`)
    const link = await call("POST", `/artifacts/${shared.id}/link`)
    const guest = await browser.newContext({ viewport: { width: 1400, height: 820 } })
    const gpage = await guest.newPage()
    await gpage.goto(`${BASE}${link.body.path}`)
    await gpage.getByText("View only").waitFor()
    assert.equal(await strip(gpage).getAttribute("data-tab-strip"), "closed")
    assert.equal((await strip(gpage).boundingBox())!.height, 0, "a guest has one artifact, so no strip")
    await gpage.keyboard.press("Alt+KeyT")
    await settle(200)
    assert.ok(gpage.url().endsWith(shared.id), "the shortcuts are off too")
    await guest.close()
  })
})
