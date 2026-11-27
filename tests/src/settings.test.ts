import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { BASE, call, launch, open, viewAsOnly, visit } from "./harness.ts"

/** The settings page: every section reachable, the theme sticks, and guests only get what's theirs. */

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
})

describe("settings", () => {
  test("members lists who has shown up; guests can't read it", async () => {
    assert.equal((await call("GET", "/workspace")).status, 200)
    await call("GET", "/workspace", undefined, "agent")
    const { status, body } = await call("GET", "/members")
    assert.equal(status, 200)
    assert.ok(body.people.some((p: { id: string }) => p.id === "usr_dev"), "the owner who just showed up")
    assert.ok(body.agents.some((a: { id: string; onBehalfOf: string }) => a.id === "agt_dev" && a.onBehalfOf === "usr_dev"), "the agent, and who it acts for")
    assert.equal((await call("GET", "/members", undefined, "viewer")).status, 200, "viewers can see who's here")
    assert.equal((await call("GET", "/members", undefined, "guest")).status, 403)
  })

  test("from the sidebar gear to every section, in one tab", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 820 })
    const gear = page.getByRole("link", { name: "Settings", exact: true })
    await visit(page, `${BASE}/`, gear)
    const tabs = page.locator("[data-tab-strip]").getByRole("tab")
    // The sidebar (and its gear) shows while the workspace loads, but tabs are only restored once it's ready.
    // Counting before then reads 0, and Settings then looks like it opened a tab of its own.
    await tabs.first().waitFor()
    const before = await tabs.count()
    assert.equal(before, 1, "a fresh window opens on one tab")

    await gear.click()
    await page.waitForURL(`${BASE}/settings`)
    const nav = page.getByRole("navigation", { name: "Settings" })
    const main = page.locator("main")
    await main.getByRole("heading", { name: "Profile" }).waitFor()
    assert.equal(await nav.getByRole("link", { name: "Profile" }).getAttribute("aria-current"), "page", "the first section is the default")

    await nav.getByRole("link", { name: "General" }).click()
    await page.waitForURL(`${BASE}/settings/general`)
    await main.getByText("Dev Org").waitFor()

    await nav.getByRole("link", { name: "Members" }).click()
    await main.getByText("(you)").waitFor()

    await nav.getByRole("link", { name: "Agents" }).click()
    // Agents points at Connections, where agents get connected.
    await main.getByText(/To connect Claude, ChatGPT/).getByRole("link", { name: "Connections" }).click()
    await page.waitForURL(`${BASE}/settings/connections`)
    await main.getByRole("heading", { name: "Connect an agent" }).waitFor()
    assert.equal(await main.getByRole("textbox", { name: "MCP server URL" }).inputValue(), `${BASE}/mcp`)
    await main.getByText(`claude mcp add --transport http standard-artifacts ${BASE}/mcp`).waitFor()
    await main.getByText(`codex mcp add standard-artifacts --url ${BASE}/mcp`).waitFor()

    assert.equal(await tabs.count(), before, "sections move within the tab")
    await tabs.getByText("Settings").waitFor()

    // A direct link lands on the section, not on an artifact called "settings".
    await visit(page, `${BASE}/settings/agents`, main.getByRole("heading", { name: "Agents", exact: true }))
    assert.deepEqual(errors, [])
  })

  test("theme applies at once, survives a reload, and System follows the device", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 820 })
    await page.emulateMedia({ colorScheme: "light" })
    await visit(page, `${BASE}/settings/appearance`, page.getByRole("radiogroup", { name: "Theme" }))
    const applied = () => page.evaluate(() => document.documentElement.dataset.theme)
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const theme = page.getByRole("radiogroup", { name: "Theme" })

    assert.equal(await applied(), "light")
    const light = await background()

    await theme.getByText("Dark").click()
    assert.equal(await applied(), "dark")
    assert.notEqual(await background(), light, "the tokens follow")

    await page.reload()
    await theme.waitFor()
    assert.equal(await applied(), "dark", "a choice beats the device, and sticks")
    assert.equal(await theme.getByRole("radio", { name: "Dark" }).isChecked(), true)

    await theme.getByText("System").click()
    assert.equal(await applied(), "light")
    await page.emulateMedia({ colorScheme: "dark" })
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
    assert.deepEqual(errors, [])
  })

  test("a guest only gets Appearance; a viewer doesn't get Archived", viewAsOnly, async () => {
    const guest = await open(browser, "guest", { width: 1400, height: 820 })
    await visit(guest.page, `${BASE}/settings/members`, guest.page.getByRole("radiogroup", { name: "Theme" }))
    const links = guest.page.getByRole("navigation", { name: "Settings" }).getByRole("link")
    assert.deepEqual(await links.allInnerTexts(), ["Appearance"], "nothing else is theirs to see")
    assert.deepEqual(guest.errors, [])

    const viewer = await open(browser, "viewer", { width: 1400, height: 820 })
    await visit(viewer.page, `${BASE}/settings/general`, viewer.page.locator("main").getByText("Dev Org"))
    assert.equal(await viewer.page.locator("main").getByRole("link", { name: "Open" }).count(), 0)
    assert.deepEqual(viewer.errors, [])
  })

  test("⌘K finds Settings", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 820 })
    await visit(page, `${BASE}/`, page.getByRole("button", { name: "Search" }))
    await page.getByRole("button", { name: "Search" }).click()
    await page.getByRole("combobox", { name: "Search boards" }).fill("settings")
    await page.getByRole("option", { name: "Settings", exact: true }).click()
    await page.waitForURL(`${BASE}/settings`)
    assert.deepEqual(errors, [])
  })

  test("phone width: the section nav scrolls instead of pushing the page sideways", async () => {
    const { page, errors } = await open(browser, "owner", { width: 390, height: 780 })
    await visit(page, `${BASE}/settings/connections`, page.locator("main").getByRole("heading", { name: "Connect an agent" }))
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.equal(overflow, 0)
    const current = await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Connections" }).boundingBox()
    assert.ok(current && current.x >= 0 && current.x + current.width <= 390, "the current section is scrolled into view")
    assert.deepEqual(errors, [])
  })
})
