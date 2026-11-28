import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import type { Browser, Page } from "playwright-core"
import type { RunningServer } from "../../packages/server/src/index.ts"
import { launch } from "./harness.ts"
import { startLive, type LiveApp } from "./live-harness.ts"

/**
 * The workspace switcher the desktop app adds: in a real browser, with a fake
 * `window.standardArtifactsDesktop` standing in for the app. It checks that the
 * page shows the app's other workspaces and asks for them by id only.
 * (desktop-workspaces.test.ts covers the app's side.)
 */

const WORKSPACES = [
  { id: "cloud", kind: "cloud", label: "Standard Artifacts Cloud" },
  { id: "local", kind: "local", label: "This computer" },
  { id: "server-abc", kind: "server", label: "artifacts.example.com", detail: "artifacts.example.com" },
]

/** A page with the fake bridge, recording what it was asked. */
async function desktopPage(browser: Browser, current: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await ctx.addInitScript(
    ({ current, workspaces }) => {
      const asked: Array<string> = []
      Object.assign(window, { __asked: asked })
      Object.assign(window, {
        standardArtifactsDesktop: {
          platform: "darwin",
          onCommand: () => () => {},
          workspaces: async () => ({ current, workspaces }),
          openWorkspace: async (id: string) => void asked.push(`open:${id}`),
          addWorkspace: async () => void asked.push("add"),
        },
      })
    },
    { current, workspaces: WORKSPACES },
  )
  return ctx.newPage()
}
const asked = (p: Page) => p.evaluate(() => (window as unknown as { __asked: Array<string> }).__asked)

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
})

describe("desktop workspaces: this computer (Solo)", () => {
  let server: RunningServer
  let data: string
  before(async () => {
    data = mkdtempSync(join(tmpdir(), "sa-desktop-ws-"))
    const { serve } = (await import("../../packages/server/dist/index.mjs")) as typeof import("../../packages/server/src/index.ts")
    server = await serve({ port: 0, data, name: "Sol" })
  })
  after(async () => {
    await server?.close()
    rmSync(data, { recursive: true, force: true })
  })

  test("the sidebar names this computer and switches to Cloud or another server by id", async () => {
    const p = await desktopPage(browser, "local")
    await p.goto(server.url)
    const button = p.getByRole("button", { name: "Workspace" })
    await button.waitFor({ timeout: 15000 })
    assert.match(await button.innerText(), /This computer/)
    await button.click()
    const menu = p.getByRole("menu", { name: "Workspace" })
    await menu.getByText("Solo. Your work stays on this computer.").waitFor()
    await menu.getByRole("menuitemradio", { name: /This computer/, checked: true }).waitFor()
    await menu.getByRole("menuitem", { name: /Standard Artifacts Cloud/ }).click()
    assert.deepEqual(await asked(p), ["open:cloud"])
    await menu.getByRole("menuitem", { name: /artifacts\.example\.com/ }).click()
    await menu.getByRole("menuitem", { name: "Add a workspace…" }).click()
    assert.deepEqual(await asked(p), ["open:cloud", "open:server-abc", "add"])
    await p.context().close()
  })

  test("in a browser there's no switcher, just who you are", async () => {
    const ctx = await browser.newContext()
    const p = await ctx.newPage()
    await p.goto(server.url)
    await p.getByRole("navigation", { name: "Workspace" }).getByText("Sol").waitFor({ timeout: 15000 })
    assert.equal(await p.getByRole("button", { name: "Workspace" }).count(), 0)
    await ctx.close()
  })
})

describe("desktop workspaces: Cloud", () => {
  let app: LiveApp
  before(async () => {
    app = await startLive()
  })
  after(async () => {
    await app?.close()
  })

  test("signed out, the sign-in page offers the other workspaces", async () => {
    const p = await desktopPage(browser, "cloud")
    await p.goto(app.base)
    await p.getByRole("heading", { name: "Sign in to Standard Artifacts" }).waitFor({ timeout: 15000 })
    await p.getByRole("button", { name: "Use a different workspace, like this computer" }).click()
    assert.deepEqual(await asked(p), ["add"])
    await p.context().close()
  })

  test("signed in, the account menu lists Cloud workspaces, then the other places", async () => {
    app.fake.user("dee@example.test", "Dee", "Sk")
    const p = await desktopPage(browser, "cloud")
    await p.goto(app.base)
    await p.getByRole("button", { name: "Continue" }).click()
    await p.getByLabel("Email").fill("dee@example.test")
    await p.getByRole("button", { name: "Continue" }).click()
    await p.getByRole("button", { name: "Account" }).click({ timeout: 15000 })
    const menu = p.getByRole("menu", { name: "Account" })
    await menu.getByText("Cloud workspaces").waitFor()
    await menu.getByRole("menuitem", { name: "New Cloud workspace" }).waitFor()
    await menu.getByText("Other places").waitFor()
    assert.equal(await menu.getByRole("menuitem", { name: /Standard Artifacts Cloud/ }).count(), 0, "the current place isn't offered again")
    await menu.getByRole("menuitem", { name: /This computer/ }).click()
    assert.deepEqual(await asked(p), ["open:local"])
    await p.context().close()
  })
})
