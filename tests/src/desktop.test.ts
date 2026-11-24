import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { _electron, type ElectronApplication, type Page } from "playwright-core"
import { deepLinkHref, deepLinkInArgs, destinationOf } from "../../apps/desktop/src/links.ts"
import { BASE, cleanup, create, eventually } from "./harness.ts"

/** The desktop app: a thin Electron host around the same web app. */

const until = (check: () => Promise<unknown>, timeout?: number) =>
  eventually(async () => {
    await check()
    return true
  }, timeout)

describe("links", () => {
  const origin = "https://standardartifacts.com"

  test("only the app's own origin stays in the app", () => {
    assert.equal(destinationOf("https://standardartifacts.com/docs/d_1", origin), "in-app")
    assert.equal(destinationOf("https://standardartifacts.com.evil.dev/", origin), "external")
    assert.equal(destinationOf("http://standardartifacts.com/", origin), "external")
    assert.equal(destinationOf("mailto:a@b.co", origin), "external")
  })

  test("schemes that could run something go nowhere", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "not a url"]) assert.equal(destinationOf(url, origin), "blocked")
  })

  test("a deep link names a page", () => {
    assert.equal(deepLinkHref("stdartifacts://docs/d_1"), "/docs/d_1")
    assert.equal(deepLinkHref("stdartifacts://boards/b_1/s_2?x=1#y"), "/boards/b_1/s_2?x=1#y")
    assert.equal(deepLinkHref("stdartifacts:///docs/d_1/"), "/docs/d_1")
    assert.equal(deepLinkHref("stdartifacts://"), "/")
  })

  test("a deep link can't reach the API, however it's spelled", () => {
    for (const url of [
      "stdartifacts://api/v1/share/sh.org.secret",
      "stdartifacts:///api/v1/share/sh.org.secret",
      "stdartifacts://docs/../api/v1/share/x",
      "stdartifacts://../api/v1/share/x",
      "stdartifacts://%2e%2e/api/v1/share/x",
      "stdartifacts://docs/%2e%2e/api/v1/share/x",
      "stdartifacts://API/v1/share/x",
      "stdartifacts://mcp",
    ]) {
      const href = deepLinkHref(url)
      if (href !== null) assert.doesNotMatch(new URL(href, "https://standardartifacts.com").pathname, /^\/(api|mcp)(\/|$)/i, url)
    }
    assert.equal(deepLinkHref("stdartifacts://api/v1/share/x"), null)
  })

  test("a deep link can't leave the app's origin", () => {
    for (const url of ["stdartifacts:////evil.dev/x", "stdartifacts://evil.dev//evil.dev"]) {
      const href = deepLinkHref(url)
      assert.ok(href && href.startsWith("/") && !href.startsWith("//"), url)
      assert.equal(new URL(href, origin).origin, origin)
    }
    assert.equal(deepLinkHref("https://standardartifacts.com/docs/d_1"), null)
  })

  test("a legacy commonartifacts:// link from the command line still opens its page, with the same guards", () => {
    assert.equal(deepLinkInArgs(["/Applications/App", "--flag", "commonartifacts://docs/d_1"]), "commonartifacts://docs/d_1")
    assert.equal(deepLinkHref("commonartifacts://docs/d_1"), "/docs/d_1")
    assert.equal(deepLinkHref("commonartifacts://api/v1/share/x"), null)
    assert.equal(deepLinkInArgs(["--flag", "https://standardartifacts.com/docs/d_1"]), undefined)
  })
})

// Electron needs a display, which CI's Linux runner doesn't have.
describe("app", { skip: process.platform === "linux" && !process.env.DISPLAY }, () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../apps/desktop")
  const profiles: Array<string> = []
  const running: Array<ElectronApplication> = []

  async function launch(url = BASE) {
    const profile = mkdtempSync(join(tmpdir(), "standard-artifacts-desktop-"))
    profiles.push(profile)
    const app = await _electron.launch({
      executablePath: createRequire(join(root, "package.json"))("electron") as unknown as string,
      args: [root, `--user-data-dir=${profile}`],
      env: { ...process.env, STDARTIFACTS_DESKTOP_URL: url } as Record<string, string>,
    })
    running.push(app)
    // Links handed to the OS land here instead of opening the person's browser.
    await app.evaluate(({ shell }) => {
      const opened: Array<string> = []
      ;(globalThis as { opened?: Array<string> }).opened = opened
      shell.openExternal = async (url) => void opened.push(url)
    })
    return { app, page: await app.firstWindow() }
  }

  const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { opened: Array<string> }).opened)
  const menu = (app: ElectronApplication, label: string) =>
    app.evaluate(({ BrowserWindow, Menu }, label) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (item.label === label) return item
          const inner = item.submenu && find(item.submenu.items)
          if (inner) return inner
        }
        return undefined
      }
      find(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0])
    }, label)
  const deepLink = (app: ElectronApplication, url: string) =>
    app.evaluate(({ app }, url) => void app.emit("open-url", { preventDefault() {} }, url), url)
  const tabCount = (page: Page) => page.locator('[data-tab-strip] [role="tab"]').count()
  const tabsReady = (page: Page) => page.locator('[data-tab-strip] [role="tab"]').first().waitFor()

  after(async () => {
    await Promise.all(running.map((app) => app.close().catch(() => {})))
    for (const profile of profiles) rmSync(profile, { recursive: true, force: true })
    await cleanup()
  })

  describe("in a window", () => {
    let app: ElectronApplication
    let page: Page
    before(async () => {
      ;({ app, page } = await launch())
      await tabsReady(page)
    })

    test("loads the web app, with nothing of the OS reachable from the page", async () => {
      assert.equal(new URL(page.url()).origin, new URL(BASE).origin)
      const exposed = await page.evaluate(() => ({
        bridge: Object.keys((window as unknown as { standardArtifactsDesktop: object }).standardArtifactsDesktop).sort(),
        desktop: document.documentElement.dataset.desktop,
        node: typeof (window as unknown as { require?: unknown }).require + typeof (window as unknown as { process?: unknown }).process,
      }))
      assert.deepEqual(exposed.bridge, ["onCommand", "platform"])
      assert.equal(exposed.desktop, process.platform)
      assert.equal(exposed.node, "undefinedundefined")
    })

    test("the menu drives the page's tabs", async () => {
      const doc = await create("doc", `Menu ${Date.now()}`)
      const path = () => new URL(page.url()).pathname
      const start = await tabCount(page)
      await deepLink(app, `stdartifacts://docs/${doc.id}`)
      await until(async () => assert.equal(await tabCount(page), start + 1))

      await menu(app, "Tab 1")
      await until(async () => assert.equal(path(), "/"))
      await menu(app, "Last Tab")
      await until(async () => assert.equal(path(), `/docs/${doc.id}`))
      await menu(app, "Next Tab")
      await until(async () => assert.equal(path(), "/"))
      await menu(app, "Previous Tab")
      await until(async () => assert.equal(path(), `/docs/${doc.id}`))
      await menu(app, "New Tab")
      await until(async () => assert.equal(path(), "/"))
      await menu(app, "Last Tab")
      await until(async () => assert.equal(path(), `/docs/${doc.id}`))
      await menu(app, "Close Tab")
      await until(async () => assert.equal(await tabCount(page), start))
    })

    test("a deep link opens a tab without reloading the page", async () => {
      const doc = await create("doc", `Deep link ${Date.now()}`)
      await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true))
      const start = await tabCount(page)
      await deepLink(app, `stdartifacts://docs/${doc.id}`)
      await until(async () => assert.equal(new URL(page.url()).pathname, `/docs/${doc.id}`))
      assert.equal(await tabCount(page), start + 1)
      assert.equal(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept), true)
    })

    test("a deep link to the API does nothing", async () => {
      const before = page.url()
      await deepLink(app, "stdartifacts://api/v1/share/sh.org.secret")
      await page.waitForTimeout(300)
      assert.equal(page.url(), before)
    })

    test("links to other sites go to the browser, including ones opened as windows", async () => {
      await page.evaluate(() => {
        window.open("https://example.com/popup", "_blank", "noopener")
        window.location.href = "https://example.com/navigate"
      })
      await until(async () => assert.deepEqual((await opened(app)).sort(), ["https://example.com/navigate", "https://example.com/popup"]))
      assert.equal(new URL(page.url()).origin, new URL(BASE).origin)
      assert.equal(app.windows().length, 1)
    })

    test("the page gets the clipboard and no other permissions", async () => {
      await app.evaluate(({ BrowserWindow, clipboard }) => {
        clipboard.writeText("from the OS")
        BrowserWindow.getAllWindows()[0]!.focus()
      })
      await page.bringToFront()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "from the OS")
      const denied = await page.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state)
      assert.notEqual(denied, "granted")
    })

    test("a sandboxed HTML embed gets no bridge", async () => {
      const framed = await page.evaluate(
        () =>
          new Promise<string>((resolve) => {
            const frame = document.createElement("iframe")
            frame.setAttribute("sandbox", "allow-scripts")
            frame.srcdoc = `<script>parent.postMessage(typeof window.standardArtifactsDesktop, "*")</script>`
            addEventListener("message", (e) => (frame.remove(), resolve(String(e.data))), { once: true })
            document.body.append(frame)
          }),
      )
      assert.equal(framed, "undefined")
    })

    test("closing the last tab closes the window", async () => {
      await until(async () => {
        const count = await tabCount(page)
        if (count > 1) await menu(app, "Close Tab")
        assert.equal(await tabCount(page), 1)
      })
      const closed = page.waitForEvent("close")
      await menu(app, "Close Tab")
      await closed
    })
  })

  test("a server that never answers still gets a window, then the waiting page", async () => {
    const sockets = new Set<import("node:net").Socket>()
    const silent = createTcpServer((socket) => void sockets.add(socket))
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve))
    const { port } = silent.address() as { port: number }
    const { app, page } = await launch(`http://127.0.0.1:${port}`)
    try {
      await until(async () => assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()), true), 3_000)
      await page.getByRole("heading", { name: "Can't connect" }).waitFor({ timeout: 15_000 })
    } finally {
      await app.close()
      for (const socket of sockets) socket.destroy()
      silent.close()
    }
  })

  test("waits on a page of its own while the server is away, then comes back", async () => {
    const server: Server = createServer((_, res) => res.setHeader("content-type", "text/html").end("<title>Back</title>"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as { port: number }
    await new Promise((resolve) => server.close(resolve))

    const { app, page } = await launch(`http://127.0.0.1:${port}`)
    await page.getByRole("heading", { name: "Can't connect" }).waitFor()
    assert.equal(new URL(page.url()).protocol, "data:")

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
    try {
      await until(async () => assert.equal(await page.title(), "Back"), 10_000)
      assert.equal(new URL(page.url()).origin, `http://127.0.0.1:${port}`)
    } finally {
      await app.close()
      server.closeAllConnections()
      server.close()
    }
  })
})
