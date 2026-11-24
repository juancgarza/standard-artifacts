import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { BASE, call, cleanup, content, create, eventually, launch, mcpSession, open, ops, ownerName, viewAsOnly, visit } from "./harness.ts"

/** Issue trackers: issues worked by people and agents, with where each came from and every agent run on record. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

type Item = { type: string; id: string; number?: number; status?: string; issueId?: string; state?: string; steps?: Array<{ text: string; artifactId?: string; ok?: boolean }>; [k: string]: any }
const items = async (id: string): Promise<Array<Item>> => (await content(id)).state.items
const issue = (id: string, n: number) => ({
  type: "issue",
  id,
  number: n,
  title: `Issue ${id}`,
  status: "todo",
  priority: "none",
  source: { via: "api" },
  createdAt: new Date().toISOString(),
})

describe("tracker", () => {
  test("ChatGPT works an issue delegated to it over MCP: its queue, a run with every change logged, then review", async () => {
    const t = await create("tracker", "MCP tracker")
    const memo = await create("doc", "Pricing memo")
    const chatgpt = await mcpSession("openai-mcp")

    // Created from a doc, over MCP, by ChatGPT: the source says so.
    const made = await chatgpt.tool("create_issue", { artifact: t.id, title: "Draft the pricing section", priority: "high", from: { artifact: memo.id } })
    assert.equal(made.error, false, made.text)
    let [created] = (await items(t.id)).filter((i) => i.type === "issue")
    assert.equal(created!.number, 1)
    assert.deepEqual(created!.source, { via: "mcp", client: "ChatGPT", from: { artifactId: memo.id, title: memo.title } })
    assert.equal(created!.createdByName, "ChatGPT", "named for the app, not the account it signs in with")

    // Delegated to "me" = ChatGPT, so it's in ChatGPT's queue and not in Codex's.
    assert.equal((await chatgpt.tool("update_issue", { artifact: t.id, issue: "1", delegate: "me" })).error, false)
    ;[created] = (await items(t.id)).filter((i) => i.type === "issue")
    assert.deepEqual(created!.delegate, { type: "agent", id: "chatgpt", name: "ChatGPT" })
    assert.match((await chatgpt.tool("my_issues", {})).text, new RegExp(`${t.id}\\) #1 Draft the pricing section`))
    const codex = await mcpSession("codex-mcp-client")
    assert.doesNotMatch((await codex.tool("my_issues", {})).text, new RegExp(t.id))

    // A run: starting moves the issue along; writes are logged as steps without being asked.
    assert.match((await chatgpt.tool("start_run", { artifact: t.id, issue: "#1", model: "gpt-5" })).text, /Started run/)
    assert.match((await chatgpt.tool("start_run", { artifact: t.id, issue: "1" })).text, /already have an open run/)
    assert.equal((await chatgpt.tool("doc_append", { artifact: memo.id, markdown: "## Pricing\n\nFree and Team." })).error, false)
    assert.equal((await chatgpt.tool("log_step", { text: "Compared with last quarter's pricing", artifact: memo.id })).error, false)
    assert.match((await chatgpt.tool("complete_run", { summary: "Drafted **two tiers** in the memo." })).text, /Needs review/)

    const after = await items(t.id)
    const run = after.find((i) => i.type === "run")!
    assert.equal(run.client, "ChatGPT")
    assert.equal(run.agent.name, "ChatGPT")
    assert.equal(run.model, "gpt-5")
    assert.equal(run.state, "needs_review")
    assert.ok(run.endedAt)
    assert.equal(run.summary, "Drafted **two tiers** in the memo.")
    assert.deepEqual(
      run.steps!.map((s) => s.text),
      [`Writing in ${memo.title}`, "Compared with last quarter's pricing"],
    )
    assert.ok(run.steps!.every((s) => s.artifactId === memo.id))
    assert.equal(after.find((i) => i.type === "issue")!.status, "in_review")
    assert.match((await chatgpt.tool("log_step", { text: "late" })).text, /No open run/)
    assert.equal((await chatgpt.tool("comment_issue", { artifact: t.id, issue: "1", text: "Ready for a look" })).error, false)
    assert.equal((await items(t.id)).find((i) => i.type === "comment")!.name, "ChatGPT")

    // The whole record reads back for any agent, and as an @-mentionable resource.
    const detail = (await chatgpt.tool("get_issue", { artifact: t.id, issue: "1" })).text
    assert.match(detail, /Created by .* via ChatGPT from e2e Pricing memo/)
    assert.match(detail, /Run r_\w+: ChatGPT · Needs review/)
    assert.match(detail, /- Writing in e2e Pricing memo/)
    const found = (await chatgpt.tool("search_mentions", { query: "#1" })).structured.items as Array<{ uri: string; name: string }>
    const link = found.find((i) => i.uri === `stdartifacts://tracker/${t.id}/1`)
    assert.ok(link, JSON.stringify(found))
    const read = (await chatgpt.request("resources/read", { uri: link.uri })).result
    assert.match(read.contents[0].text, /^# Draft the pricing section/)
    assert.match(read.contents[0].text, /Summary: Drafted/)
  })

  test("the reducer numbers issues, stamps who did what, and keeps runs and comments attached", async () => {
    const t = await create("tracker", "rules")
    // Numbers come from the tracker, not the writer.
    assert.equal((await ops(t.id, [{ type: "insert", item: issue("is_a", 99) }, { type: "insert", item: issue("is_b", 1) }], "owner")).status, 200)
    let all = await items(t.id)
    assert.deepEqual(all.map((i) => i.number), [1, 2])
    assert.equal(all[0]!.createdBy, "usr_dev")

    // Runs and comments need a real issue; fields must belong to the record.
    const at = new Date().toISOString()
    const run = { type: "run", id: "r_1", issueId: "is_a", agent: { id: "x", name: "Claude" }, state: "running", startedAt: at, steps: [] }
    assert.equal((await ops(t.id, [{ ...run, issueId: "nope" }].map((item) => ({ type: "insert", item })))).status, 400)
    assert.equal((await ops(t.id, [{ type: "insert", item: run }])).status, 200)
    assert.equal((await ops(t.id, [{ type: "update", id: "is_a", patch: { state: "done" } }])).status, 400)
    assert.equal((await ops(t.id, [{ type: "runStep", run: "r_1", step: { at, text: "Read the brief" } }])).status, 200)
    assert.equal((await ops(t.id, [{ type: "insert", item: { type: "comment", id: "c_1", issueId: "is_a", text: "Mine", at } }], "owner")).status, 200)
    all = await items(t.id)
    assert.equal(all.find((i) => i.id === "r_1")!.startedBy, "agt_dev:usr_dev")
    assert.deepEqual(all.find((i) => i.id === "r_1")!.steps!.map((s) => s.text), ["Read the brief"])

    // Only a comment's author edits it.
    assert.equal((await ops(t.id, [{ type: "update", id: "c_1", patch: { text: "Edited" } }], "agent")).status, 400)
    assert.equal((await ops(t.id, [{ type: "update", id: "c_1", patch: { text: "Edited" } }], "owner")).status, 200)

    // Removing an issue takes its runs and comments with it; viewers can't write.
    assert.equal((await ops(t.id, [{ type: "insert", item: issue("is_c", 0) }], "viewer")).status, 403)
    assert.equal((await ops(t.id, [{ type: "remove", ids: ["is_a"] }], "owner")).status, 200)
    assert.deepEqual((await items(t.id)).map((i) => i.id), ["is_b"])
  })

  test("in the app: create with C, delegate to an agent, comment, follow a run live, approve it", viewAsOnly, async () => {
    const t = await create("tracker", "UI tracker")
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 860 })
    await visit(page, `${BASE}/issues/${t.id}`, page.getByText("No issues yet"))

    await page.keyboard.press("c")
    const dialog = page.getByRole("dialog", { name: "New issue" })
    await dialog.waitFor()
    await page.keyboard.type("Research Ramp's pricing")
    await dialog.getByRole("button", { name: "Delegate" }).click()
    await page.getByRole("listbox", { name: "Delegate" }).getByRole("option", { name: "Claude" }).click()
    // Focus is back on the Delegate chip, where Enter would reopen it; ⌘Enter creates from anywhere in the dialog.
    await page.keyboard.press("Meta+Enter")
    await eventually(async () => (await dialog.count()) === 0)
    const row = page.locator("[data-issue-id]").first()
    await row.getByText("Research Ramp's pricing").waitFor()
    const [made] = await items(t.id)
    assert.equal(made!.number, 1)
    assert.deepEqual(made!.delegate, { type: "agent", id: "claude", name: "Claude" })
    assert.deepEqual(made!.owner, { id: "usr_dev", name: await ownerName() })
    assert.deepEqual(made!.source, { via: "web" })

    // Space peeks the issue in a panel beside the list: status from its menu, a comment, the source line.
    await page.keyboard.press("j")
    await page.keyboard.press(" ")
    const panel = page.locator("[data-issue-panel]")
    await panel.waitFor()
    await panel.getByText("JC created this in the app").waitFor()
    await panel.getByRole("button", { name: "Status" }).click()
    await page.getByRole("listbox", { name: "Status" }).getByRole("option", { name: "In progress" }).click()
    await eventually(async () => (await items(t.id))[0]!.status === "in_progress")
    await page.locator('section[aria-label="In progress"]').waitFor()
    await panel.getByLabel("Comment").fill("Focus on the **Team** tier")
    await panel.getByRole("button", { name: "Comment" }).click()
    await panel.locator("[data-comment]").getByText("Team").waitFor()

    // An agent's run shows up as it happens: steps arrive live, then it waits for review.
    const at = new Date().toISOString()
    await ops(t.id, [{ type: "insert", item: { type: "run", id: "r_ui", issueId: made!.id, agent: { id: "agt_dev:usr_dev", name: "Claude" }, client: "stdartifacts agent serve", state: "running", startedAt: at, steps: [] } }])
    const card = panel.locator('[data-run="r_ui"]')
    await card.waitFor()
    assert.equal(await card.getAttribute("data-run-state"), "running")
    await row.locator("[data-agent-working]").waitFor()
    await ops(t.id, [{ type: "runStep", run: "r_ui", step: { at, text: "Searched for Ramp pricing", tool: "web_search" } }])
    await card.getByText("Searched for Ramp pricing").waitFor()
    await ops(t.id, [{ type: "update", id: "r_ui", patch: { state: "needs_review", summary: "Ramp has **3 plans**.", endedAt: new Date().toISOString() } }])
    await card.getByText("3 plans").waitFor()
    await card.getByRole("button", { name: "Approve" }).click()
    await eventually(async () => (await items(t.id)).find((i) => i.id === "r_ui")!.state === "done")
    await eventually(async () => (await card.getAttribute("data-run-state")) === "done")

    // Esc closes the panel; viewers see everything but can't create or change.
    await page.keyboard.press("Escape")
    await eventually(async () => (await panel.count()) === 0)
    const viewer = await open(browser, "viewer", { width: 1400, height: 860 })
    await visit(viewer.page, `${BASE}/issues/${t.id}`, viewer.page.locator("[data-issue-id]").first())
    assert.equal(await viewer.page.getByRole("button", { name: "New issue" }).count(), 0)
    await viewer.page.locator("[data-issue-id]").first().click()
    assert.ok(await viewer.page.getByRole("button", { name: "Status" }).first().isDisabled())
    assert.equal(await viewer.page.getByLabel("Comment").count(), 0)
    assert.deepEqual(errors, [])
    assert.deepEqual(viewer.errors, [])
  })

  test("issues link boards, tables, docs and other issues; agents link over MCP; runs show what they touched", async () => {
    const t = await create("tracker", "links")
    const leads = await create("table", "Leads to link")
    const plan = await create("board", "Plan to link")
    const mcp = await mcpSession("openai-mcp")
    assert.equal((await mcp.tool("create_issue", { artifact: t.id, title: "Follow up with leads", links: [leads.id] })).error, false)
    assert.equal((await mcp.tool("create_issue", { artifact: t.id, title: "Plan the follow-ups" })).error, false)
    // Links are artifacts, or issues in this same tracker ("#1").
    assert.equal((await mcp.tool("update_issue", { artifact: t.id, issue: "2", link: ["#1", plan.title] })).error, false)
    let [first, second] = (await items(t.id)).filter((i) => i.type === "issue")
    assert.deepEqual(first!.links, [{ artifactId: leads.id }])
    assert.deepEqual(second!.links, [{ artifactId: t.id, item: first!.id }, { artifactId: plan.id }])
    assert.equal((await mcp.tool("update_issue", { artifact: t.id, issue: "2", unlink: [plan.id] })).error, false)
    ;[, second] = (await items(t.id)).filter((i) => i.type === "issue")
    assert.deepEqual(second!.links, [{ artifactId: t.id, item: first!.id }])
    assert.match((await mcp.tool("get_issue", { artifact: t.id, issue: "2" })).text, /Linked: #1 Follow up with leads \(issue here\)/)
    assert.match((await mcp.tool("get_issue", { artifact: t.id, issue: "1" })).text, new RegExp(`Linked: e2e Leads to link \\(table ${leads.id}\\)`))

    // A run on #2 touches the board; the issue shows it without anyone linking it.
    await mcp.tool("start_run", { artifact: t.id, issue: "2" })
    await mcp.tool("board_add", { artifact: plan.id, items: [{ text: "Call Ada" }] })
    await mcp.tool("complete_run", { summary: "Added a note" })

    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, `${BASE}/issues/${t.id}`, page.locator("[data-issue-id]").first())
    await page.locator("[data-issue-id]", { hasText: "Plan the follow-ups" }).click()
    const panel = page.locator("[data-issue-page]")
    const linked = panel.locator("[data-linked]")
    await linked.locator(`[data-link="${t.id}/${first!.id}"]`).getByText("Follow up with leads").waitFor()
    await linked.locator("[data-touched]").getByText(plan.title).waitFor()

    // Link the table from the picker; it shows as a card with a live preview.
    await linked.getByRole("button", { name: "Link", exact: true }).click()
    // The picker only gets a filter box past 6 choices, which depends on what earlier tests left around.
    await page.getByRole("listbox", { name: "Link" }).getByRole("option", { name: leads.title }).click()
    await linked.locator(`[data-link="${leads.id}/"]`).waitFor()
    await eventually(async () => (await items(t.id)).find((i) => i.id === second!.id)!.links?.length === 2)
    // "Link it" turns something a run touched into a link.
    await linked.locator("[data-touched]").getByRole("button", { name: `Link ${plan.title}` }).click()
    await linked.locator(`[data-link="${plan.id}/"]`).waitFor()

    // An issue link opens that issue here; an artifact link navigates in the app.
    await linked.locator(`[data-link="${t.id}/${first!.id}"]`).getByRole("button").first().click()
    await page.waitForURL(`**/issues/${t.id}/1`)
    await page.locator(`[data-issue-page="${first!.id}"]`).waitFor()
    await page.locator(`[data-issue-page="${first!.id}"] [data-link="${leads.id}/"]`).getByRole("button").first().click()
    await page.waitForURL(`**/tables/${leads.id}`)
    assert.deepEqual(errors, [])
  })

  test("each issue has its own page: deep links, J/K through the list, Esc back, links in its text", async () => {
    const t = await create("tracker", "pages")
    const memo = await create("doc", "Page memo")
    const at = new Date().toISOString()
    await ops(t.id, [
      { type: "insert", item: { ...issue("is_p1", 0), title: "First one", status: "in_progress" } },
      { type: "insert", item: { ...issue("is_p2", 0), title: "Second one", description: `Follows #1. Notes in [the memo](stdartifacts://doc/${memo.id}), [an older link](ah://doc/${memo.id}) and [the site](https://example.com).\n\n**Steps:**\n- read\n- write` } },
    ], "owner")
    await ops(t.id, [{ type: "insert", item: { type: "comment", id: "c_p", issueId: "is_p2", text: "See #1", at } }], "owner")

    // A deep link opens the page directly: title, properties sidebar, source card.
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, `${BASE}/issues/${t.id}/2`, page.locator('[data-issue-page="is_p2"]'))
    const pg = page.locator('[data-issue-page="is_p2"]')
    await pg.getByText("Second one").first().waitFor()
    assert.equal(await page.getByLabel("Position").textContent(), "2 / 2")
    await page.getByRole("complementary", { name: "Issue details" }).getByText("Through the API").waitFor()

    // Markdown: links to the doc and the web, a list after a bold line, and "#1" as an issue link.
    const desc = pg.getByRole("button", { name: "Edit description" })
    assert.equal(await desc.getByRole("link", { name: "the site" }).getAttribute("target"), "_blank")
    assert.equal(await desc.locator("li").count(), 2)
    assert.equal(await desc.getByRole("link", { name: "the memo" }).getAttribute("href"), `/docs/${memo.id}`)
    assert.equal(await desc.getByRole("link", { name: "an older link" }).getAttribute("href"), `/docs/${memo.id}`)
    await desc.getByRole("link", { name: "#1" }).first().click()
    await page.waitForURL(`**/issues/${t.id}/1`)
    assert.equal(await page.getByLabel("Description", { exact: true }).count(), 0, "following a link doesn't start editing")
    await page.locator('[data-issue-page="is_p1"]').waitFor()

    // J/K (or arrows) walk the list in its order; Esc goes back to the list with the cursor on that issue.
    await page.keyboard.press("j")
    await page.waitForURL(`**/issues/${t.id}/2`)
    await page.keyboard.press("k")
    await page.waitForURL(`**/issues/${t.id}/1`)
    await page.keyboard.press("Escape")
    await page.waitForURL(new RegExp(`/issues/${t.id}$`))
    await eventually(async () => (await page.locator('[data-issue-id="is_p1"]').getAttribute("aria-selected")) === "true")
    // Enter opens the page again; a click on a row does too.
    await page.keyboard.press("Enter")
    await page.waitForURL(`**/issues/${t.id}/1`)
    await page.goto(`${BASE}/issues/${t.id}/9`)
    await page.getByText("Issue #9 doesn't exist").waitFor()
    assert.deepEqual(errors, [])
  })

  test("spellings from before the rename still resolve: common-artifacts:// and commonartifacts:// links, the common-artifacts agent serve runner", async () => {
    const t = await create("tracker", "legacy")
    const memo = await create("doc", "Legacy memo")
    const description = `Notes in [dashed](common-artifacts://doc/${memo.id}), [joined](commonartifacts://doc/${memo.id}) and [oldest](ah://doc/${memo.id}).`
    await ops(t.id, [{ type: "insert", item: { ...issue("is_legacy", 0), title: "Old links", source: { via: "agent", client: "common-artifacts agent serve" }, description } }], "owner")

    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, `${BASE}/issues/${t.id}/1`, page.locator('[data-issue-page="is_legacy"]'))
    const desc = page.locator('[data-issue-page="is_legacy"]').getByRole("button", { name: "Edit description" })
    for (const name of ["dashed", "joined", "oldest"]) assert.equal(await desc.getByRole("link", { name }).getAttribute("href"), `/docs/${memo.id}`, name)
    // The runner's old name still gets Claude's mark.
    await page.getByRole("complementary", { name: "Issue details" }).locator("[data-issue-origin]").getByRole("img", { name: "Claude" }).waitFor()
    assert.deepEqual(errors, [])
  })

  test("a tracker shows on Home and in the sidebar, and creating one from Home opens it", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 860 })
    const card = page.getByRole("button", { name: /New tracker Track work/ })
    await visit(page, BASE, card)
    await card.click()
    await page.waitForURL(/\/issues\/i_\w+$/)
    const id = page.url().split("/").pop()!
    await page.getByText("No issues yet").waitFor()
    await call("DELETE", `/artifacts/${id}`)
    assert.deepEqual(errors, [])
  })

  test("what an agent creates over MCP carries the app it came from, and Home shows that app's mark", async () => {
    const codex = await mcpSession("codex-mcp-client")
    const made = await codex.tool("create_artifact", { kind: "board", title: "e2e made in Codex" })
    const id = /Created board (\S+)/.exec(made.text)?.[1]
    assert.ok(id, made.text)
    try {
      const listed = (await call("GET", "/workspace")).body.artifacts.find((a: { id: string }) => a.id === id)
      assert.equal(listed.client, "Codex")
      assert.ok(listed.createdByName, "the agent's name is kept")

      const { page, errors } = await open(browser, "owner", { width: 1400, height: 860 })
      // The Home card (the sidebar links it too, without a byline).
      const card = page.getByRole("link", { name: /e2e made in Codex/ }).filter({ has: page.locator('[data-creator-brand="codex"]') })
      await visit(page, BASE, card)
      await card.getByText("Codex", { exact: true }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await call("DELETE", `/artifacts/${id}`)
    }
  })
})
