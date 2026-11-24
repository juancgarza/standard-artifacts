import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, call, cleanup, content, create, drag, eventually, launch, mcpSession, open, ops, settle, viewAsOnly } from "./harness.ts"

/**
 * Links on a board: a shape that previews another artifact or one item in it.
 * The canvas keeps its presses, so a card selects and drags like any shape;
 * double-click, Enter and the toolbar's link open it. Nobody sees the title of
 * something they can't open.
 */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

type Shape = { id: string; kind: string; x: number; y: number; w: number; h: number; ref?: { artifactId: string; item?: string } }

const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
const items = async (id: string): Promise<Array<Shape>> => (await content(id)).state.items
const links = async (id: string) => (await items(id)).filter((s) => s.kind === "artifact")
const shape = (page: Page, id: string) => page.locator(`[data-shape-id="${id}"]`)
const picker = (page: Page) => page.getByRole("dialog", { name: "Link an artifact" })

const bin = fileURLToPath(new URL("../../apps/cli/dist/stdartifacts.mjs", import.meta.url))
const cli = (...args: Array<string>) => {
  const r = spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, STDARTIFACTS_URL: BASE }, encoding: "utf8" })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

/** A board holding only an anchor note, and `extra`. */
async function board(title: string, extra: Array<Record<string, unknown>> = []) {
  const b = await create("board", title)
  const seeded = await items(b.id)
  const r = await ops(b.id, [
    { type: "remove", ids: seeded.map((s) => s.id) },
    { type: "insert", item: { id: "s_anchor", kind: "note", x: -300, y: 0, w: 200, h: 140, color: "yellow", text: "Anchor" } },
    ...extra.map((item) => ({ type: "insert", item })),
  ])
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return b
}

const link = (id: string, artifactId: string, item?: string) => ({ id, kind: "artifact", x: 0, y: 0, w: 400, h: 300, ref: { artifactId, ...(item && { item }) } })

async function openBoard(page: Page, id: string) {
  await page.goto(`${BASE}/boards/${id}`)
  await shape(page, "s_anchor").waitFor()
  await settle(300)
}

describe("board links: what they store", () => {
  test("only links have a ref, every link has one, and a shape can't turn into one", async () => {
    const b = await board(`rules ${stamp()}`)
    const refused = async (op: unknown, message: RegExp) => {
      const r = await ops(b.id, [op])
      assert.notEqual(r.status, 200)
      assert.match(JSON.stringify(r.body), message)
    }
    await refused({ type: "insert", item: { id: "s_x", kind: "artifact", x: 0, y: 0, w: 10, h: 10 } }, /A link needs a ref/)
    await refused({ type: "insert", item: { id: "s_y", kind: "note", x: 0, y: 0, w: 10, h: 10, ref: { artifactId: "t_abc" } } }, /Only links have a ref/)
    await refused({ type: "update", id: "s_anchor", patch: { kind: "artifact" } }, /to or from a link/)
    assert.equal((await ops(b.id, [{ type: "insert", item: link("s_ok", "t_abc") }])).status, 200)
    await refused({ type: "update", id: "s_ok", patch: { kind: "note" } }, /to or from a link/)
    // The rest of what a shape can do still works.
    assert.equal((await ops(b.id, [{ type: "update", id: "s_ok", patch: { x: 50, w: 500 } }])).status, 200)
    assert.equal((await ops(b.id, [{ type: "insert", item: { id: "s_arrow", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s_anchor", to: "s_ok" } }])).status, 200)
  })
})

describe("board links: on the canvas", () => {
  test("the toolbar's picker adds a whole artifact or one item, and the preview shows it", async () => {
    const title = `Launch plan ${stamp()}`
    const d = await create("doc", title)
    const t = await create("table", `Leads ${stamp()}`)
    const { state } = await content(t.id)
    await ops(t.id, [{ type: "setCell", rowId: state.rowIds[0], colId: state.columns[0].id, value: "Ada Lovelace" }])
    const b = await board(`picker ${stamp()}`)
    const { page, errors } = await open(browser)
    await openBoard(page, b.id)

    await page.getByRole("button", { name: "Link an artifact" }).click()
    // Letters are the search's, not the canvas's tool shortcuts ("n" would pick the note tool).
    await picker(page).getByRole("textbox").fill("")
    await page.keyboard.type(title)
    assert.equal(await page.getByRole("button", { name: "Select" }).getAttribute("aria-pressed"), "true")
    await picker(page).getByRole("option", { name: title }).click()
    await picker(page).waitFor({ state: "detached" })
    const [first] = await eventually(async () => {
      const l = await links(b.id)
      return l.length === 1 && l
    })
    assert.deepEqual(first!.ref, { artifactId: d.id })
    await shape(page, first!.id).getByText(title).first().waitFor()
    // It's selected, and the toolbar says what's linked.
    await page.getByRole("toolbar", { name: "Selection" }).getByRole("link", { name: title }).waitFor()

    await page.getByRole("button", { name: "Link an artifact" }).click()
    await picker(page).getByRole("option", { name: t.title }).click()
    await picker(page).getByRole("option", { name: "Ada Lovelace" }).click()
    const second = await eventually(async () => (await links(b.id)).find((s) => s.ref?.item))
    assert.deepEqual(second.ref, { artifactId: t.id, item: state.rowIds[0] })
    await shape(page, second.id).getByText("Ada Lovelace").first().waitFor()

    // The button toggles, and Esc closes and returns to the canvas.
    const button = page.getByRole("button", { name: "Link an artifact" })
    await button.click()
    await picker(page).waitFor()
    await button.click()
    await picker(page).waitFor({ state: "detached" })
    await button.click()
    await page.keyboard.press("Escape")
    await picker(page).waitFor({ state: "detached" })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Board canvas")
    assert.deepEqual(errors, [])
  })

  test("pasting this app's link adds it where the pointer is; other text doesn't", async () => {
    const d = await create("doc", `Pasted ${stamp()}`)
    const b = await board(`paste ${stamp()}`, [{ id: "s_item", kind: "note", x: -300, y: 300, w: 200, h: 140, color: "blue", text: "Item here" }])
    const { page } = await open(browser)
    await openBoard(page, b.id)
    const paste = (text: string) =>
      page.evaluate((t) => {
        const data = new DataTransfer()
        data.setData("text/plain", t)
        document.querySelector('[aria-label="Board canvas"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
      }, text)

    await paste(`${BASE}/docs/${d.id}`)
    await eventually(async () => (await links(b.id)).some((s) => s.ref?.artifactId === d.id))
    await paste(`${BASE}/boards/${b.id}/s_item`)
    await eventually(async () => (await links(b.id)).some((s) => s.ref?.item === "s_item"))

    await paste("https://example.com/docs/d_notours")
    await paste("just some words")
    await settle(400)
    assert.equal((await links(b.id)).length, 2)
  })

  test("a card selects and drags like a shape; double-click, Enter and the toolbar's link open it", async () => {
    const title = `Opens ${stamp()}`
    const d = await create("doc", title)
    const b = await board(`open ${stamp()}`, [link("s_link", d.id)])
    const { page } = await open(browser)
    await openBoard(page, b.id)
    const card = shape(page, "s_link")
    await card.getByText(title).first().waitFor()
    const center = async () => {
      const r = (await card.boundingBox())!
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    const url = page.url()

    // A click selects and stays here.
    let at = await center()
    await page.mouse.click(at.x, at.y)
    await page.getByRole("toolbar", { name: "Selection" }).waitFor()
    await settle(200)
    assert.equal(page.url(), url)

    // A drag moves it and stays here.
    const before = (await links(b.id))[0]!
    await drag(page, at, { x: at.x + 60, y: at.y + 40 })
    await eventually(async () => (await links(b.id))[0]!.x > before.x)
    assert.equal(page.url(), url)

    // Nothing inside the card takes keyboard focus or edits as text.
    assert.equal(await card.locator("a").evaluate((el) => !!el.closest("[inert]")), true)

    at = await center()
    await page.mouse.dblclick(at.x, at.y)
    await page.waitForURL(`**/docs/${d.id}`)

    await openBoard(page, b.id)
    await card.getByText(title).first().waitFor()
    at = await center()
    await page.mouse.click(at.x, at.y)
    await page.keyboard.press("Enter")
    await page.waitForURL(`**/docs/${d.id}`)

    await openBoard(page, b.id)
    await card.getByText(title).first().waitFor()
    at = await center()
    await page.mouse.click(at.x, at.y)
    await page.getByRole("toolbar", { name: "Selection" }).getByRole("link", { name: title }).click()
    await page.waitForURL(`**/docs/${d.id}`)
  })

  test("the card fills its shape, keeping its title in view when resized small", async () => {
    const title = `Fits ${stamp()}`
    const d = await create("doc", title)
    const b = await board(`fit ${stamp()}`, [{ ...link("s_link", d.id), w: 500, h: 460 }, { ...link("s_tiny", d.id), x: 600, h: 90 }])
    const { page } = await open(browser)
    await openBoard(page, b.id)
    const within = async (id: string) => {
      const outer = (await shape(page, id).boundingBox())!
      const a = (await shape(page, id).locator("[data-embed]").boundingBox())!
      const name = (await shape(page, id).getByText(title).last().boundingBox())!
      assert.ok(Math.abs(a.height - outer.height) <= 1 && Math.abs(a.width - outer.width) <= 1, `${id}: card ${a.width}x${a.height} in shape ${outer.width}x${outer.height}`)
      assert.ok(name.y + name.height <= outer.y + outer.height + 0.5, `${id}: the title is clipped`)
    }
    await shape(page, "s_tiny").getByText(title).first().waitFor()
    await within("s_link")
    await within("s_tiny")
  })

  test("a link to itself, or to a link, doesn't draw forever", async () => {
    const b = await board(`self ${stamp()}`)
    const r = await ops(b.id, [
      { type: "insert", item: link("s_whole", b.id) },
      { type: "insert", item: { ...link("s_item", b.id, "s_item"), x: 500 } },
      { type: "insert", item: { ...link("s_other", b.id, "s_whole"), x: 1000 } },
    ])
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const { page, errors } = await open(browser)
    await openBoard(page, b.id)
    await shape(page, "s_item").getByText("Linked artifact").waitFor()
    await shape(page, "s_other").getByText("Linked artifact").waitFor()
    assert.ok((await page.locator("[data-embed]").count()) <= 3)
    assert.deepEqual(errors, [])
  })

  test("Home's thumbnail draws a link", async () => {
    const d = await create("doc", `Thumb ${stamp()}`)
    const b = await board(`Linked thumb ${stamp()}`, [link("s_link", d.id)])
    const { page, errors } = await open(browser)
    await page.goto(BASE)
    // Thumbnails load as they come into view, and other activity can push this one down the list.
    const card = page.locator("main a", { hasText: b.title }).first()
    await card.scrollIntoViewIfNeeded()
    await card.locator('svg rect[stroke="var(--faint)"]').first().waitFor()
    assert.deepEqual(errors, [])
  })

  test("what's gone says so; a share-link guest sees no title and fetches nothing it can't open, and read-only people can open what they can", viewAsOnly, async () => {
    const secret = `Secret ${stamp()}`
    const hidden = await create("doc", secret)
    const b = await board(`shared ${stamp()}`, [link("s_hidden", hidden.id), { ...link("s_gone", "d_doesnotexist"), x: 500 }, { ...link("s_item", hidden.id, "b_gone"), x: 1000 }])

    const owner = await open(browser)
    await openBoard(owner.page, b.id)
    await shape(owner.page, "s_gone").getByText("This link isn’t available").waitFor()
    await shape(owner.page, "s_item").getByText("this item was removed").waitFor()
    // Nothing to open: a double-click stays here.
    const url = owner.page.url()
    const gone = (await shape(owner.page, "s_gone").boundingBox())!
    await owner.page.mouse.dblclick(gone.x + gone.width / 2, gone.y + gone.height / 2)
    await settle(300)
    assert.equal(owner.page.url(), url)

    const share = await call("POST", `/artifacts/${b.id}/link`)
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const guest = await ctx.newPage()
    const fetched: Array<string> = []
    guest.on("response", (r) => r.url().includes(hidden.id) && fetched.push(`${r.status()} ${r.url()}`))
    await guest.goto(`${BASE}${share.body.path}`)
    await shape(guest, "s_anchor").waitFor()
    await eventually(async () => (await guest.getByText("This link isn’t available").count()) === 3)
    assert.ok(!(await guest.locator("body").innerText()).includes(secret), "the guest must not see what it links to")
    assert.equal(await guest.getByRole("button", { name: "Link an artifact" }).count(), 0)
    assert.deepEqual(fetched, [], "the guest's page must not ask for it")
    await ctx.close()

    // A viewer can't add links, but sees what's linked and can open it.
    const viewer = await open(browser, "viewer")
    await openBoard(viewer.page, b.id)
    assert.equal(await viewer.page.getByRole("button", { name: "Link an artifact" }).count(), 0)
    const card = shape(viewer.page, "s_hidden")
    await card.getByText(secret).first().waitFor()
    const box = (await card.boundingBox())!
    await viewer.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await viewer.page.getByRole("link", { name: secret }).last().waitFor()
    await viewer.page.keyboard.press("Enter")
    await viewer.page.waitForURL(`**/docs/${hidden.id}`)
  })
})

describe("board links: agents and the CLI", () => {
  test("MCP takes titles, ids, items and links; agents read back what's linked; unknown titles are errors", async () => {
    const title = `MCP target ${stamp()}`
    const d = await create("doc", title)
    const t = await create("table", `MCP table ${stamp()}`)
    const b = await board(`mcp links ${stamp()}`)
    const mcp = await mcpSession()
    const added = await mcp.tool("board_add_links", { artifact: b.id, links: [d.title, `${t.id}#r_1`, `https://standardartifacts.com/tables/${t.id}`] })
    assert.equal(added.error, false, added.text)
    const placed = await links(b.id)
    assert.deepEqual(placed.map((s) => s.ref), [{ artifactId: d.id }, { artifactId: t.id, item: "r_1" }, { artifactId: t.id }])
    // A column clear of the anchor, one under another.
    assert.ok(placed.every((s) => s.x > -100))
    for (let i = 1; i < placed.length; i++) assert.ok(placed[i]!.y >= placed[i - 1]!.y + placed[i - 1]!.h)

    const read = await mcp.tool("read_artifact", { artifact: b.id })
    assert.ok(read.text.includes(`link to ${d.id} `), read.text)
    assert.ok(read.text.includes(`link to ${t.id}#r_1 `), read.text)

    const unknown = await mcp.tool("board_add_links", { artifact: b.id, links: ["e2e no such artifact"] })
    assert.equal(unknown.error, true)
    assert.match(unknown.text, /No artifact matches/)
    assert.equal((await links(b.id)).length, 3, "a bad link adds nothing")
  })

  test("stdartifacts board link adds links; stdartifacts table add-column takes multiSelect", async () => {
    const title = `CLI target ${stamp()}`
    const d = await create("doc", title)
    const b = await board(`cli links ${stamp()}`)
    const r = cli("board", "link", b.id, d.title, `${d.id}#b_1`)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^Added s_/)
    assert.deepEqual((await links(b.id)).map((s) => s.ref), [{ artifactId: d.id }, { artifactId: d.id, item: "b_1" }])

    const t = await create("table", `cli multi ${stamp()}`)
    const col = cli("table", "add-column", t.id, "Tags", "--type", "multiSelect", "--options", "AI, B2B")
    assert.equal(col.code, 0, col.err)
    const tags = (await content(t.id)).state.columns.find((c: { name: string }) => c.name === "Tags")
    assert.equal(tags.type, "multiSelect")
    assert.deepEqual(tags.options.map((o: { label?: string; name?: string } | string) => (typeof o === "string" ? o : (o.label ?? o.name))), ["AI", "B2B"])
    assert.equal(cli("table", "add-row", t.id, "Name=Acme", "Tags=AI, B2B").code, 0)

    // A blank name is an error, not the first artifact that comes along.
    const blank = cli("table", "add-column", "", "Stray", "--type", "text")
    assert.equal(blank.code, 1)
    assert.match(blank.err, /No table matches ""/)
    assert.equal(cli("board", "link", b.id, "  ").code, 1)
    assert.equal((await links(b.id)).length, 2, "a blank link adds nothing")
  })
})
