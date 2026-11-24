import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { BASE, call, cleanup, create, createFolder, eventually, launch, open, ops, settle, visit } from "./harness.ts"

/** Home stays current with what other people and agents do, without a reload. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

const updatedAt = async (id: string) => {
  const { artifacts } = (await call("GET", "/workspace")).body as { artifacts: Array<{ id: string; updatedAt: string }> }
  return artifacts.find((a) => a.id === id)?.updatedAt
}

/** The raw "index changed" socket. Dev only: `as` picks the caller. */
function liveSocket(options: { as?: "viewer"; cookie?: string } = {}) {
  const url = `${BASE.replace(/^http/, "ws")}/api/v1/workspace/live${options.as ? `?as=${options.as}` : ""}`
  const ws = new WebSocket(url, options.cookie ? ({ headers: { cookie: options.cookie } } as unknown as string) : undefined)
  const messages: Array<string> = []
  ws.onmessage = (e) => messages.push(String(e.data))
  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error(`live socket failed: ${url}`))
  })
  return { ws, messages, ready }
}

describe("live home", () => {
  test("an artifact made, renamed, edited and archived elsewhere shows up without a reload", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    const main = page.locator("main")
    await visit(page, BASE, page.getByRole("tab", { name: "Recent" }))

    // Created by someone else: appears.
    const stamp = Date.now()
    const made = await call("POST", "/artifacts", { kind: "doc", title: `e2e live made ${stamp}` }, "agent")
    assert.ok(made.status === 200 || made.status === 201, JSON.stringify(made.body))
    const id = made.body.id as string
    try {
      await main.getByText(`e2e live made ${stamp}`).first().waitFor({ timeout: 5000 })

      // Renamed: the card follows.
      await call("PATCH", `/artifacts/${id}`, { title: `e2e live renamed ${stamp}` }, "agent")
      await main.getByText(`e2e live renamed ${stamp}`).first().waitFor({ timeout: 5000 })

      // Content written: the card's preview follows, with no socket into the doc itself.
      const before = await updatedAt(id)
      const write = await ops(id, [{ type: "insert", item: { id: `b${stamp}`, type: "paragraph", text: `live preview ${stamp}` } }])
      assert.equal(write.status, 200, JSON.stringify(write.body))
      await main.getByText(`live preview ${stamp}`).first().waitFor({ timeout: 8000 })
      assert.notEqual(await updatedAt(id), before, "the edit counts as an update")

      // Archived: gone.
      await call("POST", `/artifacts/${id}/archive`, undefined, "agent")
      await main.getByText(`e2e live renamed ${stamp}`).first().waitFor({ state: "detached", timeout: 5000 })
    } finally {
      await call("DELETE", `/artifacts/${id}`)
    }
    assert.deepEqual(errors, [])
  })

  test("a folder made elsewhere appears, with what was moved into it", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    const main = page.locator("main")
    await visit(page, BASE, page.getByRole("tab", { name: "Recent" }))
    const doc = await create("doc", `Live moved ${Date.now()}`)
    const f = await createFolder(`e2e live folder ${Date.now()}`)
    await main.getByText(f.name).first().waitFor({ timeout: 5000 })
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: f.id }, "agent")
    await settle(1000)
    // Client-side navigation: the folder page reads the list Home already holds.
    await main.getByText(f.name).first().click()
    await main.getByText(doc.title).first().waitFor({ timeout: 5000 })
    assert.deepEqual(errors, [])
  })

  test("a hidden tab doesn't read until it's shown", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    const main = page.locator("main")
    await page.addInitScript(() => {
      const flag = globalThis as unknown as { liveHidden?: boolean }
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (flag.liveHidden ? "hidden" : "visible") })
    })
    await visit(page, BASE, page.getByRole("tab", { name: "Recent" }))
    await settle(1000)
    await page.evaluate(() => {
      ;(globalThis as unknown as { liveHidden?: boolean }).liveHidden = true
    })
    let reads = 0
    page.on("request", (r) => {
      if (r.method() === "GET" && new URL(r.url()).pathname === "/api/v1/workspace") reads++
    })
    const doc = await create("doc", `Live hidden ${Date.now()}`)
    await settle(1200)
    assert.equal(reads, 0, "no reads while hidden")
    assert.equal(await main.getByText(doc.title).count(), 0)

    await page.evaluate(() => {
      ;(globalThis as unknown as { liveHidden?: boolean }).liveHidden = false
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await main.getByText(doc.title).first().waitFor({ timeout: 5000 })
    assert.deepEqual(errors, [])
  })

  test("with the socket blocked, polling still catches up", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    const main = page.locator("main")
    // Refused outright, as behind a proxy that won't pass sockets: it never opens.
    await page.addInitScript(() => {
      const Real = WebSocket
      globalThis.WebSocket = class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(String(url).includes("/workspace/live") ? "ws://127.0.0.1:9/" : url, protocols)
        }
      }
    })
    await page.clock.install()
    // The tabs render before the first read lands, and that read must not be what finds the new doc.
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/workspace")
    await visit(page, BASE, page.getByRole("tab", { name: "Recent" }))
    await loaded
    await settle(200)
    const doc = await create("doc", `Live polled ${Date.now()}`)
    await settle(1000)
    assert.equal(await main.getByText(doc.title).count(), 0, "nothing tells it yet")
    await page.clock.fastForward(31_000)
    await main.getByText(doc.title).first().waitFor({ timeout: 5000 })
    assert.deepEqual(errors, [])
  })

  test("a burst of edits reports a few times, not once per op", async () => {
    const doc = await create("doc", `Live burst ${Date.now()}`)
    const live = liveSocket()
    await live.ready
    try {
      for (let i = 0; i < 20; i++) {
        await ops(doc.id, [{ type: "insert", item: { id: `burst${i}`, type: "paragraph", text: `line ${i}` } }])
      }
      await eventually(() => live.messages.length > 0, 8000)
      await settle(2500)
      assert.ok(live.messages.length <= 5, `expected a few "changed" messages, got ${live.messages.length}`)
    } finally {
      live.ws.close()
    }
  })

  test("a share-link guest only hears about the artifact it was shared", async () => {
    const shared = await create("doc", `Live shared ${Date.now()}`)
    const other = await create("doc", `Live other ${Date.now()}`)
    const link = await call("POST", `/artifacts/${shared.id}/link`)
    assert.ok(link.status === 200 || link.status === 201, JSON.stringify(link.body))
    const opened = await fetch(`${BASE}${link.body.path}`, { redirect: "manual" })
    const cookie = opened.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
    assert.match(cookie, /standard_artifacts_share=/)

    const guest = liveSocket({ cookie })
    await guest.ready
    const member = liveSocket()
    await member.ready
    try {
      await call("PATCH", `/artifacts/${other.id}`, { title: `e2e Live other renamed ${Date.now()}` })
      await createFolder(`e2e live guest folder ${Date.now()}`)
      await eventually(() => member.messages.length >= 2)
      await settle(300)
      assert.equal(guest.messages.length, 0, "another artifact and the org's folders are none of a guest's business")

      await call("PATCH", `/artifacts/${shared.id}`, { title: `e2e Live shared renamed ${Date.now()}` })
      await eventually(() => guest.messages.length === 1)
    } finally {
      guest.ws.close()
      member.ws.close()
    }
  })

  test("a read that started before your create doesn't take the new artifact away", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    const newDoc = page.locator("main").getByRole("button", { name: /^New doc/ })
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/workspace")
    await visit(page, BASE, newDoc)
    await loaded
    await settle(1000)

    // From here reads are held: the first one until we release it, any later one for good, so nothing can repair the list.
    let started = () => {}
    const stale = new Promise<void>((resolve) => (started = resolve))
    let release = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    let reads = 0
    await page.route(
      (url) => url.pathname === "/api/v1/workspace",
      async (route) => {
        if (route.request().method() !== "GET") return route.continue()
        const read = ++reads
        const response = await route.fetch()
        if (read > 1) return
        started()
        await released
        await route.fulfill({ response })
      },
    )

    // Someone else's change starts a read, which sees the index as it is before our create.
    await create("doc", `Live noise ${Date.now()}`)
    await stale
    await newDoc.click()
    await page.waitForURL(/\/docs\/d_/)
    const id = page.url().split("/").pop() as string
    try {
      const more = page.getByRole("button", { name: "More" })
      await more.waitFor()
      release()
      await settle(500)
      assert.equal(await page.getByText("Not found.").count(), 0, "the stale read didn't remove it")
      assert.equal(await more.count(), 1)
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" })
      await call("DELETE", `/artifacts/${id}`)
    }
    assert.deepEqual(errors, [])
  })
})
