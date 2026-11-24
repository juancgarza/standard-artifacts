import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { BASE, call, cleanup, content, create, eventually, launch, open, ops, presence, settle, viewAsOnly, visit } from "./harness.ts"

/**
 * The doc's writer agent: the Ask bar (Space, ⌘J, selection), the working
 * state, suggestions (insert tint, replace diff) and their review. The test
 * plays the agent runner itself: it claims each request, shows presence,
 * writes suggestion ops and completes the request, exactly like `stdartifacts agent serve`.
 */

let browser: Browser
/** Every request a test filed, so none is left running (an expired lease would hand it to a real runner). */
const filedIds: Array<string> = []
/** Pages with request interception; their routes are removed before shutdown. */
const routed: Array<Page> = []

/**
 * Helpers that Chrome (stable channel) spawns and that can outlive it: the crash reporter and
 * GoogleUpdater. They inherit Chrome's stdio, so Playwright never sees it close (pids running now).
 */
function chromeHelpers(): Set<string> {
  try {
    return new Set(execFileSync("pgrep", ["-f", "chrome_crashpad_handler|GoogleUpdater"]).toString().split("\n").filter(Boolean))
  } catch {
    return new Set() // pgrep exits 1 when nothing matches
  }
}
let helpersBefore = new Set<string>()

before(async () => {
  helpersBefore = chromeHelpers()
  browser = await launch()
})
after(async () => {
  for (const page of routed) {
    await page.unrouteAll({ behavior: "ignoreErrors" })
    await page.context().close()
  }
  // When one of those helpers stays alive, close() never resolves and the run hangs after passing.
  // Give it a moment, then stop only the helpers that appeared during this run.
  const closed = browser?.close()
  if (!(await Promise.race([closed?.then(() => true), settle(10_000).then(() => false)]))) {
    for (const pid of chromeHelpers()) {
      if (helpersBefore.has(pid)) continue
      try {
        process.kill(Number(pid))
      } catch {
        // already gone
      }
    }
    await closed
  }
  for (const id of filedIds) await call("POST", `/mentions/${id}/cancel`, undefined, "agent")
  await cleanup()
})

type Suggestion = { kind: "insert" | "replace"; by: string; mentionId?: string; original?: string }
type Item = { id: string; type: string; text: string; suggestion?: Suggestion | null }
type Mention = { id: string; status: string; mode: string; target: { type: string; id: string }; text: string; blocks: Array<string>; result: string | null }
type Filed = { body: { artifactId: string; target: { type: string; id: string }; text: string; mode?: string; blocks?: Array<string> }; mention: Mention }

const items = async (id: string): Promise<Array<Item>> => (await content(id)).state.items
const block = async (doc: string, id: string) => (await items(doc)).find((b) => b.id === id)
const mention = async (id: string): Promise<Mention | undefined> => ((await call("GET", "/mentions")).body as Array<Mention>).find((m) => m.id === id)

/**
 * Let the page file requests for real, then claim each one for this test right
 * away. A runner may be serving the same org's inbox; claiming by artifact keeps
 * our requests away from it (and if it ever wins the race, we cancel and fail loudly).
 */
async function intercept(page: Page, artifactId: string) {
  const filed: Array<Filed> = []
  routed.push(page)
  await page.route(/\/api\/v1\/mentions(\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const res = await route.fetch()
    const m: Mention = await res.json()
    filedIds.push(m.id)
    const claimed = await call("POST", "/mentions/claim", { runner: "e2e-writer", artifactId }, "agent")
    if (claimed.body?.id !== m.id) await call("POST", `/mentions/${m.id}/cancel`, undefined, "agent")
    filed.push({ body: JSON.parse(route.request().postData() ?? "{}"), mention: m })
    await route.fulfill({ response: res, json: m })
  })
  /** The nth request filed from this page, once it has been. */
  const nth = (n: number) => eventually(() => filed.length > n && filed[n])
  return { filed, nth }
}

/** The test's stand-in for `stdartifacts agent serve`, working on one request. */
function runner(doc: string, m: Mention) {
  const tag = (kind: "insert" | "replace", original?: string): Suggestion => ({ kind, by: "agent", mentionId: m.id, ...(original !== undefined && { original }) })
  return {
    think: (status: string, blockId: string) => presence(doc, `mention-${m.id}`, { blockId, thinking: true, status }),
    insert: (afterId: string, list: Array<{ id: string; type: string; text: string }>) =>
      ops(doc, list.map((item, k) => ({ type: "insert", item: { ...item, suggestion: tag("insert") }, after: k === 0 ? afterId : list[k - 1]!.id }))),
    replace: (id: string, text: string, original: string) => ops(doc, [{ type: "update", id, patch: { text, suggestion: tag("replace", original) } }]),
    done: (result: string) => call("POST", `/mentions/${m.id}/complete`, { status: "done", result }, "agent"),
    fail: (result: string) => call("POST", `/mentions/${m.id}/complete`, { status: "error", result }, "agent"),
  }
}

const PARAGRAPH = "We is shipping the writer next week, it lets people and agents write together."
const BETTER = "We're shipping the writer next week. It lets people and agents write together."

/** A doc with a heading, a paragraph with typos (k_p) and an empty line (k_empty), open as the owner. */
async function fresh(title: string, as: "owner" | "guest" = "owner") {
  const d = await create("doc", title)
  const first = (await items(d.id))[0]!.id
  await ops(d.id, [
    { type: "update", id: first, patch: { type: "heading1", text: "Launch plan" } },
    { type: "insert", item: { id: "k_p", type: "paragraph", text: PARAGRAPH } },
    { type: "insert", item: { id: "k_empty", type: "paragraph", text: "" } },
  ], "owner")
  const view = await open(browser, as)
  const { page } = view
  const net = as === "owner" ? await intercept(page, d.id) : undefined
  await visit(page, `${BASE}/docs/${d.id}`, page.getByText("Launch plan"))
  return { d, ...view, net: net!, text: (id: string) => page.locator(`[data-block-id="${id}"] [role=textbox]`) }
}

const askBar = (page: Page) => page.getByRole("dialog", { name: "Ask Claude" })
const actionLabels = async (page: Page) => (await page.getByRole("listbox", { name: "Claude actions" }).getByRole("option").allInnerTexts()).map((t) => t.trim())
const bar = (page: Page) => page.locator("[data-mention-bar]")
const focusedBlock = (page: Page) => page.evaluate(() => document.activeElement?.closest("[data-block-id]")?.getAttribute("data-block-id") ?? null)

/** Select a block's whole text, the way a person triple-clicks a paragraph. */
async function selectBlock(page: Page, id: string) {
  await page.locator(`[data-block-id="${id}"] [role=textbox]`).click({ clickCount: 3 })
}

/** Ask from the empty line with a quick action, run it as the runner would, and return the request. */
async function askOnEmptyLine(page: Page, nth: (n: number) => Promise<Filed>, index: number, action: string) {
  await page.locator('[data-block-id="k_empty"] [role=textbox]').click()
  await page.keyboard.press("Space")
  await askBar(page).getByRole("option", { name: action }).click()
  return (await nth(index)).mention
}

describe("doc writer: asking", () => {
  test("Space and ⌘J open the bar, Esc closes it, and sending files the right request", async () => {
    const { d, page, errors, net, text } = await fresh("writer ask")

    // Placeholder advertises Space; Space on an empty line opens the bar over it, with the reply actions.
    await text("k_empty").click()
    assert.match(await text("k_empty").evaluate((el) => getComputedStyle(el, "::before").content), /press space for Claude/)
    await page.keyboard.press("Space")
    await askBar(page).waitFor()
    assert.equal(await page.locator("[data-ask-context]").innerText(), "This doc")
    assert.deepEqual(await actionLabels(page), ["Continue writing", "Summarize this doc", "Brainstorm ideas", "Draft an outline"])
    assert.equal((await block(d.id, "k_empty"))?.text, "", "Space didn't type a space")
    await page.keyboard.press("Escape")
    assert.equal(await askBar(page).count(), 0)
    assert.equal(await focusedBlock(page), "k_empty", "Esc puts the caret back")

    // Space in a line with text is just a space.
    await page.keyboard.type("Hi")
    await page.keyboard.press("Space")
    assert.equal(await askBar(page).count(), 0)
    assert.equal(await text("k_empty").innerText(), "Hi ")
    for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace")

    // ⌘J toggles it too; arrow down + Enter runs "Summarize this doc" as a reply below the line.
    await page.keyboard.press("ControlOrMeta+j")
    await askBar(page).waitFor()
    await page.keyboard.press("ControlOrMeta+j")
    assert.equal(await askBar(page).count(), 0, "⌘J again closes it")
    await page.keyboard.press("ControlOrMeta+j")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")
    const summarize = await net.nth(0)
    assert.equal(summarize.body.mode, "reply")
    assert.deepEqual(summarize.body.target, { type: "block", id: "k_empty" })
    assert.match(summarize.body.text, /^Summarize this doc/)
    assert.equal(summarize.body.blocks, undefined)
    await eventually(async () => (await bar(page).getAttribute("data-state")) === "working")
    await runner(d.id, summarize.mention).done("Nothing to add.")

    // A selection gets the toolbar; its bar edits the selected block in place with a typed request.
    await selectBlock(page, "k_p")
    await page.getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: /Ask Claude/ }).click()
    await askBar(page).waitFor()
    assert.equal(await page.locator("[data-ask-context]").innerText(), "1 block selected")
    assert.deepEqual(await actionLabels(page), ["Improve writing", "Fix spelling & grammar", "Make shorter", "Make longer", "Simplify", "Translate to…"])
    await page.keyboard.type("make it punchy")
    await page.keyboard.press("Enter")
    const punchy = await net.nth(1)
    assert.deepEqual(punchy.body, { artifactId: d.id, target: { type: "block", id: "k_p" }, text: "make it punchy", mode: "edit", blocks: ["k_p"] })
    await runner(d.id, punchy.mention).done("No changes.")

    // ⌘J with a selection asks about it too; "Translate to…" asks for the language next.
    await selectBlock(page, "k_p")
    await page.keyboard.press("ControlOrMeta+j")
    await askBar(page).getByRole("option", { name: "Translate to…" }).click()
    assert.ok((await actionLabels(page)).includes("Spanish"))
    await page.keyboard.type("Catalan")
    await page.keyboard.press("Enter")
    const translate = await net.nth(2)
    assert.equal(translate.body.text, "Translate to Catalan.")
    assert.equal(translate.body.mode, "edit")
    await runner(d.id, translate.mention).done("No changes.")
    assert.deepEqual(errors, [])
  })

  test("working state shows the agent's status; Stop cancels the request", async () => {
    const { d, page, errors, net } = await fresh("writer stop")
    const m = await askOnEmptyLine(page, net.nth, 0, "Continue writing")
    await eventually(async () => /Claude is thinking/.test(await bar(page).innerText()))
    assert.equal(await bar(page).evaluate((el) => el === document.activeElement), true, "the working bar has focus, so Esc stops")

    await runner(d.id, m).think("Writing…", "k_empty")
    await eventually(async () => /Claude · Writing…/.test(await bar(page).innerText()))
    await page.keyboard.press("Escape")
    await eventually(async () => (await mention(m.id))?.status === "cancelled")
    await eventually(async () => (await bar(page).count()) === 0)

    // The Stop button does the same.
    const again = await askOnEmptyLine(page, net.nth, 1, "Brainstorm ideas")
    await bar(page).getByRole("button", { name: "Stop" }).click()
    await eventually(async () => (await mention(again.id))?.status === "cancelled")
    assert.deepEqual(errors, [])
  })

  test("a request nobody picks up hints at starting a runner; errors show the runner's message", async () => {
    const { d, page, errors, net } = await fresh("writer queued")
    // The test claims every request at once, so report this one as still queued to the page.
    let queued = ""
    await page.route(/\/api\/v1\/mentions(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      const res = await route.fetch()
      const list: Array<Mention> = await res.json()
      await route.fulfill({ response: res, json: list.map((m) => (m.id === queued && m.status === "running" ? { ...m, status: "queued" } : m)) })
    })
    const m = await askOnEmptyLine(page, net.nth, 0, "Draft an outline")
    queued = m.id
    await settle(3000)
    assert.equal(await page.locator("[data-queued-hint]").count(), 0, "no hint in the first seconds")
    await page.locator("[data-queued-hint]").waitFor({ timeout: 9000 })
    assert.match(await page.locator("[data-queued-hint]").innerText(), /Waiting for an agent runner\. Start one with stdartifacts agent serve/)

    queued = ""
    await runner(d.id, m).fail("Credit balance is too low")
    await eventually(async () => (await bar(page).getAttribute("data-state")) === "error", 6000)
    assert.match(await page.locator("[data-mention-error]").innerText(), /Credit balance is too low/)
    await bar(page).getByRole("button", { name: "Dismiss" }).click()
    assert.equal(await bar(page).count(), 0)
    assert.deepEqual(errors, [])
  })
})

describe("doc writer: suggestions and review", () => {
  test("replies arrive tinted; Accept keeps them in place of the empty line, Discard (Esc) removes them", async () => {
    const { d, page, errors, net } = await fresh("writer reply")
    const m = await askOnEmptyLine(page, net.nth, 0, "Brainstorm ideas")
    const run = runner(d.id, m)
    await run.think("Writing…", "k_empty")
    await run.insert("k_empty", [
      { id: "k_i1", type: "bullet", text: "Pair-writing sessions" },
      { id: "k_i2", type: "bullet", text: "Agent office hours" },
    ])
    const inserted = page.locator('[data-suggestion="insert"]')
    await eventually(async () => (await inserted.count()) === 2)
    assert.match(await inserted.first().getAttribute("class") ?? "", /bg-accent/, "inserted blocks are tinted")
    assert.match(await bar(page).innerText(), /2 changes so far/, "still working: the bar counts what arrived")
    await run.done("Added 2 ideas below your line.\n\n(cost $0.010)")
    await eventually(async () => (await bar(page).getAttribute("data-state")) === "review")
    assert.match(await bar(page).innerText(), /Claude suggested 2 changes/)
    assert.equal(await page.locator("[data-mention-summary]").innerText(), "Added 2 ideas below your line.", "summary without the cost line")
    await bar(page).getByRole("button", { name: "Good response" }).click()
    assert.equal(await bar(page).getByRole("button", { name: "Good response" }).getAttribute("aria-pressed"), "true")

    await bar(page).getByRole("button", { name: "Accept" }).click()
    await eventually(async () => {
      const all = await items(d.id)
      return all.every((b) => !b.suggestion) && !all.some((b) => b.id === "k_empty") && all.map((b) => b.id).join() === `${all[0]!.id},k_p,k_i1,k_i2`
    })
    assert.equal(await inserted.count(), 0)
    assert.equal(await bar(page).count(), 0)

    // Discard: the review bar has focus when the answer lands, so Esc throws it away.
    await ops(d.id, [{ type: "insert", item: { id: "k_empty", type: "paragraph", text: "" } }], "owner")
    const m2 = await askOnEmptyLine(page, net.nth, 1, "Continue writing")
    const run2 = runner(d.id, m2)
    await run2.insert("k_empty", [{ id: "k_i3", type: "paragraph", text: "More words." }])
    await run2.done("Continued the doc.")
    await eventually(async () => (await bar(page).getAttribute("data-state")) === "review")
    await eventually(() => bar(page).evaluate((el) => el === document.activeElement))
    await page.keyboard.press("Escape")
    await eventually(async () => !(await items(d.id)).some((b) => b.id === "k_i3"))
    assert.ok((await items(d.id)).some((b) => b.id === "k_empty"), "discarding keeps the line you asked from")
    assert.deepEqual(errors, [])
  })

  test("rewrites show a word diff; Discard restores, ⌘↵ accepts, Insert below keeps both, Try again re-asks", async () => {
    const { d, page, errors, net, text } = await fresh("writer edit")
    const improve = async (n: number) => {
      await selectBlock(page, "k_p")
      await page.keyboard.press("ControlOrMeta+j")
      await page.keyboard.press("Enter") // Improve writing
      const m = (await net.nth(n)).mention
      const original = (await block(d.id, "k_p"))!.text
      await runner(d.id, m).replace("k_p", BETTER, original)
      await runner(d.id, m).done("Fixed the grammar.")
      await eventually(async () => (await bar(page).getAttribute("data-state")) === "review")
      return m
    }

    const first = await improve(0)
    assert.equal(first.mode, "edit")
    const diff = page.locator('[data-block-id="k_p"] [data-diff]')
    await diff.waitFor()
    assert.deepEqual(await diff.locator("[data-diff-del]").allInnerTexts(), ["We is", "week, it"])
    assert.deepEqual(await diff.locator("[data-diff-add]").allInnerTexts(), ["We're", "week. It"])
    assert.match(await bar(page).innerText(), /Claude suggested 1 change\b/)

    await bar(page).getByRole("button", { name: "Discard" }).click()
    await eventually(async () => {
      const b = await block(d.id, "k_p")
      return b?.text === PARAGRAPH && !b.suggestion
    })
    assert.equal(await diff.count(), 0)
    assert.equal(await text("k_p").innerText(), PARAGRAPH)

    // ⌘↵ on the focused review bar accepts.
    await improve(1)
    await eventually(() => bar(page).evaluate((el) => el === document.activeElement))
    await page.keyboard.press("ControlOrMeta+Enter")
    await eventually(async () => {
      const b = await block(d.id, "k_p")
      return b?.text === BETTER && !b.suggestion
    })

    // Insert below: the original stays, Claude's version follows it as a normal block.
    // (Accepting put the caret in k_p, and a focused block keeps its own text, so step out before resetting it.)
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    await ops(d.id, [{ type: "update", id: "k_p", patch: { text: PARAGRAPH } }], "owner")
    await eventually(async () => (await text("k_p").innerText()) === PARAGRAPH)
    await improve(2)
    await bar(page).getByRole("button", { name: "Insert below" }).click()
    await eventually(async () => {
      const all = await items(d.id)
      const at = all.findIndex((b) => b.id === "k_p")
      return all[at]?.text === PARAGRAPH && all[at + 1]?.text === BETTER && all.every((b) => !b.suggestion)
    })

    // Try again: discard, then the same prompt, mode and blocks go back to the inbox.
    const third = await improve(3)
    await bar(page).getByRole("button", { name: "Try again" }).click()
    const retried = await net.nth(4)
    assert.deepEqual(retried.body, { artifactId: d.id, target: { type: "block", id: "k_p" }, text: third.text, mode: "edit", blocks: ["k_p"] })
    await eventually(async () => {
      const b = await block(d.id, "k_p")
      return b?.text === PARAGRAPH && !b.suggestion
    })
    await eventually(async () => (await bar(page).getAttribute("data-state")) === "working")
    await runner(d.id, retried.mention).done("Nothing to change.")
    assert.deepEqual(errors, [])
  })

  test("per-block accept and discard on hover; typing into a pending block accepts it", async () => {
    const { d, page, errors, net, text } = await fresh("writer own")
    const m = await askOnEmptyLine(page, net.nth, 0, "Draft an outline")
    const run = runner(d.id, m)
    await run.insert("k_empty", [
      { id: "k_a", type: "heading2", text: "Goals" },
      { id: "k_b", type: "bullet", text: "Ship it" },
      { id: "k_c", type: "bullet", text: "Tell people" },
    ])
    await run.replace("k_p", BETTER, PARAGRAPH)
    await run.done("Drafted an outline.")
    await eventually(async () => (await bar(page).getAttribute("data-state")) === "review")
    assert.match(await bar(page).innerText(), /Claude suggested 4 changes/)

    await page.locator('[data-block-id="k_a"]').hover()
    await page.locator('[data-block-id="k_a"]').getByRole("button", { name: "Accept this block" }).click()
    await page.locator('[data-block-id="k_b"]').hover()
    await page.locator('[data-block-id="k_b"]').getByRole("button", { name: "Discard this block" }).click()
    await eventually(async () => {
      const all = await items(d.id)
      const a = all.find((b) => b.id === "k_a")
      return !!a && !a.suggestion && !all.some((b) => b.id === "k_b")
    })
    await eventually(async () => /Claude suggested 2 changes/.test(await bar(page).innerText()))

    // Typing into a pending insert takes it over.
    await text("k_c").click()
    await page.keyboard.press("End")
    await page.keyboard.type("!")
    await eventually(async () => {
      const b = await block(d.id, "k_c")
      return b?.text === "Tell people!" && !b.suggestion
    })

    // A pending rewrite shows its diff until clicked; typing then edits (and accepts) the new text.
    await page.locator('[data-block-id="k_p"] [data-diff]').click()
    await page.keyboard.type(" Soon.")
    await eventually(async () => {
      const b = await block(d.id, "k_p")
      return b?.text === `${BETTER} Soon.` && !b.suggestion
    })
    await eventually(async () => (await bar(page).count()) === 0, 3000)
    assert.deepEqual(errors, [])
  })
})

describe("doc writer: other viewers", () => {
  test("a second browser sees suggestions and their review; guests see them without review controls", viewAsOnly, async () => {
    const { d, page, errors, net } = await fresh("writer shared")
    const other = await open(browser)
    await visit(other.page, `${BASE}/docs/${d.id}`, other.page.getByText("Launch plan"))
    const guest = await open(browser, "guest")
    await visit(guest.page, `${BASE}/docs/${d.id}`, guest.page.getByText("Launch plan"))

    const m = await askOnEmptyLine(page, net.nth, 0, "Continue writing")
    const run = runner(d.id, m)
    await run.insert("k_empty", [{ id: "k_new", type: "paragraph", text: "Next, we invite the team." }])
    await run.replace("k_p", BETTER, PARAGRAPH)
    await run.done("Continued the doc and fixed a typo.")

    // The other owner tab: same suggestions, same summary, and it can review too.
    await other.page.locator('[data-suggestion="insert"]').waitFor()
    await other.page.locator('[data-block-id="k_p"] [data-diff-add]').first().waitFor()
    await eventually(async () => /Continued the doc and fixed a typo/.test(await bar(other.page).innerText()), 6000)
    assert.equal(await bar(other.page).getByRole("button", { name: "Accept" }).count(), 1)

    // The guest: suggestions and the count, but nothing to click and no Ask bar.
    await guest.page.locator('[data-suggestion="insert"]').waitFor()
    await guest.page.locator('[data-block-id="k_p"] [data-diff-del]').first().waitFor()
    assert.match(await bar(guest.page).innerText(), /Claude suggested 2 changes/)
    assert.equal(await guest.page.getByRole("button", { name: /Accept|Discard|Try again|Insert below/ }).count(), 0)
    await guest.page.locator('[data-block-id="k_new"]').hover()
    assert.equal(await guest.page.getByRole("button", { name: "Accept this block" }).count(), 0)
    await guest.page.keyboard.press("ControlOrMeta+j")
    assert.equal(await askBar(guest.page).count(), 0)

    // Accepting in one tab clears the review everywhere.
    await bar(page).getByRole("button", { name: "Accept" }).click()
    await eventually(async () => (await other.page.locator("[data-suggestion]").count()) === 0 && (await bar(other.page).count()) === 0)
    await eventually(async () => (await guest.page.locator("[data-suggestion]").count()) === 0 && (await bar(guest.page).count()) === 0)
    assert.equal(await other.page.locator('[data-block-id="k_p"] [role=textbox]').innerText(), BETTER)
    assert.deepEqual([...errors, ...other.errors, ...guest.errors], [])
  })
})

describe("doc writer: selection", () => {
  test("selecting across blocks keeps a clean native selection, copies only doc text, and asks about exactly those blocks", async () => {
    const { d, page, errors, text } = await fresh("writer multiselect")
    const first = (await items(d.id))[0]!.id
    // A pending block (with its review bar) sits inside the range, and one more block follows.
    await ops(d.id, [
      { type: "insert", item: { id: "k_pend", type: "paragraph", text: "Pending idea from Claude", suggestion: { kind: "insert", by: "agent" } }, after: "k_p" },
      { type: "insert", item: { id: "k_last", type: "paragraph", text: "Last line" }, after: "k_empty" },
    ])
    await page.locator('[data-mention-bar][data-state="review"]').waitFor()
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    const selection = () => page.evaluate(() => getSelection()?.toString() ?? "")

    // Each block is its own editable, so a cross-block selection is a drag that starts in the page margin.
    const top = (await text(first).boundingBox())!
    const end = (await text("k_last").boundingBox())!
    await page.mouse.move(top.x - 30, top.y + 10)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) await page.mouse.move(top.x - 30 + i * 15, top.y + 10 + ((end.y + 10 - top.y) * i) / 12)
    await page.mouse.up()
    await settle(200)
    const picked = await selection()
    for (const line of ["Launch plan", PARAGRAPH, "Pending idea from Claude"]) assert.ok(picked.includes(line), `selection includes ${line}`)
    assert.doesNotMatch(picked, /Claude suggested|Accept|Discard/, "the review bar isn't part of the selection")

    await page.keyboard.press("ControlOrMeta+c")
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    assert.ok(copied.includes(PARAGRAPH) && copied.includes("Pending idea from Claude"))
    assert.doesNotMatch(copied, /Claude suggested|Accept|Discard/)

    // The toolbar shows without collapsing the selection, and the bar covers exactly the selected blocks.
    const toolbar = page.getByRole("toolbar", { name: "Selection" })
    await toolbar.waitFor()
    assert.equal(await selection(), picked, "showing the toolbar left the selection alone")
    await toolbar.getByRole("button", { name: /Ask Claude/ }).click()
    assert.equal(await page.locator("[data-ask-context]").innerText(), "3 blocks selected")
    await page.keyboard.press("Escape")

    // Shift+Arrow extends inside a block instead of jumping to the next one and collapsing the selection.
    await text("k_p").click()
    await page.keyboard.press("Home")
    await page.keyboard.press("Shift+End")
    await page.keyboard.press("Shift+ArrowDown")
    assert.equal(await selection(), PARAGRAPH)
    assert.equal(await focusedBlock(page), "k_p")
    assert.deepEqual(errors, [])
  })
})
