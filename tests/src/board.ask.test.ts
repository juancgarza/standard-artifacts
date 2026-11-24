import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { BASE, call, cleanup, content, create, eventually, launch, open, ops, settle, viewAsOnly, visit } from "./harness.ts"

/** Asking Claude on a board, tldraw-style: a composer on the selection, threads pinned where asked, answers in the thread. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

type M = { id: string; artifactId: string; target: { type: string; id?: string; x?: number; y?: number }; text: string; blocks: string[]; status: string; resolved: boolean }
const mentionsOf = async (artifactId: string): Promise<Array<M>> => (await call("GET", `/mentions?artifactId=${artifactId}`)).body
const items = async (id: string) => (await content(id)).state.items as Array<{ id: string }>

async function board(name: string) {
  const b = await create("board", name)
  await ops(b.id, [
    { type: "remove", ids: (await items(b.id)).map((s) => s.id) },
    { type: "insert", item: { id: "n1", kind: "note", x: 0, y: 0, w: 200, h: 140, color: "yellow", text: "Onboarding is too long" } },
    { type: "insert", item: { id: "n2", kind: "note", x: 230, y: 0, w: 200, h: 140, color: "yellow", text: "Users don't find templates" } },
    { type: "insert", item: { id: "n3", kind: "note", x: 0, y: 170, w: 200, h: 140, color: "blue", text: "Pricing confuses teams" } },
  ])
  const { page, errors } = await open(browser, "owner", { width: 1400, height: 820 })
  await visit(page, `${BASE}/boards/${b.id}`, page.locator('[data-shape-id="n1"]'))
  await settle(300)
  const box = async (id: string) => (await page.locator(`[data-shape-id="${id}"]`).boundingBox())!
  return { b, page, errors, box }
}

/** Play the runner: claim this board's next request and answer it. */
async function answer(artifactId: string, result: string) {
  const claimed: M = await eventually(async () => (await call("POST", "/mentions/claim", { runner: "e2e", artifactId }, "agent")).body)
  await call("POST", `/mentions/${claimed.id}/complete`, { status: "done", result }, "agent")
  return claimed
}

describe("Ask Claude on a board", () => {
  test("ask about a selection: no shapes added, a pinned thread, the reply in it, a follow-up, then Resolve", async () => {
    const { b, page, errors, box } = await board("ask selection")
    const [n1, n2] = [await box("n1"), await box("n2")]
    await page.mouse.click(n1.x + 30, n1.y + 30)
    await page.keyboard.down("Shift")
    await page.mouse.click(n2.x + 30, n2.y + 30)
    await page.keyboard.up("Shift")
    await page.getByRole("button", { name: "Ask Claude" }).first().click()
    const composer = page.getByRole("dialog", { name: "Ask Claude" })
    await composer.waitFor()
    assert.equal(await composer.locator("[data-ask-context]").textContent(), "2 shapes")
    await page.keyboard.type("What's the common theme?")
    await page.keyboard.press("Enter")

    // The request is pinned at the selection's corner and covers both shapes; the canvas is unchanged.
    const asked = await eventually(async () => (await mentionsOf(b.id))[0])
    assert.deepEqual(asked.target, { type: "point", x: 430, y: 0 })
    assert.deepEqual(asked.blocks, ["n1", "n2"])
    assert.equal(asked.text, "What's the common theme?")
    assert.equal((await items(b.id)).length, 3)
    const pin = page.locator("[data-thread-pin]")
    await pin.waitFor()
    const card = page.getByRole("dialog", { name: "Claude thread" })
    await card.getByText("Waiting for a runner…").waitFor()

    await answer(b.id, "Both are about **discovery**.\n\n- Shorten onboarding\n- Surface templates\n\n(cost $0.01)")
    await card.getByText("Shorten onboarding").waitFor({ timeout: 8000 })
    assert.equal(await card.locator("li").count(), 2)
    assert.equal(await card.getByText("(cost").count(), 0, "the cost line isn't shown")
    assert.equal(await pin.getAttribute("data-status"), "done")

    // A follow-up continues the thread: same target, same context.
    await card.getByLabel("Reply to Claude").fill("Add them as notes")
    await page.keyboard.press("Enter")
    const followUp = await eventually(async () => (await mentionsOf(b.id)).find((m) => m.text === "Add them as notes"))
    assert.deepEqual(followUp.target, asked.target)
    assert.deepEqual(followUp.blocks, ["n1", "n2"])
    await eventually(async () => (await page.locator("[data-thread-card] [data-mention]").count()) === 2)

    // A press on the canvas closes the card; the pin reopens it.
    await page.mouse.click(1000, 650)
    await eventually(async () => (await card.count()) === 0)
    await pin.click()
    await card.waitFor()

    // Resolve: the queued follow-up is cancelled, the thread is resolved, and the pin goes.
    await card.getByRole("button", { name: "Resolve" }).click()
    await eventually(async () => (await pin.count()) === 0)
    const after = await mentionsOf(b.id)
    assert.ok(after.every((m) => m.resolved))
    assert.equal(after.find((m) => m.id === followUp.id)!.status, "cancelled")
    assert.equal((await call("POST", "/mentions/claim", { runner: "e2e", artifactId: b.id }, "agent")).body, null)
    assert.deepEqual(errors, [])
  })

  test("⌘J with nothing selected asks about the view; a quick action sends its prompt; Esc closes without asking", async () => {
    const { b, page, errors } = await board("ask view")
    await page.mouse.click(1000, 650)
    await page.keyboard.press("Meta+j")
    const composer = page.getByRole("dialog", { name: "Ask Claude" })
    await composer.waitFor()
    assert.match((await composer.locator("[data-ask-context]").textContent())!, /This view · 3 shapes/)
    await page.keyboard.press("Escape")
    await eventually(async () => (await composer.count()) === 0)
    assert.equal((await mentionsOf(b.id)).length, 0)

    await page.getByRole("button", { name: "Ask Claude" }).click()
    await composer.getByRole("option", { name: "Summarize" }).click()
    const m = await eventually(async () => (await mentionsOf(b.id))[0])
    assert.equal(m.target.type, "point")
    assert.deepEqual([...m.blocks].sort(), ["n1", "n2", "n3"])
    assert.match(m.text, /Summarize/)
    await page.locator("[data-thread-pin]").waitFor()
    assert.deepEqual(errors, [])
  })

  test("a single shape's thread follows it; “@claude” typed in a note gets a pin too; viewers see threads but can't ask", viewAsOnly, async () => {
    const { b, page, errors, box } = await board("ask follow")
    const n3 = await box("n3")
    await page.mouse.click(n3.x + 30, n3.y + 30)
    await page.keyboard.press("Meta+j")
    await page.keyboard.type("Why?")
    await page.keyboard.press("Enter")
    const m = await eventually(async () => (await mentionsOf(b.id))[0])
    assert.deepEqual(m.target, { type: "shape", id: "n3" })
    const pin = page.locator("[data-thread-pin]")
    await pin.waitFor()
    const before = (await pin.boundingBox())!
    await ops(b.id, [{ type: "update", id: "n3", patch: { x: 300, y: 300 } }])
    await eventually(async () => (await pin.boundingBox())!.x > before.x + 100)

    // Typing a mention in a note still works, and lands as a thread on that note.
    await ops(b.id, [{ type: "update", id: "n1", patch: { text: "@claude what's missing?" } }], "owner")
    await eventually(async () => (await mentionsOf(b.id)).some((x) => x.target.type === "shape" && x.target.id === "n1"), 8000)
    await eventually(async () => (await pin.count()) === 2, 8000)

    const viewer = await open(browser, "viewer", { width: 1400, height: 820 })
    await visit(viewer.page, `${BASE}/boards/${b.id}`, viewer.page.locator("[data-thread-pin]").first())
    assert.equal(await viewer.page.getByRole("button", { name: "Ask Claude" }).count(), 0)
    await viewer.page.locator("[data-thread-pin]").first().click()
    const card = viewer.page.getByRole("dialog", { name: "Claude thread" })
    await card.waitFor()
    assert.equal(await card.getByLabel("Reply to Claude").count(), 0)
    assert.equal(await card.getByRole("button", { name: "Resolve" }).count(), 0)
    assert.deepEqual(errors, [])
    assert.deepEqual(viewer.errors, [])
  })

  test("the API: list filters by artifact, resolve closes the whole thread, guests can't resolve", async () => {
    const a = await create("board", "ask api a")
    const c = await create("board", "ask api c")
    const ask = (artifactId: string, text: string, target: object) => call("POST", "/mentions", { artifactId, target, text })
    const first = (await ask(a.id, "one", { type: "point", x: 10, y: 20 })).body
    await ask(a.id, "two", { type: "point", x: 10, y: 20 })
    await ask(a.id, "other thread", { type: "point", x: 500, y: 20 })
    await ask(c.id, "elsewhere", { type: "point", x: 10, y: 20 })
    assert.deepEqual((await mentionsOf(a.id)).map((m) => m.text).sort(), ["one", "other thread", "two"])
    assert.equal((await call("POST", `/mentions/${first.id}/resolve`, undefined, "guest")).status, 403)
    const resolved = (await call("POST", `/mentions/${first.id}/resolve`)).body as Array<M>
    assert.deepEqual(resolved.map((m) => m.text).sort(), ["one", "two"])
    const now = await mentionsOf(a.id)
    assert.equal(now.find((m) => m.text === "other thread")!.resolved, false)
    assert.ok(now.filter((m) => m.text !== "other thread").every((m) => m.resolved && m.status === "cancelled"))
    assert.equal((await mentionsOf(c.id))[0]!.resolved, false)
  })
})
