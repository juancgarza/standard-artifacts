import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, call, cleanup, content, create, eventually, launch, mcpSession, open, ops, presence, settle, socket, viewAsOnly } from "./harness.ts"

/** Doc editor details: the "/" menu, paste, code blocks, dividers, placeholders and read-only rendering. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

type Item = { id: string; type: string; text: string; checked?: boolean }
const items = async (id: string): Promise<Array<Item>> => (await content(id)).state.items
const shape = async (id: string) => (await items(id)).map((b) => [b.type, b.text])
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Open a fresh doc as the owner with the caret in its first block. */
async function fresh(title: string) {
  const d = await create("doc", title)
  const owner = await open(browser)
  await owner.page.goto(`${BASE}/docs/${d.id}`)
  const blocks = owner.page.locator("[data-block-id] [role=textbox]")
  await blocks.first().click()
  return { d, ...owner, blocks }
}

const menu = (page: Page) => page.getByRole("listbox", { name: "Block types" })
const options = (page: Page) => menu(page).getByRole("option")

describe("doc slash menu", () => {
  test("opens on /, filters, keyboard selects, converts and keeps the caret", async () => {
    const { d, page, errors, blocks } = await fresh("slash keys")
    await page.keyboard.type("/")
    await menu(page).waitFor()
    assert.deepEqual(
      (await options(page).allInnerTexts()).map((t) => t.split("\n")[0]),
      ["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "To-do", "Quote", "Code", "Divider", "Image", "Linked artifact"],
    )

    // Filtering: "/h2" narrows to Heading 2; Enter converts and removes the "/h2".
    await page.keyboard.type("h2")
    assert.deepEqual((await options(page).allInnerTexts()).map((t) => t.split("\n")[0]), ["Heading 2"])
    await page.keyboard.press("Enter")
    assert.equal(await menu(page).count(), 0)
    await page.keyboard.type("Plan")
    await eventually(async () => same(await shape(d.id), [["heading2", "Plan"]]))
    assert.equal(await blocks.first().innerText(), "Plan")

    // Arrow keys move the highlight; Tab chooses too. "/quo" finds Quote.
    await page.keyboard.press("Enter")
    await page.keyboard.type("/quo")
    assert.deepEqual((await options(page).allInnerTexts()).map((t) => t.split("\n")[0]), ["Quote"])
    await page.keyboard.press("Backspace")
    await page.keyboard.press("Backspace")
    await page.keyboard.press("Backspace")
    await page.keyboard.type("todo")
    await options(page).first().waitFor()
    assert.equal((await options(page).first().innerText()).split("\n")[0], "To-do")
    await page.keyboard.press("Tab")
    await page.keyboard.type("ship it")
    await eventually(async () => same(await shape(d.id), [["heading2", "Plan"], ["todo", "ship it"]]))
    assert.equal((await items(d.id))[1]?.checked, false)

    // Mid-text after a space: "/" opens there, and the rest of the line survives the conversion.
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter") // empty to-do ends the list
    await page.keyboard.type("Note /")
    await menu(page).waitFor()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    assert.equal(await options(page).nth(2).getAttribute("aria-selected"), "true")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Enter") // Heading 1
    await page.keyboard.type("!")
    await eventually(async () => same((await shape(d.id)).at(-1), ["heading1", "Note !"]))

    // Not inside a word or a URL.
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.keyboard.type("a/b")
    await settle(150)
    assert.equal(await menu(page).count(), 0)
    assert.deepEqual(errors, [])
  })

  test("Escape keeps the text, mouse chooses, divider adds a paragraph, no results closes", async () => {
    const { d, page, errors, blocks } = await fresh("slash mouse")
    await page.keyboard.type("/todo")
    await menu(page).waitFor()
    await page.keyboard.press("Escape")
    assert.equal(await menu(page).count(), 0)
    await eventually(async () => same(await shape(d.id), [["paragraph", "/todo"]]))
    await page.keyboard.press("Enter")
    await page.keyboard.type("Typed after escape")

    // Mouse: hover and click Bulleted list; focus stays in the block.
    await page.keyboard.press("Enter")
    await page.keyboard.type("/")
    await options(page).filter({ hasText: "Bulleted list" }).click()
    await page.keyboard.type("clicked")
    await eventually(async () => same((await shape(d.id)).at(-1), ["bullet", "clicked"]))

    // Divider: inserts a divider and a fresh paragraph after it, with the caret there.
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.type("/div")
    await page.keyboard.press("Enter")
    await page.keyboard.type("below the line")
    await eventually(async () => same((await shape(d.id)).slice(-2), [["divider", ""], ["paragraph", "below the line"]]))

    // A query with no matches shows "No results", then closes after a few more characters.
    await page.keyboard.press("Enter")
    await page.keyboard.type("/zz")
    await menu(page).getByText("No results").waitFor()
    await page.keyboard.type("zz")
    assert.equal(await menu(page).count(), 0)

    // Code blocks don't open the menu (paths and comments are full of slashes).
    await page.keyboard.press("Enter")
    await page.keyboard.type("```")
    await page.keyboard.type("/usr")
    await settle(150)
    assert.equal(await menu(page).count(), 0)
    await eventually(async () => (await blocks.count()) === (await items(d.id)).filter((b) => b.type !== "divider").length)
    assert.deepEqual(errors, [])
  })
})

describe("doc editing", () => {
  test("multi-line paste splits into blocks around the caret", async () => {
    const { d, page, errors } = await fresh("paste")
    await page.keyboard.type("Intro  tail")
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft")
    await page.evaluate((text) => {
      const data = new DataTransfer()
      data.setData("text/plain", text)
      document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
    }, "line one\nline two\n\n- bullet a\n- [ ] task")
    await page.keyboard.type("!")
    await eventually(async () =>
      same(await shape(d.id), [
        ["paragraph", "Intro line one"],
        ["paragraph", "line two"],
        ["bullet", "bullet a"],
        ["todo", "task! tail"],
      ]),
    )
    assert.deepEqual(errors, [])
  })

  test("code blocks: Enter is a newline, Tab indents, Mod+Enter leaves", async () => {
    const { d, page, errors, blocks } = await fresh("code")
    await page.keyboard.type("```")
    await page.keyboard.type("if (x) {")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")
    await page.keyboard.type("go()")
    await page.keyboard.press("ControlOrMeta+Enter")
    await page.keyboard.type("after code")
    await eventually(async () => same(await shape(d.id), [["code", "if (x) {\n  go()"], ["paragraph", "after code"]]))
    assert.equal(await blocks.count(), 2)
    assert.deepEqual(errors, [])
  })

  test("arrows step over dividers; Enter at a block start opens a line above; Delete merges", async () => {
    const { d, page, errors } = await fresh("divider nav")
    await page.keyboard.type("# Title")
    await page.keyboard.press("Enter")
    await page.keyboard.type("---")
    await page.keyboard.type("below")
    await page.keyboard.press("Home")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.type("!")
    await eventually(async () => same(await shape(d.id), [["heading1", "Title!"], ["divider", ""], ["paragraph", "below"]]))
    await page.keyboard.press("ArrowDown")
    await page.keyboard.type(">")
    await eventually(async () => (await shape(d.id))[2]?.[1] === ">below")

    // Enter at the start of the heading inserts a paragraph above and leaves the heading alone.
    await page.keyboard.press("Home")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Home")
    await page.keyboard.press("Enter")
    await eventually(async () => same(await shape(d.id), [["paragraph", ""], ["heading1", "Title!"], ["divider", ""], ["paragraph", ">below"]]))

    // Delete at the end of the heading removes the divider, then merges the next block up.
    await page.keyboard.press("End")
    await page.keyboard.press("Delete")
    await page.keyboard.press("Delete")
    await eventually(async () => same(await shape(d.id), [["paragraph", ""], ["heading1", "Title!>below"]]))
    assert.deepEqual(errors, [])
  })

  test("placeholders: the empty-doc hint comes back after typing and deleting; focused lines hint at /", async () => {
    const { page, errors, blocks } = await fresh("placeholder")
    const hint = (i: number) => blocks.nth(i).evaluate((el) => getComputedStyle(el, "::before").content)
    assert.match(await hint(0), /“\/” for commands/)
    await page.keyboard.type("abc")
    for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace")
    assert.match(await hint(0), /“\/” for commands/)

    await page.keyboard.type("text")
    await page.keyboard.press("Enter")
    // Empty focused lines now offer Claude as well as the slash menu.
    assert.match(await hint(1), /“\/” for commands/)
    await blocks.nth(0).click()
    assert.doesNotMatch(await hint(1), /commands/)
    assert.deepEqual(errors, [])
  })
})

describe("doc read-only and presence", () => {
  test("guests see line breaks, empty lines, an empty-doc note, and the agent's status", viewAsOnly, async () => {
    const d = await create("doc", "guest view")
    const empty = await create("doc", "guest empty")
    const first = (await items(d.id))[0]!.id
    await ops(d.id, [
      { type: "update", id: first, patch: { text: "line one\nline two" } },
      { type: "insert", item: { id: "k_code", type: "code", text: "x".repeat(400) } },
      { type: "insert", item: { id: "k_blank", type: "paragraph", text: "" } },
      { type: "insert", item: { id: "k_agent", type: "paragraph", text: "Agent paragraph" } },
    ])
    await presence(d.id, "e2e-doc-status", { blockId: "k_agent", thinking: true, status: "Drafting the intro" })
    const guest = await open(browser, "guest")
    await guest.page.goto(`${BASE}/docs/${d.id}`)
    const para = guest.page.locator("[data-block-id] [role=textbox]").first()
    await guest.page.getByText("line one").waitFor()
    const lineHeight = await para.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
    assert.ok((await para.boundingBox())!.height >= lineHeight * 2 - 1, "line break renders as two lines")

    const code = guest.page.locator('[data-block-id="k_code"] [role=textbox]')
    const scroll = await code.evaluate((el) => ({ overflow: getComputedStyle(el).overflowX, wider: el.scrollWidth > el.clientWidth }))
    assert.deepEqual(scroll, { overflow: "auto", wider: true }, "long code scrolls inside its block")

    // Without contenteditable an empty block has no caret line, so it used to collapse to nothing.
    const blank = guest.page.locator('[data-block-id="k_blank"] [role=textbox]')
    assert.ok((await blank.boundingBox())!.height >= lineHeight - 1, "an empty line keeps its height")

    await guest.page.getByText("Claude · Drafting the intro").waitFor()
    await guest.page.goto(`${BASE}/docs/${empty.id}`)
    await guest.page.getByText("This doc is empty.").waitFor()
    await guest.page.locator("[data-block-id]").first().waitFor()
    assert.deepEqual(guest.errors, [])
  })
})

describe("doc images", () => {
  // A real 1x1 PNG, so the browser reports it as loaded.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
  const file = { name: "shot.png", mimeType: "image/png", buffer: png }
  type Image = Item & { src?: string }
  const images = async (id: string) => (await items(id)).filter((b) => b.type === "image") as Array<Image>

  test("/image uploads into the block; the caption edits, Enter leaves it, and a viewer sees it", viewAsOnly, async () => {
    const { d, page, errors } = await fresh("image upload")
    await page.keyboard.type("/ima")
    await page.keyboard.press("Enter")
    await eventually(async () => same(await shape(d.id), [["image", ""]]))
    await page.locator('input[type="file"]').setInputFiles(file)
    const [image] = await eventually(async () => {
      const list = await images(d.id)
      return list[0]?.src ? list : null
    })
    assert.match(image!.src!, /^\/api\/v1\/artifacts\/.+\/assets\//)
    const img = page.locator(`[data-block-id="${image!.id}"] img`)
    await img.waitFor()
    await eventually(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))

    // The caret stayed in the caption; Enter goes to a new line rather than splitting it.
    await page.keyboard.type("A caption")
    await page.keyboard.press("Enter")
    await page.keyboard.type("after")
    await eventually(async () => same(await shape(d.id), [["image", "A caption"], ["paragraph", "after"]]))
    assert.equal(await img.getAttribute("alt"), "A caption")
    assert.match((await content(d.id)).text, /^!\[A caption\]\(\/api\/v1\/artifacts\/.+\)\n\nafter$/)

    const guest = await open(browser, "guest")
    await guest.page.goto(`${BASE}/docs/${d.id}`)
    const seen = guest.page.locator(`[data-block-id="${image!.id}"] img`)
    await seen.waitFor()
    await eventually(() => seen.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    assert.equal(await guest.page.getByRole("button", { name: "Remove", exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  })

  test("Backspace selects an image before deleting it, and text never merges into a caption", async () => {
    const d = await create("doc", "image keys")
    await ops(d.id, [
      { type: "insert", item: { id: "k_img", type: "image", text: "cap", src: `/api/v1/artifacts/${d.id}/assets/a_missing` } },
      { type: "insert", item: { id: "k_txt", type: "paragraph", text: "body" } },
    ])
    const owner = await open(browser)
    await owner.page.goto(`${BASE}/docs/${d.id}`)
    const body = owner.page.locator('[data-block-id="k_txt"] [role=textbox]')
    await body.click()
    await owner.page.keyboard.press("Home")
    await owner.page.keyboard.press("Backspace")
    assert.equal(await owner.page.evaluate(() => document.activeElement?.hasAttribute("data-doc-figure")), true)
    assert.deepEqual((await images(d.id)).map((b) => b.text), ["cap"])
    assert.equal((await items(d.id)).find((b) => b.id === "k_txt")?.text, "body")
    await owner.page.keyboard.press("Backspace")
    await eventually(async () => (await images(d.id)).length === 0)
    // The caret lands in the nearest text, here the doc's starter paragraph above where the image was.
    assert.equal(await owner.page.evaluate(() => document.activeElement?.getAttribute("role")), "textbox")
  })

  test("pasting and dropping an image file add image blocks", async () => {
    const { d, page, blocks } = await fresh("image paste")
    await page.keyboard.type("first")
    const transfer = (target: string, type: string) =>
      page.evaluate(
        async ({ b64, target, type }) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const dt = new DataTransfer()
          dt.items.add(new File([bytes], "shot.png", { type: "image/png" }))
          const el = document.querySelector(target)!
          const box = el.getBoundingClientRect()
          const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.bottom - 1 }
          if (type === "paste") el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
          else {
            el.dispatchEvent(new DragEvent("dragover", init))
            el.dispatchEvent(new DragEvent("drop", init))
          }
        },
        { b64: png.toString("base64"), target, type },
      )
    await transfer("[data-block-id] [role=textbox]", "paste")
    await eventually(async () => (await images(d.id)).filter((b) => b.src).length === 1)
    assert.deepEqual((await shape(d.id)).map(([t]) => t), ["paragraph", "image"])
    assert.equal(await blocks.first().innerText(), "first")

    await transfer("[data-block-id]", "drop")
    await eventually(async () => (await images(d.id)).filter((b) => b.src).length === 2)
  })

  test("a link fills the placeholder, a bad one says why, and a failed upload shows its reason", async () => {
    const { d, page } = await fresh("image link")
    await page.route("https://example.com/**", (r) => r.abort())
    await page.keyboard.type("/image")
    await page.keyboard.press("Enter")
    const link = page.getByRole("textbox", { name: "Image link", exact: true })
    await link.fill("http://example.com/a.png")
    await link.press("Enter")
    await page.getByText("Use an https:// link").waitFor()
    assert.equal((await images(d.id))[0]?.src, undefined)

    await page.locator('input[type="file"]').setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(2_000_000, 7) })
    await page.getByText("the limit is 1.9 MB").waitFor()

    await link.fill("https://example.com/a.png")
    await link.press("Enter")
    await eventually(async () => (await images(d.id))[0]?.src === "https://example.com/a.png")
  })
})

describe("doc linked artifacts", () => {
  type Embed = Item & { ref?: { artifactId: string; item?: string } }
  const embeds = async (id: string) => (await items(id)).filter((b) => b.type === "embed") as Array<Embed>
  const picker = (page: Page) => page.getByRole("dialog", { name: "Link an artifact" })
  const stamp = () => Date.now().toString(36)

  async function table(title: string) {
    const t = await create("table", title)
    const { columns } = (await content(t.id)).state
    const [name, second] = columns as Array<{ id: string }>
    const added = await ops(t.id, [
      { type: "addRows", rowIds: ["r_ada"] },
      { type: "setCell", rowId: "r_ada", colId: name!.id, value: "Ada Lovelace" },
      { type: "setCell", rowId: "r_ada", colId: second!.id, value: "https://ada.dev" },
    ])
    assert.equal(added.status, 200, JSON.stringify(added.body))
    return t
  }

  async function board(title: string) {
    const b = await create("board", title)
    await ops(b.id, [{ type: "insert", item: { id: "s_plan", kind: "note", x: 900, y: 900, w: 240, h: 160, color: "green", text: "The launch plan" } }])
    return b
  }

  test("/link picks a whole table or one row; previews show their content and open the source", async () => {
    const t = await table(`Leads ${stamp()}`)
    const { d, page, errors } = await fresh("embed table")
    await page.keyboard.type("/link")
    await page.keyboard.press("Enter")
    await picker(page).getByRole("textbox").fill(t.title)
    await page.keyboard.press("Enter")
    await picker(page).getByRole("option", { name: "Ada Lovelace" }).waitFor()
    await page.keyboard.press("Enter") // the first option is the whole table
    await eventually(async () => same((await embeds(d.id))[0]?.ref, { artifactId: t.id }))
    const whole = page.locator(`[data-embed="${t.id}"]`)
    await whole.getByText("Ada Lovelace").waitFor()

    // The caret is in the caption, so Enter leaves it for a new line that can link the row.
    await page.keyboard.press("Enter")
    await page.keyboard.type("/link")
    await page.keyboard.press("Enter")
    await picker(page).getByRole("textbox").fill(t.title)
    await page.keyboard.press("Enter")
    await picker(page).getByRole("option", { name: "Ada Lovelace" }).click()
    await eventually(async () => same((await embeds(d.id))[1]?.ref, { artifactId: t.id, item: "r_ada" }))
    const row = page.locator(`[data-embed="${t.id}"]`).nth(1)
    await row.getByText("https://ada.dev").waitFor()
    assert.ok((await content(d.id)).text.includes(`![[${t.id}]]\n\n![[${t.id}#r_ada]]`))

    await row.click()
    await page.waitForURL(`**/tables/${t.id}/r_ada`)
    await page.getByLabel("Record").waitFor()
    assert.deepEqual(errors, [])
  })

  test("a board shape shows as it does on the canvas, by picker or pasted link; Copy link and clicking round-trip", async () => {
    const b = await board(`Plan ${stamp()}`)
    const { d, page, errors } = await fresh("embed shape")
    await page.keyboard.type("/link")
    await page.keyboard.press("Enter")
    await picker(page).getByRole("textbox").fill(b.title)
    await page.keyboard.press("Enter")
    await picker(page).getByRole("option", { name: "The launch plan" }).click()
    await eventually(async () => same((await embeds(d.id))[0]?.ref, { artifactId: b.id, item: "s_plan" }))
    const card = page.locator(`[data-embed="${b.id}"]`)
    await card.locator('[data-shape-id="s_plan"]').getByText("The launch plan").waitFor()

    // Opening it lands on the shape, selected.
    await card.click()
    await page.waitForURL(`**/boards/${b.id}/s_plan`)
    const note = page.locator('[data-shape-id="s_plan"]')
    await note.waitFor()
    const copy = page.getByRole("button", { name: "Copy link", exact: true })
    await copy.waitFor()
    const box = (await note.boundingBox())!
    const view = page.viewportSize()!
    assert.ok(box.x > 0 && box.y > 0 && box.x + box.width < view.width && box.y + box.height < view.height, "the camera is on the shape")

    // Copy link, then paste it on an empty line of a doc. A link inside a sentence stays text.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE })
    await copy.click()
    const url = await page.evaluate(() => navigator.clipboard.readText())
    assert.equal(url, `${BASE}/boards/${b.id}/s_plan`)
    const other = await create("doc", "embed paste")
    await page.goto(`${BASE}/docs/${other.id}`)
    const line = page.locator("[data-block-id] [role=textbox]").first()
    await line.click()
    await page.keyboard.type("see ")
    await page.keyboard.press("ControlOrMeta+v")
    await eventually(async () => (await items(other.id))[0]?.text === `see ${url}`)
    await page.keyboard.press("Enter")
    await page.keyboard.press("ControlOrMeta+v")
    await eventually(async () => same((await embeds(other.id))[0]?.ref, { artifactId: b.id, item: "s_plan" }))
    assert.deepEqual(errors, [])
  })

  test("removed items and links nobody can open say so; bad refs are refused", async () => {
    const b = await board(`Gone ${stamp()}`)
    const d = await create("doc", "embed states")
    const insert = (id: string, ref: unknown) => ({ type: "insert", item: { id, type: "embed", text: "", ref } })
    assert.equal((await ops(d.id, [insert("k_bad", { artifactId: "../../share/exit" })])).status, 400)
    await ops(d.id, [insert("k_gone", { artifactId: b.id, item: "s_nope" }), insert("k_none", { artifactId: "b_doesnotexist" })])
    const owner = await open(browser)
    await owner.page.goto(`${BASE}/docs/${d.id}`)
    await owner.page.locator('[data-block-id="k_gone"]').getByText("this item was removed").waitFor()
    await owner.page.locator('[data-block-id="k_none"]').getByText("This link isn’t available").waitFor()
  })

  test("a share-link guest sees nothing of what they can't open, and previews add no presence", async () => {
    const secret = `Secret ${stamp()}`
    const b = await board(secret)
    const d = await create("doc", "embed shared")
    await ops(d.id, [{ type: "insert", item: { id: "k_link", type: "embed", text: "", ref: { artifactId: b.id, item: "s_plan" } } }])
    const link = await call("POST", `/artifacts/${d.id}/link`)
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const guest = await ctx.newPage()
    const responses: Array<string> = []
    guest.on("response", (r) => r.url().includes(b.id) && responses.push(`${r.status()} ${r.url()}`))
    await guest.goto(`${BASE}${link.body.path}`)
    await guest.locator('[data-block-id="k_link"]').getByText("This link isn’t available").waitFor()
    assert.equal(await guest.getByText(secret).count(), 0)
    assert.equal(await guest.getByText("The launch plan").count(), 0)
    assert.deepEqual(responses.filter((r) => r.startsWith("2")), [], "nothing of the board reached the guest")
    await ctx.close()

    // A socket on the board sees who's in its room: viewing the preview shouldn't add anyone.
    const watcher = socket(b.id, "agent")
    await watcher.ready
    const owner = await open(browser)
    await owner.page.goto(`${BASE}/docs/${d.id}`)
    await owner.page.locator('[data-shape-id="s_plan"]').waitFor()
    await settle(500)
    const joins = () => watcher.messages.filter((m: { type: string }) => m.type === "join").length
    assert.equal(joins(), 0, "viewing a preview doesn't join the board's room")
    // The check can fail: opening the board itself does join.
    await owner.page.goto(`${BASE}/boards/${b.id}`)
    await eventually(() => joins() > 0)
    watcher.ws.close()
  })
})

describe("doc agent marks", () => {
  test("an agent shows its app's mark in the byline and on the block it's in", async () => {
    const d = await create("doc", "agent marks")
    await ops(d.id, [{ type: "insert", item: { id: "k_agent", type: "paragraph", text: "Written by an agent" } }])
    const owner = await open(browser)
    await owner.page.goto(`${BASE}/docs/${d.id}`)
    const byline = owner.page.locator("[data-doc-byline]")
    await byline.locator('[data-agent-brand="claude"]').waitFor()
    assert.match(await byline.innerText(), /Edited by @claude/)

    await presence(d.id, "marks", { blockId: "k_agent", status: "Drafting" })
    const block = owner.page.locator('[data-block-id="k_agent"]')
    await block.locator('[data-agent-brand="claude"]').waitFor()
    await block.getByText("Drafting").waitFor()
    assert.deepEqual(owner.errors, [])
  })

  test("an agent is the app it came from: Codex's doc says Codex, not Claude", async () => {
    const codex = await mcpSession("codex-mcp-client")
    const made = await codex.tool("create_artifact", { kind: "doc", title: `From Codex ${Date.now()}` })
    const id = /Created doc (\S+)/.exec(made.text)?.[1]
    assert.ok(id, made.text)
    try {
      assert.equal((await codex.tool("doc_append", { artifact: id, markdown: "Written in Codex" })).error, false)

      const { body } = await call("GET", "/workspace")
      const artifact = body.artifacts.find((a: { id: string }) => a.id === id)
      assert.equal(artifact.createdBy, "agt_codex:usr_dev")
      assert.equal(artifact.createdByName, "Codex")
      assert.equal(artifact.client, "Codex")

      const owner = await open(browser)
      await owner.page.goto(`${BASE}/docs/${id}`)
      const byline = owner.page.locator("[data-doc-byline]")
      await byline.locator('[data-agent-brand="codex"]').waitFor()
      assert.match(await byline.innerText(), /Edited by @codex/)
      assert.deepEqual(owner.errors, [])
    } finally {
      await call("DELETE", `/artifacts/${id}`)
    }
  })
})

describe("doc reading rhythm", () => {
  test("gaps follow what a block comes after, and text sizes are the reading sizes", async () => {
    const seq: Array<[string, string, Record<string, unknown>?]> = [
      ["paragraph", "First"],
      ["paragraph", "Second"],
      ["heading1", "One"],
      ["paragraph", "Under one"],
      ["heading2", "Two"],
      ["paragraph", "Under two"],
      ["heading3", "Three"],
      ["paragraph", "Under three"],
      ["bullet", "A"],
      ["bullet", "B"],
      ["paragraph", "After the list"],
      ["quote", "Quoted"],
      ["paragraph", "After the quote"],
      ["code", "x = 1"],
      ["paragraph", "After the code"],
      ["image", "A caption", { src: "https://example.com/a.png" }],
      ["paragraph", "After the caption"],
    ]
    const d = await create("doc", "rhythm")
    await ops(d.id, seq.map(([type, text, extra], i) => ({ type: "insert", item: { id: `k_${i}`, type, text, ...extra } })))
    const { page } = await open(browser)
    await page.goto(`${BASE}/docs/${d.id}`)
    await page.locator(`[data-block-id="k_${seq.length - 1}"]`).waitFor()

    const gaps = await page.evaluate((n) => {
      const box = (i: number) => document.querySelector(`[data-block-id="k_${i}"]`)!.getBoundingClientRect()
      return Array.from({ length: n - 1 }, (_, i) => Math.round(box(i + 1).top - box(i).bottom))
    }, seq.length)
    assert.deepEqual(gaps, [12, 36, 6, 28, 6, 20, 6, 12, 4, 12, 12, 12, 16, 16, 20, 20])

    const style = (id: string) =>
      page.locator(`[data-block-id="${id}"] [role=textbox]`).evaluate((el) => {
        const s = getComputedStyle(el)
        return { size: s.fontSize, line: s.lineHeight, color: s.color, border: s.borderLeftColor }
      })
    const body = await style("k_0")
    assert.deepEqual([body.size, body.line], ["16px", "26px"])
    const quote = await style("k_11")
    assert.equal(quote.color, body.color, "quotes read at full strength")
    assert.equal(quote.border, body.color)
    assert.deepEqual([(await style("k_2")).size, (await style("k_4")).size, (await style("k_6")).size], ["30px", "24px", "20px"])
    const caption = await style("k_15")
    assert.deepEqual([caption.size, caption.line], ["14px", "20px"])
  })
})
