import assert from "node:assert/strict"
import { after, describe, test } from "node:test"
import { BASE, cleanup, content, create, eventually, socket, type As } from "./harness.ts"

/** Remote MCP (Streamable HTTP at /mcp), as ChatGPT and Codex connect to it. */

after(cleanup)

type Rpc = { result?: any; error?: { code: number; message: string } }

/** A minimal Streamable HTTP client: initialize, then requests on the session. */
async function connect(as?: As) {
  let session: string | undefined
  let id = 0
  const post = async (body: object) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" }
    if (session) headers["mcp-session-id"] = session
    if (session) headers["mcp-protocol-version"] = "2025-11-25"
    if (as) headers["x-dev-as"] = as
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) })
    session ??= res.headers.get("mcp-session-id") ?? undefined
    const text = await res.text()
    // Responses may come as a JSON body or as a single SSE event.
    const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5)
    return { status: res.status, body: json ? (JSON.parse(json) as Rpc) : undefined }
  }
  const init = await post({
    jsonrpc: "2.0",
    id: ++id,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
  })
  assert.equal(init.status, 200)
  assert.ok(session, "the server starts a session")
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  const request = async (method: string, params: object = {}) => {
    const r = await post({ jsonrpc: "2.0", id: ++id, method, params })
    assert.equal(r.status, 200, `${method}: HTTP ${r.status}`)
    return r.body!
  }
  const callTool = async (name: string, args: object) => (await request("tools/call", { name, arguments: args })).result
  return { init: init.body!.result, request, callTool, session: () => session }
}

describe("remote MCP", () => {
  test("advertises ChatGPT @-mentions; search returns stdartifacts:// links that resources/read opens", async () => {
    const leads = await create("table", `Q4 Leads ${Date.now()}`)
    await create("doc", "Launch memo")
    const mcp = await connect()
    assert.deepEqual(mcp.init.capabilities.extensions["openai/mentions"], { searchTool: "search_mentions" })

    const { tools } = (await mcp.request("tools/list")).result
    const search = tools.find((t: any) => t.name === "search_mentions")
    assert.equal(search.annotations.readOnlyHint, true)
    assert.deepEqual(search._meta.ui.visibility, ["app"])
    assert.equal(tools.find((t: any) => t.name === "read_artifact").annotations.readOnlyHint, true)
    assert.equal(tools.find((t: any) => t.name === "board_add").annotations.readOnlyHint, false)

    // Word prefixes, any order: "lead q4" finds "Q4 Leads …".
    const found = await mcp.callTool("search_mentions", { query: "lead q4" })
    const link = found.structuredContent.items.find((i: any) => i.uri === `stdartifacts://table/${leads.id}`)
    assert.ok(link, JSON.stringify(found.structuredContent))
    assert.equal(link.type, "resource_link")
    assert.equal(link.name, leads.title)
    // Artifacts that match are tables; issues can match too (stdartifacts://tracker/<id>/<n>).
    assert.ok(found.structuredContent.items.every((i: any) => i.uri.startsWith("stdartifacts://table/") || /^stdartifacts:\/\/tracker\/i_\w+\/\d+$/.test(i.uri)))
    assert.ok((await mcp.callTool("search_mentions", { query: "" })).structuredContent.items.length >= 2)

    const { resourceTemplates } = (await mcp.request("resources/templates/list")).result
    assert.ok(resourceTemplates.some((t: any) => t.uriTemplate === "stdartifacts://{kind}/{id}"))
    const read = (await mcp.request("resources/read", { uri: link.uri })).result
    assert.equal(read.contents[0].uri, link.uri)
    assert.match(read.contents[0].text, new RegExp(`^# ${leads.title}`))
  })

  test("tools edit artifacts through the API, as an agent; sessions are per principal", async () => {
    const b = await create("board", "Remote MCP board")
    const watcher = socket(b.id)
    await watcher.ready
    const mcp = await connect()
    const added = await mcp.callTool("board_add", { artifact: b.id, items: [{ text: "From ChatGPT", color: "green" }] })
    assert.equal(added.isError, false)
    const shapes = (await content(b.id)).state.items as Array<{ text?: string }>
    assert.ok(shapes.some((s) => s.text === "From ChatGPT"))
    // People watching see an agent working, not the user whose account it is.
    await eventually(() => watcher.messages.find((m) => m.type === "join" && m.member.actor.type === "agent"))
    watcher.ws.close()

    // A read-only guest gets its own session, can read, and can't write.
    const guest = await connect("viewer")
    assert.notEqual(guest.session(), mcp.session())
    assert.equal((await guest.callTool("read_artifact", { artifact: b.id })).isError, false)
    const denied = await guest.callTool("board_add", { artifact: b.id, items: [{ text: "nope" }] })
    assert.equal(denied.isError, true)

    // A session id is only good with the principal it was made for.
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": mcp.session()!,
        "mcp-protocol-version": "2025-11-25",
        "x-dev-as": "viewer",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    })
    assert.equal(res.status, 404)
  })
})
