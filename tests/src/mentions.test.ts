import assert from "node:assert/strict"
import { after, describe, test } from "node:test"
import { call, cleanup, content, create, eventually, ops, ownerName, settle } from "./harness.ts"

/** @-mentions: people's mentions land in the inbox once settled; agents claim and complete them. */

after(cleanup)

const mine = async (artifactId: string) => ((await call("GET", "/mentions")).body as Array<{ artifactId: string }>).filter((m) => m.artifactId === artifactId) as Array<any>

describe("mention inbox", () => {
  test("file, refresh, settle, claim once, complete, no re-run on edit", async () => {
    const d = await create("doc", "mentions")
    const first = (await content(d.id)).state.items[0].id
    const write = (text: string, as: "owner" | "agent" = "owner") => ops(d.id, [{ type: "update", id: first, patch: { text } }], as)

    await write("@claude")
    const [queued] = await eventually(async () => {
      const ms = await mine(d.id)
      return ms.length === 1 && ms
    })
    assert.equal(queued.status, "queued")
    assert.equal(queued.requestedByName, await ownerName())
    assert.deepEqual(queued.target, { type: "block", id: first })

    await write("@claude list 3 risks")
    await settle(300)
    const refreshed = await mine(d.id)
    assert.equal(refreshed.length, 1, "typing more refreshes the same mention")
    assert.match(refreshed[0].text, /3 risks/)
    assert.equal((await call("POST", "/mentions/claim", { runner: "e2e", artifactId: d.id }, "agent")).body, null, "not claimable before it settles")

    await ops(d.id, [{ type: "insert", item: { id: "k_agent_m", type: "paragraph", text: "@claude from an agent" } }], "agent")
    await settle(300)
    assert.equal((await mine(d.id)).length, 1, "agent edits never file mentions")

    const claimed = await eventually(async () => (await call("POST", "/mentions/claim", { runner: "e2e", artifactId: d.id }, "agent")).body, 6000)
    assert.equal(claimed.id, queued.id)
    assert.equal(claimed.status, "running")
    assert.equal((await call("POST", "/mentions/claim", { runner: "e2e-2", artifactId: d.id }, "agent")).body, null, "a claimed mention isn't handed out twice")

    const done = await call("POST", `/mentions/${claimed.id}/complete`, { status: "done", result: "Wrote 3 risks" }, "agent")
    assert.equal(done.body.status, "done")
    await write("@claude list 3 risks (edited)")
    await settle(300)
    assert.equal((await mine(d.id)).length, 1, "editing an answered mention doesn't re-run it")
    assert.equal((await call("POST", "/mentions/claim", { runner: "x", artifactId: d.id }, "guest")).status, 403)
  })

  test("board shapes and table cells file mentions too", async () => {
    const b = await create("board", "mention board")
    await ops(b.id, [{ type: "insert", item: { id: "s_ask", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "@claude 3 onboarding ideas" } }], "owner")
    const t = await create("table", "mention table")
    const tc = await content(t.id)
    await ops(t.id, [{ type: "setCell", rowId: tc.state.rowIds[0], colId: tc.state.columns[0].id, value: "@agent research these companies" }], "owner")
    await eventually(async () => (await mine(b.id)).some((m) => m.target.type === "shape" && m.target.id === "s_ask"))
    await eventually(async () => (await mine(t.id)).some((m) => m.target.type === "cell" && m.kind === "table"))
  })
})
