import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import { eventually, launch } from "./harness.ts"
import { startLive, Visitor, type LiveApp } from "./live-harness.ts"

/**
 * Live mode in a real browser, against a fake WorkOS: the sign-in screen, the
 * hosted sign-in round trip, the account menu and org switcher, Members and
 * Access tokens in Settings, a live doc over a ticketed socket, and sign-out.
 * It runs the production web build, as Cloud does.
 */

let app: LiveApp
let browser: Browser
before(async () => {
  app = await startLive()
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await app?.close()
})

async function page() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const p = await ctx.newPage()
  const errors: Array<string> = []
  p.on("pageerror", (e) => errors.push(e.message))
  return { page: p, errors }
}

/** Sign in through the app's sign-in screen and the fake AuthKit page. */
async function signIn(p: Page, email: string) {
  await p.goto(app.base)
  await p.getByRole("heading", { name: "Sign in to Standard Artifacts" }).waitFor()
  await p.getByRole("button", { name: "Continue" }).click()
  await p.getByLabel("Email").fill(email)
  await p.getByRole("button", { name: "Continue" }).click()
  await p.getByRole("button", { name: "Account" }).waitFor({ timeout: 15000 })
}

describe("signing in (live mode)", () => {
  test("sign in, see who you are, switch workspaces, manage members and tokens, edit live, sign out", async () => {
    app.fake.user("uma@example.test", "Uma", "Ray")
    const { page: p, errors } = await page()
    await signIn(p, "uma@example.test")

    const sidebar = p.getByRole("navigation", { name: "Workspace" })
    await sidebar.getByText("Uma's workspace").waitFor()
    assert.match(await p.getByRole("button", { name: "Account" }).innerText(), /Uma Ray/)

    // The account menu: who, the workspaces, a new one.
    await p.getByRole("button", { name: "Account" }).click()
    const menu = p.getByRole("menu", { name: "Account" })
    await menu.getByText("uma@example.test").waitFor()
    await menu.getByRole("menuitemradio", { name: /Uma's workspace/, checked: true }).waitFor()
    await menu.getByRole("menuitem", { name: "New workspace" }).click()
    await menu.getByLabel("Workspace name").fill("Launch team")
    await menu.getByRole("button", { name: "Create" }).click()
    // Switching starts the app over in the other org (the menu, which lists orgs too, goes away).
    await menu.waitFor({ state: "detached", timeout: 15000 })
    await sidebar.getByText("Launch team").waitFor({ timeout: 15000 })

    // Back again through the switcher.
    await p.getByRole("button", { name: "Account" }).click()
    await p.getByRole("menuitemradio", { name: /Uma's workspace/ }).click()
    await menu.waitFor({ state: "detached", timeout: 15000 })
    await sidebar.getByText("Uma's workspace").waitFor({ timeout: 15000 })

    // Members: invite someone as a viewer, see them as invited, revoke.
    await p.goto(`${app.base}/settings/members`)
    await p.getByText("1 member").waitFor()
    await p.getByLabel("Email", { exact: true }).fill("guest@example.test")
    await p.getByLabel("Role for the invitation").selectOption("viewer")
    await p.getByRole("button", { name: "Invite" }).click()
    await p.getByText("Invitation sent to guest@example.test.").waitFor()
    const invited = p.getByRole("listitem").filter({ hasText: "guest@example.test" })
    await invited.getByText(/Viewer · expires/).waitFor()
    await invited.getByRole("button", { name: "Revoke" }).click()
    await eventually(async () => (await p.getByRole("listitem").filter({ hasText: "guest@example.test" }).count()) === 0)
    // The only owner can't remove or demote themselves.
    const me = p.getByRole("listitem").filter({ hasText: "(you)" })
    assert.equal(await me.getByRole("combobox").isDisabled(), true)

    // Access tokens: shown once, listed by name, revocable.
    await p.goto(`${app.base}/settings/tokens`)
    await p.getByLabel("Token name").fill("Laptop CLI")
    await p.getByRole("button", { name: "Create token" }).click()
    const shown = p.locator("code").filter({ hasText: /^sat_/ })
    await shown.waitFor()
    const token = (await shown.innerText()).trim()
    const viaToken = await fetch(`${app.base}/api/v1/workspace`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(viaToken.status, 200)
    assert.equal((await viaToken.json()).principal.orgName, "Uma's workspace")
    const row = p.getByRole("listitem").filter({ hasText: "Laptop CLI" })
    await row.getByText("never used").or(row.getByText(/last used/)).waitFor()
    await row.getByRole("button", { name: "Revoke" }).click()
    await row.getByRole("button", { name: "Revoke" }).click()
    await eventually(async () => (await fetch(`${app.base}/api/v1/workspace`, { headers: { authorization: `Bearer ${token}` } })).status === 401)

    // A doc, edited over its room socket (?ticket=), and still there after a reload.
    await p.goto(app.base)
    await sidebar.getByRole("button", { name: "New doc" }).first().click()
    await p.waitForURL(/\/docs\/d_/)
    const block = p.locator("[data-block-id] [role=textbox]").first()
    await block.click()
    await p.keyboard.type("Signed in and live")
    const docId = new URL(p.url()).pathname.split("/")[2]!
    const reader = new Visitor(app, "uma@example.test")
    await reader.signIn()
    await reader.session()
    await eventually(async () => JSON.stringify((await reader.api("GET", `/artifacts/${docId}/content`)).body?.state).includes("Signed in and live"), 10000)
    await p.reload()
    await p.locator("[data-block-id]").getByText("Signed in and live").waitFor()

    // Sign out: back to the sign-in screen, and the session is gone.
    await p.getByRole("button", { name: "Account" }).click()
    await p.getByRole("menuitem", { name: "Sign out" }).click()
    await p.getByRole("heading", { name: "Sign in to Standard Artifacts" }).waitFor({ timeout: 15000 })
    const status = await p.evaluate(async () => (await fetch("/api/auth/ticket", { method: "POST" })).status)
    assert.equal(status, 401)

    assert.deepEqual(errors, [])
  })

  test("an invitation link signs the invitee in and lands them in that workspace", async () => {
    const owner = new Visitor(app, "olga@example.test")
    app.fake.user("olga@example.test", "Olga")
    await owner.signIn()
    await owner.session()
    const sent = await owner.api("POST", "/org/invitations", { email: "ivan@example.test", role: "editor" })
    assert.equal(sent.status, 200)
    const token = app.fake.invitations.get(sent.body.id)!.token

    const { page: p, errors } = await page()
    // WorkOS's invitation email links to the app with ?invitation_token= when the app is set as the invite URL.
    await p.goto(`${app.base}/?invitation_token=${token}`)
    await p.getByLabel("Email").fill("ivan@example.test")
    await p.getByRole("button", { name: "Continue" }).click()
    await p.getByRole("navigation", { name: "Workspace" }).getByText("Olga's workspace").waitFor({ timeout: 15000 })
    assert.deepEqual(errors, [])
  })

  test("signed out, a share link still opens its page read-only", async () => {
    const owner = new Visitor(app, "sharer@example.test")
    app.fake.user("sharer@example.test", "Shay")
    await owner.signIn()
    await owner.session()
    const doc = (await owner.api("POST", "/artifacts", { kind: "doc", title: "Shared plan" })).body
    const link = (await owner.api("POST", `/artifacts/${doc.id}/link`)).body

    const { page: p, errors } = await page()
    await p.goto(`${app.base}${link.path}`)
    await p.waitForURL(new RegExp(`/docs/${doc.id}`))
    await p.getByText("Read-only").first().waitFor({ timeout: 15000 })
    assert.equal(await p.getByRole("heading", { name: "Sign in to Standard Artifacts" }).count(), 0)
    assert.deepEqual(errors, [])
  })
})
