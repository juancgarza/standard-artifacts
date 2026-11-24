import assert from "node:assert/strict"
import { after, describe, test } from "node:test"
import { BASE, call, cleanup, create, launch, open, visit } from "./harness.ts"
import { documentId, namespaceFor, queryItems, searchConfig, writeItems } from "../../apps/app/src/worker/search-index.ts"

after(cleanup)

/**
 * Against the running app, whose index may be off (no TURBOPUFFER_API_KEY in
 * dev): titles must always work, and what's archived must never come back.
 */
describe("workspace search", () => {
  test("finds artifacts by title and says how it searched", async () => {
    const a = await create("doc", `Quokka ${Date.now()}`)
    const r = await call("GET", `/search?q=${encodeURIComponent(a.title)}`)
    assert.equal(r.status, 200)
    assert.ok(["title", "hybrid"].includes(r.body.mode))
    assert.ok(r.body.hits.some((h: any) => h.artifact.id === a.id && h.item === undefined))
  })

  test("filters by kind", async () => {
    const title = `Wombat ${Date.now()}`
    const doc = await create("doc", title)
    const table = await create("table", title)
    const r = await call("GET", `/search?q=${encodeURIComponent(title)}&kind=table`)
    const ids = r.body.hits.map((h: any) => h.artifact.id)
    assert.ok(ids.includes(table.id))
    assert.ok(!ids.includes(doc.id))
  })

  test("leaves out archived artifacts", async () => {
    const a = await create("doc", `Numbat ${Date.now()}`)
    await call("POST", `/artifacts/${a.id}/archive`)
    const r = await call("GET", `/search?q=${encodeURIComponent(a.title)}`)
    assert.ok(!r.body.hits.some((h: any) => h.artifact.id === a.id))
    await call("POST", `/artifacts/${a.id}/restore`)
  })

  test("rejects an empty query", async () => {
    assert.equal((await call("GET", "/search?q=%20")).status, 400)
  })

  test("only an owner can reindex", async () => {
    assert.equal((await call("POST", "/search/reindex", undefined, "viewer")).status, 403)
  })
})

/** The palette, with the server's answer mocked: dev has no index to answer with content hits. */
describe("search in the palette", () => {
  test("content matches get their own group and open the item", async () => {
    const browser = await launch()
    try {
      const a = await create("doc", `Palette ${Date.now()}`)
      const { page, errors } = await open(browser)
      await page.route("**/api/v1/search?*", (route) =>
        route.fulfill({ json: { mode: "hybrid", hits: [{ artifact: a, item: "k_found", text: "Pricing · twelve dollars a seat" }] } }),
      )
      await visit(page, BASE, page.getByRole("navigation", { name: "Workspace" }))
      await page.keyboard.press("ControlOrMeta+k")
      await page.getByPlaceholder(/^Search boards/).fill("what did we charge")
      const hit = page.getByRole("option", { name: /twelve dollars a seat/ })
      await hit.waitFor({ state: "visible" })
      assert.ok(await page.getByRole("group", { name: "In content" }).isVisible())
      await hit.click()
      await page.waitForURL(`**/${a.id}/k_found`)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })

  test("a failing search leaves title matches working", async () => {
    const browser = await launch()
    try {
      const a = await create("doc", `Sturdy ${Date.now()}`)
      const { page, errors } = await open(browser)
      await page.route("**/api/v1/search?*", (route) => route.fulfill({ status: 500, body: "{}" }))
      await visit(page, BASE, page.getByRole("navigation", { name: "Workspace" }))
      await page.keyboard.press("ControlOrMeta+k")
      await page.getByPlaceholder(/^Search boards/).fill(a.title)
      await page.getByRole("option", { name: new RegExp(a.title) }).waitFor({ state: "visible" })
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
})

/** The wire format, against a fake: the real service needs a key, and this is what must match its API. */
describe("search index adapter", () => {
  const recording = (response: unknown, status = 200) => {
    const calls: Array<{ url: string; auth: string | null; body: any }> = []
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(response), { status })
    }
    const config = searchConfig({ TURBOPUFFER_API_KEY: "key", TURBOPUFFER_URL: "https://tpuf.test", SEARCH_PREFIX: "t" }, fetcher)
    assert.ok(config)
    return { calls, config }
  }

  test("is off without a key", () => {
    assert.equal(searchConfig({}), null)
  })

  test("orgs get separate namespaces, with valid names", async () => {
    const { config } = recording({})
    const a = await namespaceFor(config, "org one/with spaces")
    assert.match(a, /^[A-Za-z0-9-_.]{1,128}$/)
    assert.notEqual(a, await namespaceFor(config, "org two"))
  })

  test("upserts embed through the schema, and deletes go by document id", async () => {
    const { calls, config } = recording({ status: "OK" })
    await writeItems(config, "org", "d_1", "doc", [{ item: "k_1", text: "hello" }], ["k_2"])
    const { url, auth, body } = calls[0]!
    assert.equal(url, `https://tpuf.test/v2/namespaces/${await namespaceFor(config, "org")}`)
    assert.equal(auth, "Bearer key")
    assert.deepEqual(body.upsert_rows, [{ id: await documentId("d_1", "k_1"), artifact_id: "d_1", kind: "doc", item: "k_1", text: "hello" }])
    assert.deepEqual(body.deletes, [await documentId("d_1", "k_2")])
    assert.equal(body.distance_metric, "cosine_distance")
    assert.equal(body.schema.text.full_text_search, true)
    assert.ok(body.schema.text.embed.model)
    assert.ok(!("vector" in body.upsert_rows[0]), "turbopuffer does the embedding")
  })

  test("queries fuse vector and keyword search, within the guest's artifact", async () => {
    const { calls, config } = recording({ results: [{ rows: [{ id: "x", artifact_id: "d_1", item: "k_1", text: "hello" }] }] })
    const hits = await queryItems(config, "org", { query: "greeting", limit: 5, artifactId: "d_1", kind: "doc" })
    assert.deepEqual(hits, [{ artifactId: "d_1", item: "k_1", text: "hello" }])
    const { body } = calls[0]!
    assert.deepEqual(body.queries.map((q: any) => q.rank_by), [
      ["text", "ANN", ["Embed", "greeting"]],
      ["text", "BM25", "greeting"],
    ])
    assert.deepEqual(body.queries[0].filters, ["And", [["artifact_id", "Eq", "d_1"], ["kind", "Eq", "doc"]]])
    assert.equal(body.rerank_by[0], "RRF")
    assert.equal(body.limit, 5)
  })

  test("a namespace nothing has been written to is an empty result, and other failures surface", async () => {
    assert.deepEqual(await queryItems(recording({}, 404).config, "org", { query: "x", limit: 5 }), [])
    await assert.rejects(queryItems(recording({ error: "bad" }, 500).config, "org", { query: "x", limit: 5 }), /turbopuffer 500/)
  })
})
