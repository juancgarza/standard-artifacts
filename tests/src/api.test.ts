import assert from "node:assert/strict"
import { after, describe, test } from "node:test"
import { API, BASE, call, cleanup, content, create, eventually, ops, presence, settle, socket } from "./harness.ts"
import { html, images, svg } from "./images.ts"

after(cleanup)

describe("workspace", () => {
  test("create, rename, list, delete", async () => {
    const a = await create("doc", "workspace crud")
    const renamed = await call("PATCH", `/artifacts/${a.id}`, { title: "e2e renamed" })
    assert.equal(renamed.body.title, "e2e renamed")
    const list = await call("GET", "/workspace")
    assert.ok(list.body.artifacts.some((x: { id: string }) => x.id === a.id))
  })

  test("archive hides an artifact everywhere; restore brings it back intact", async () => {
    const a = await create("doc", "archive me")
    const applied = await ops(a.id, [{ type: "insert", item: { id: "k_keep", type: "paragraph", text: "still here" } }])
    assert.equal(applied.status, 200, JSON.stringify(applied.body))
    const before = await content(a.id)
    const link = await call("POST", `/artifacts/${a.id}/link`)
    assert.equal(link.status, 200, JSON.stringify(link.body))
    const listed = async () => (await call("GET", "/workspace")).body.artifacts.some((x: { id: string }) => x.id === a.id)
    const inArchive = async () => (await call("GET", "/artifacts/archived")).body.some((x: { id: string }) => x.id === a.id)

    for (const as of ["guest", "viewer"] as const) {
      assert.equal((await call("POST", `/artifacts/${a.id}/archive`, undefined, as)).status, 403, as)
      assert.equal((await call("GET", "/artifacts/archived", undefined, as)).status, 403, as)
    }

    const archived = await call("POST", `/artifacts/${a.id}/archive`)
    assert.equal(archived.status, 200)
    assert.ok(archived.body.archivedAt)
    assert.equal(await listed(), false)
    assert.equal(await inArchive(), true)
    assert.equal((await call("GET", `/artifacts/${a.id}/content`)).status, 404)
    assert.equal((await ops(a.id, [{ type: "insert", item: { id: "k_late", type: "paragraph", text: "late" } }])).status, 404)
    assert.equal((await fetch(`${BASE}${link.body.path}`, { redirect: "manual" })).status, 404, "its share link is off")
    assert.equal((await call("POST", `/artifacts/${a.id}/archive`)).status, 404, "already archived")

    const restored = await call("POST", `/artifacts/${a.id}/restore`)
    assert.equal(restored.status, 200)
    assert.equal(restored.body.archivedAt, undefined)
    assert.equal(await listed(), true)
    assert.equal(await inArchive(), false)
    const after = await content(a.id)
    assert.deepEqual(after.state, before.state, "content survives")
    assert.notEqual((await fetch(`${BASE}${link.body.path}`, { redirect: "manual" })).status, 404, "its share link works again")
  })

  test("an archived artifact can still be deleted for good", async () => {
    const a = await create("board", "archive then delete")
    await call("POST", `/artifacts/${a.id}/archive`)
    assert.equal((await call("DELETE", `/artifacts/${a.id}`)).status, 200)
    assert.equal((await call("POST", `/artifacts/${a.id}/restore`)).status, 404)
  })

  test("validation errors are readable", async () => {
    const r = await call("POST", "/artifacts", { kind: "slides" })
    assert.equal(r.status, 400)
    assert.equal(r.body._tag, "Invalid")
    assert.match(r.body.message, /board.*table.*doc/)
  })

  test("guests and viewers are read-only", async () => {
    for (const as of ["guest", "viewer"] as const) {
      const r = await call("POST", "/artifacts", { kind: "doc" }, as)
      assert.equal(r.status, 403, as)
    }
  })

  test("forged tickets are rejected", async () => {
    const res = await fetch(`${API}/workspace`, { headers: { authorization: "Bearer forged.ticket" } })
    assert.equal(res.status, 401)
  })
})

describe("table cell", () => {
  test("seeds, applies agent ops, renders text for agents", async () => {
    const t = await create("table", "table ops")
    const c = await content(t.id)
    assert.deepEqual(c.state.columns.map((x: { name: string }) => x.name), ["Name", "Website", "Status"])
    const [name] = c.state.columns
    const [row] = c.state.rowIds
    const r = await ops(t.id, [
      { type: "addColumn", column: { id: "c_email", name: "Email", type: "email" } },
      { type: "setCell", rowId: row, colId: name.id, value: "Ada" },
      { type: "setCell", rowId: row, colId: "c_email", value: "ada@example.com", status: "done", sources: ["https://example.com/ada"] },
    ])
    assert.equal(r.body.applied, 3)
    const after = await content(t.id)
    assert.match(after.text, /Ada/)
    assert.deepEqual(after.state.cells[`${row}:c_email`].sources, ["https://example.com/ada"])
    assert.equal(after.state.cells[`${row}:c_email`].by, "agt_dev:usr_dev")
  })

  test("rejects invalid ops and guest writes", async () => {
    const t = await create("table", "table rejects")
    assert.equal((await ops(t.id, [{ type: "setCell", rowId: "r_nope", colId: "c_nope", value: 1 }])).status, 400)
    const c = await content(t.id)
    assert.equal((await ops(t.id, [{ type: "removeRows", rowIds: [c.state.rowIds[0]] }], "guest")).status, 403)
  })
})

describe("board cell", () => {
  test("z-order moves, arrows need both ends, removing a shape removes its arrows", async () => {
    const b = await create("board", "board ops")
    const note = (await content(b.id)).state.items[0].id
    assert.equal(
      (await ops(b.id, [
        { type: "insert", item: { id: "s_rect", kind: "rect", x: 300, y: 0, w: 160, h: 100, text: "Research" } },
        { type: "insert", item: { id: "s_arrow", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: note, to: "s_rect" } },
        { type: "move", id: note, after: "s_arrow" },
      ])).body.applied,
      3,
    )
    const dangling = await ops(b.id, [{ type: "insert", item: { id: "s_bad", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "x", to: "s_rect" } }])
    assert.equal(dangling.status, 400)
    assert.deepEqual((await content(b.id)).state.items.map((s: { id: string }) => s.id), ["s_rect", "s_arrow", note])
    await ops(b.id, [{ type: "remove", ids: ["s_rect"] }])
    assert.deepEqual((await content(b.id)).state.items.map((s: { id: string }) => s.id), [note])
  })

  test("images round-trip byte for byte; uploads are validated", async () => {
    const b = await create("board", "board assets")
    const png = images.png
    const up = await fetch(`${API}/artifacts/${b.id}/assets`, { method: "POST", headers: { "content-type": "image/png" }, body: png })
    assert.equal(up.status, 201)
    const { url } = await up.json()
    const down = new Uint8Array(await (await fetch(new URL(url, API))).arrayBuffer())
    assert.deepEqual(down, png)
    const post = (headers: Record<string, string>, body: BodyInit) => fetch(`${API}/artifacts/${b.id}/assets`, { method: "POST", headers, body })
    assert.equal((await post({ "content-type": "image/png", "x-dev-as": "guest" }, png)).status, 403)
    assert.equal((await post({ "content-type": "text/plain" }, "hi")).status, 400)
    assert.equal((await post({ "content-type": "image/png" }, new Uint8Array(2_000_000))).status, 400)
  })

  test("uploads are checked by their bytes and served as what they are", async () => {
    const b = await create("board", "board asset sniffing")
    const post = (type: string, body: Uint8Array<ArrayBuffer>) =>
      fetch(`${API}/artifacts/${b.id}/assets`, { method: "POST", headers: { "content-type": type }, body })
    const refused = async (type: string, body: Uint8Array<ArrayBuffer>, message: RegExp) => {
      const res = await post(type, body)
      assert.equal(res.status, 400, type)
      assert.match((await res.json()).message, message)
    }
    await refused("image/png", html, /isn't a PNG, JPEG, GIF or WebP/)
    await refused("image/gif", svg, /isn't a PNG, JPEG, GIF or WebP/)
    await refused("image/svg+xml", svg, /Unsupported type/)
    await refused("image/png", images.png.subarray(0, images.png.length - 20), /PNG file is incomplete/)
    await refused("image/jpeg", images.jpeg.subarray(0, 100), /JPEG file is incomplete/)

    // Each real type comes back with its own type, even when the upload claimed another.
    for (const [declared, bytes, served] of [
      ["image/png", images.png, "image/png"],
      ["image/jpeg", images.jpeg, "image/jpeg"],
      ["image/gif", images.gif, "image/gif"],
      ["image/webp", images.webp, "image/webp"],
      ["image/png", images.jpeg, "image/jpeg"],
    ] as const) {
      const up = await post(declared, bytes)
      assert.equal(up.status, 201, `${declared} ${served}`)
      const res = await fetch(new URL((await up.json()).url, API))
      assert.equal(res.headers.get("content-type"), served)
      assert.equal(res.headers.get("x-content-type-options"), "nosniff")
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/)
      assert.equal(res.headers.get("content-disposition"), null)
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes)
    }
  })
})

describe("doc images", () => {
  test("docs store images like boards; other kinds refuse them", async () => {
    const d = await create("doc", "doc assets")
    const png = images.png
    const post = (id: string, headers: Record<string, string>) => fetch(`${API}/artifacts/${id}/assets`, { method: "POST", headers, body: png })
    const up = await post(d.id, { "content-type": "image/png" })
    assert.equal(up.status, 201)
    const { url } = await up.json()
    assert.deepEqual(new Uint8Array(await (await fetch(new URL(url, API))).arrayBuffer()), png)
    assert.equal((await post(d.id, { "content-type": "image/png", "x-dev-as": "guest" })).status, 403)
    const t = await create("table", "no assets")
    assert.equal((await post(t.id, { "content-type": "image/png" })).status, 400)
  })

  test("only https and asset sources are accepted", async () => {
    const d = await create("doc", "doc image src")
    const insert = (id: string, src: string) => ops(d.id, [{ type: "insert", item: { id, type: "image", text: "", src } }])
    for (const src of ["javascript:alert(1)", "http://example.com/a.png", "data:image/png;base64,AAAA", "/api/v1/share/exit", "/api/v1/artifacts/../../share/exit", "https://exa mple.com/a.png"]) {
      assert.equal((await insert("k_bad", src)).status, 400, src)
    }
    assert.equal((await insert("k_url", "https://example.com/a.png")).status, 200)
  })
})

describe("doc cell", () => {
  test("block ops keep order and render markdown", async () => {
    const d = await create("doc", "doc ops")
    const first = (await content(d.id)).state.items[0].id
    await ops(d.id, [
      { type: "update", id: first, patch: { type: "heading1", text: "Plan" } },
      { type: "insert", item: { id: "k_2", type: "paragraph", text: "Ship it." }, after: first },
      { type: "insert", item: { id: "k_3", type: "todo", text: "Tests", checked: true }, after: "k_2" },
      { type: "insert", item: { id: "k_mid", type: "bullet", text: "between" }, after: "k_2" },
    ])
    const c = await content(d.id)
    assert.equal(c.text, "# Plan\n\nShip it.\n\n- between\n\n- [x] Tests")
    const bad = await ops(d.id, [{ type: "update", id: first, patch: { type: "heading9" } }])
    assert.equal(bad.status, 400)
    assert.match(bad.body.message, /heading/)
  })
})

describe("rooms", () => {
  test("live ops, read-only guests, and agent presence that expires", async () => {
    const t = await create("table", "room sockets")
    const c = await content(t.id)
    const owner = socket(t.id)
    const guest = socket(t.id, "guest")
    await Promise.all([owner.ready, guest.ready])
    // The guest may connect first (then it's in the owner's init members) or second (a join).
    await eventually(() =>
      owner.messages.some(
        (m) => (m.type === "join" && m.member.readOnly) || (m.type === "init" && m.members.some((x: { readOnly: boolean }) => x.readOnly)),
      ),
    )

    owner.send({ type: "op", id: "o1", op: { type: "setCell", rowId: c.state.rowIds[0], colId: c.state.columns[0].id, value: "Live" } })
    guest.send({ type: "op", id: "g1", op: { type: "setCell", rowId: c.state.rowIds[0], colId: c.state.columns[0].id, value: "Nope" } })
    await eventually(() => guest.messages.find((m) => m.type === "op" && m.op.value === "Live"))
    await eventually(() => guest.messages.find((m) => m.type === "reject" && m.id === "g1"))

    assert.equal((await presence(t.id, "e2e-run", { thinking: true }, 1)).status, 204)
    await eventually(() => owner.messages.find((m) => m.type === "join" && m.member.actor.type === "agent"))
    await eventually(() => owner.messages.find((m) => m.type === "leave" && m.connectionId === "agent:e2e-run"), 6000)
    owner.ws.close()
    guest.ws.close()
    await settle(100)
  })
})
