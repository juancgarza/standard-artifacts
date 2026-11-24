import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join } from "node:path"
import { after, before, describe, test } from "node:test"
import type { Browser, BrowserContext, Page } from "playwright-core"
import { eventually, launch } from "./harness.ts"

/**
 * The landing page's production build, served as plain static files. It doesn't
 * talk to the app, so unlike the other suites it needs no worker running.
 */

const APP = join(import.meta.dirname, "../../apps/landing")
const DIST = join(APP, "dist")
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".webp": "image/webp", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" }
const WIDTHS = [375, 768, 1024, 1440, 1920]
const THEMES = ["light", "dark"] as const

let browser: Browser
let server: Server
let url: string

before(async () => {
  execFileSync("pnpm", ["--filter", "@standard-artifacts/landing", "build"], { stdio: "pipe" })
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname
    const file = path === "/" ? "/index.html" : path
    try {
      const body = await readFile(join(DIST, file))
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((done) => server.listen(0, done))
  url = `http://localhost:${(server.address() as AddressInfo).port}/`
  browser = await launch()
})
after(async () => {
  await browser?.close()
  server?.close()
})

/** A fresh visitor's page, recording anything that went wrong and every URL it asked for. */
async function visit(options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })
  const page = await context.newPage()
  const problems: Array<string> = []
  const requests: Array<string> = []
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text())
  })
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("requestfailed", (r) => problems.push(`failed: ${r.url()}`))
  page.on("request", (r) => requests.push(r.url()))
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`)
  })
  await page.goto(url, { waitUntil: "load" })
  return { context, page, problems, requests }
}

/** Scrolls the whole page so lazy images load, then checks every image on show has loaded. */
async function scrollAll(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  const step = Math.round((page.viewportSize()?.height ?? 800) * 0.8)
  for (let y = 0; y < height; y += step) {
    await page.evaluate((top) => scrollTo({ top, behavior: "instant" }), y)
    await page.waitForTimeout(60)
  }
  await eventually(
    () => page.evaluate(() => [...document.images].filter((i) => i.getBoundingClientRect().width > 0).every((i) => i.complete && i.naturalWidth > 0)),
    15000,
  )
}

const close = (context: BrowserContext) => context.close()

describe("landing page", () => {
  for (const width of WIDTHS) {
    test(`${width}px wide, both themes: nothing broken, no sideways scroll, every image loads`, async () => {
      for (const colorScheme of THEMES) {
        const { context, page, problems, requests } = await visit({ viewport: { width, height: 900 }, colorScheme })
        await scrollAll(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
        assert.ok(scrollWidth <= clientWidth, `${colorScheme}: scrollWidth ${scrollWidth} > ${clientWidth}`)
        assert.deepEqual(problems, [], colorScheme)
        const outside = requests.filter((r) => !r.startsWith(url) && !r.startsWith("data:"))
        assert.deepEqual(outside, [], "no third-party requests")
        await close(context)
      }
    })
  }

  test("follows the system, keeps a choice across reloads, and loads only one hour of images", async () => {
    const { context, page, requests } = await visit({ colorScheme: "dark" })
    const painted = () => page.evaluate(() => getComputedStyle(document.querySelector(".scene .dusk")!).display)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined)
    assert.equal(await painted(), "block")
    assert.equal(await page.getByRole("button", { name: "Dusk" }).getAttribute("aria-pressed"), "true")
    assert.ok(requests.some((r) => /scene-dusk-\d+\.webp/.test(r)), "the dusk hero loads")
    assert.ok(!requests.some((r) => /-day-\d+\.webp/.test(r)), `no day images: ${requests.filter((r) => /-day-/.test(r))}`)
    const preloads = await page.evaluate(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="image"]')].map((l) => l.imageSrcset))
    assert.equal(preloads.length, 1)
    assert.match(preloads[0]!, /scene-dusk/)

    await page.getByRole("button", { name: "Day" }).click()
    await eventually(() => page.evaluate(() => document.documentElement.dataset.theme === "light"))
    assert.ok(requests.some((r) => /scene-day-\d+\.webp/.test(r)), "switching fetches the day hero")
    await eventually(() => page.evaluate(() => !("both" in document.documentElement.dataset)))
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".scene .dusk")!).display), "none")

    // A saved choice beats the system, from the first paint: the head script sets it before the body parses.
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if (document.body && !("firstTheme" in window)) (window as unknown as { firstTheme?: string }).firstTheme = document.documentElement.dataset.theme
      }).observe(document, { childList: true, subtree: true })
    })
    await page.reload()
    assert.equal(await page.evaluate(() => (window as unknown as { firstTheme?: string }).firstTheme), "light")
    assert.equal(await page.getByRole("button", { name: "Day" }).getAttribute("aria-pressed"), "true")
    await close(context)
  })

  test("crossfades between the hours, and follows the system when nothing is saved", async () => {
    const { context, page } = await visit({ colorScheme: "light" })
    const opacities = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('[data-theme-set="dark"]')!.click()
      const dusk = document.querySelector(".scene .dusk")!
      const seen: Array<number> = []
      const start = performance.now()
      while (performance.now() - start < 1600) {
        seen.push(+getComputedStyle(dusk).opacity)
        await new Promise(requestAnimationFrame)
      }
      return seen
    })
    assert.ok(opacities.some((o) => o > 0.05 && o < 0.95), `a partial frame: ${opacities.slice(0, 30)}`)
    assert.equal(opacities.at(-1), 1)
    await close(context)

    const fresh = await visit({ colorScheme: "light" })
    await fresh.page.emulateMedia({ colorScheme: "dark" })
    await eventually(async () => (await fresh.page.getByRole("button", { name: "Dusk" }).getAttribute("aria-pressed")) === "true")
    assert.deepEqual(fresh.problems, [])
    await close(fresh.context)
  })

  test("storage being blocked doesn't break the theme", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("blocked")
        },
      })
    })
    const page = await context.newPage()
    const errors: Array<string> = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(url)
    await page.getByRole("button", { name: "Dusk" }).click()
    await eventually(() => page.evaluate(() => document.documentElement.dataset.theme === "dark"))
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("hero tabs: click, arrow keys, Home and End, one tab stop", async () => {
    const { context, page } = await visit()
    const selected = () => page.locator('.tabs [aria-selected="true"]').innerText()
    const shown = () => page.evaluate(() => [...document.querySelectorAll(".shot-panel")].filter((p) => (p as HTMLElement).offsetParent).map((p) => p.id))
    assert.deepEqual(await shown(), ["panel-tracker"])
    await page.getByRole("tab", { name: "Tables" }).click()
    assert.equal(await selected(), "Tables")
    assert.deepEqual(await shown(), ["panel-table"])
    await page.keyboard.press("ArrowRight")
    assert.equal(await selected(), "Boards")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    assert.equal(await selected(), "Trackers")
    await page.keyboard.press("ArrowLeft")
    assert.equal(await selected(), "Docs", "wraps around")
    await page.keyboard.press("Home")
    assert.equal(await selected(), "Trackers")
    await page.keyboard.press("End")
    assert.equal(await selected(), "Docs")
    assert.deepEqual(await page.locator('.tabs [role="tab"]').evaluateAll((tabs) => tabs.map((t) => (t as HTMLElement).tabIndex)), [-1, -1, -1, 0])
    assert.equal(await page.locator("#panel-doc").getAttribute("aria-labelledby"), "tab-doc")
    await close(context)
  })

  test("recorder: a run stops for review, Approve and Reject each keep the record", async () => {
    const { context, page } = await visit()
    const recorder = page.locator("#rr")
    await recorder.scrollIntoViewIfNeeded()
    await recorder.hover() // Hovering stops the page deciding for itself.
    const readout = recorder.locator("[data-readout]")
    await recorder.getByRole("button", { name: "Approve" }).waitFor({ timeout: 20000 })
    assert.match(await readout.innerText(), /Step 5|Needs review/)
    await recorder.getByRole("button", { name: "Approve" }).click()
    await eventually(async () => /Approved · done · 5 steps kept/.test(await readout.innerText()), 4000)
    assert.match((await recorder.locator("[data-status]").textContent())!, /Approved\. The run and its 5 steps stay on the record\./)
    await recorder.getByRole("button", { name: "Reject" }).waitFor({ timeout: 20000 })
    await recorder.getByRole("button", { name: "Reject" }).click()
    await eventually(async () => /Rejected · failed · 5 steps kept/.test(await readout.innerText()), 4000)
    await close(context)
  })

  test("Copy really copies, and selects the text when the clipboard says no", async () => {
    const { context, page } = await visit()
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url })
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText())

    // The hero's call to action: the command to run.
    await page.locator(".hero .cmd .copy").click()
    await eventually(async () => (await clipboard()) === "npx stdartifacts serve")
    assert.equal(await page.locator("[data-copy-status]").textContent(), "Copied to the clipboard.")

    const pane = page.locator(".pane[data-active]")
    await pane.locator(".copy").click()
    await eventually(async () => (await pane.locator(".copy").innerText()) === "Copied")
    assert.equal(await clipboard(), "claude mcp add stdartifacts -e STDARTIFACTS_URL=http://localhost:4747 -- npx stdartifacts mcp")

    await page.getByRole("tab", { name: "Codex" }).click()
    assert.equal(await page.locator(".pane[data-active]").getAttribute("id"), "pane-codex")
    await page.keyboard.press("ArrowRight")
    assert.equal(await page.locator(".pane[data-active]").getAttribute("id"), "pane-chatgpt")
    assert.equal(await page.locator(".pane[data-active] .copy").count(), 0, "nothing to copy until Cloud")
    await page.keyboard.press("ArrowLeft")
    await page.locator(".pane[data-active] .copy").click()
    await eventually(async () => /^\[mcp_servers\.stdartifacts\]\ncommand = "npx"/.test(await clipboard()))

    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("denied"))
    })
    await page.locator(".pane[data-active] .copy").click()
    await eventually(async () => (await page.locator(".pane[data-active] .copy").innerText()) === "Selected")
    assert.match(await page.evaluate(() => String(getSelection())), /mcp_servers\.stdartifacts/)
    await close(context)
  })

  test("FAQ: one answer open at a time", async () => {
    const { context, page } = await visit()
    const open = () => page.locator(".qs details[open] summary").allInnerTexts()
    assert.deepEqual(await open(), ["Is it really free?"])
    await page.locator(".qs summary", { hasText: "Which agents can connect?" }).click()
    assert.deepEqual(await open(), ["Which agents can connect?"])
    assert.match(await page.locator(".qs details[open] p").innerText(), /Other MCP clients that run a command over stdio connect the same way\./)
    await close(context)
  })

  test("keyboard alone: skip link, visible focus, nav, and every control reachable", async () => {
    const { context, page } = await visit()
    await page.keyboard.press("Tab")
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Skip to content")
    const box = (await page.locator(".skip").boundingBox())!
    assert.ok(box.y >= 0, "the skip link comes into view")

    const seen = new Set<string>()
    for (let i = 0; i < 90; i++) {
      await page.keyboard.press("Tab")
      const focus = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement
        const style = getComputedStyle(el)
        return { name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(), tag: el.tagName, outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 }
      })
      if (focus.tag === "BODY") break
      assert.ok(focus.outline, `no visible focus on ${focus.tag} "${focus.name}"`)
      seen.add(focus.name)
    }
    for (const name of ["Overview", "Runs", "Tables", "Day", "Dusk", "Trackers", "Copy npx stdartifacts serve", "Connect your agent →", "GitHub", "Claude Code", "Copy", "View on GitHub", "Join the waitlist", "Is it really free?", "View Markdown"]) {
      assert.ok(seen.has(name), `can't reach "${name}" (reached: ${[...seen].join(", ")})`)
    }
    await close(context)
  })

  test("small screens: the menu opens, closes on Escape and on a link, and links go to real anchors", async () => {
    const { context, page } = await visit({ viewport: { width: 375, height: 812 } })
    const menu = page.getByRole("button", { name: "Menu" })
    const links = page.locator("#site-nav a")
    assert.equal(await links.first().isVisible(), false)
    await menu.click()
    assert.equal(await menu.getAttribute("aria-expanded"), "true")
    assert.equal(await links.first().isVisible(), true)
    await page.keyboard.press("Escape")
    assert.equal(await links.first().isVisible(), false)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Menu")
    await menu.click()
    await page.locator("#site-nav").getByRole("link", { name: "Solo or Cloud" }).click()
    assert.equal(await links.first().isVisible(), false)
    await eventually(async () => (await page.locator("#plans").boundingBox())!.y < 200, 4000)

    const dead = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>("a[href^='#']")]
        .map((a) => a.getAttribute("href")!)
        .filter((href) => href === "#" || !document.querySelector(href)),
    )
    assert.deepEqual(dead, [])
    await close(context)
  })

  test("Markdown view swaps the page for plain text and back", async () => {
    const { context, page } = await visit()
    const md = page.locator("#markdown")
    assert.equal(await md.isVisible(), false)
    await page.getByRole("button", { name: "View Markdown" }).click()
    assert.equal(await md.isVisible(), true)
    assert.equal(await page.locator("h1").isVisible(), false)
    const text = await md.innerText()
    for (const want of [
      "# Standard Artifacts",
      "Open-source artifacts that you and your agents work on together.",
      "    npx stdartifacts serve",
      "## Connect your agent",
      "claude mcp add stdartifacts -e STDARTIFACTS_URL=http://localhost:4747 -- npx stdartifacts mcp",
      "## Solo or Cloud",
      "## Before you connect anything",
      "https://github.com/juancgarza/standard-artifacts",
      "ChatGPT is a trademark of OpenAI. Claude is a trademark of Anthropic.",
    ]) {
      assert.ok(text.includes(want), want)
    }
    assert.ok(!/draft|placeholder|%[A-Z_]+%/i.test(text), "no draft wording or unfilled values")
    await page.getByRole("button", { name: "Page", exact: true }).click()
    assert.equal(await page.locator("h1").isVisible(), true)
    // A nav link has to work from the Markdown view too.
    await page.getByRole("button", { name: "View Markdown" }).click()
    await page.locator("#site-nav").getByRole("link", { name: "Solo or Cloud" }).click()
    assert.equal(await md.isVisible(), false)
    await page.locator("#plans").waitFor()
    await close(context)
  })

  test("with JavaScript off, the page still renders in full", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 812 }, colorScheme: "dark" })
    const page = await context.newPage()
    const failed: Array<string> = []
    page.on("response", (r) => {
      if (r.status() >= 400) failed.push(r.url())
    })
    await page.goto(url, { waitUntil: "load" })
    for (const text of ["Open-source artifacts that you", "npx stdartifacts serve", "Four surfaces, one record", "Nothing happens off the tape", "Connect your agent", "STDARTIFACTS_URL", "Solo or Cloud", "Before you connect anything", "The chat ends."]) {
      assert.equal(await page.locator(".content").getByText(text).first().isVisible(), true, text)
    }
    // Controls that need script are gone, not dead; the nav is simply open.
    assert.equal(await page.getByRole("button", { name: "Dusk" }).count(), 0)
    assert.equal(await page.getByRole("tab").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Copy" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Approve" }).count(), 0)
    assert.equal(await page.locator("#site-nav").getByRole("link", { name: "Solo or Cloud" }).isVisible(), true)
    // Details still work; the sky is the dusk one because the system says so.
    assert.equal(await page.locator(".scene .dusk img").isVisible(), true)
    assert.equal(await page.locator(".scene .day img").isVisible(), false)
    assert.deepEqual(failed, [])
    await context.close()
  })

  test("reduced motion: nothing crossfades, and the recorder shows a finished run", async () => {
    const { context, page } = await visit({ reducedMotion: "reduce" })
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".scene .day")!).transitionDuration), "0s")
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), "auto")
    const recorder = page.locator("#rr")
    await recorder.scrollIntoViewIfNeeded()
    await recorder.getByRole("button", { name: "Approve" }).waitFor({ timeout: 5000 })
    assert.match(await recorder.locator("[data-readout]").innerText(), /Needs review · 5 steps/)
    assert.ok(await page.evaluate(() => [...document.querySelectorAll(".iso-line[data-flow], .iso-dots circle[data-pulse]")].every((el) => getComputedStyle(el).animationName === "none")))
    await recorder.getByRole("button", { name: "Approve" }).click()
    await eventually(async () => /Approved · done/.test(await recorder.locator("[data-readout]").innerText()), 2000)
    await close(context)
  })

  test("the wordmark fits at every width, whatever font it falls back to", async () => {
    for (const fallback of ["Times New Roman", "Courier New", "Impact"]) {
      for (const width of [320, 768, 1920]) {
        const { context, page } = await visit({ viewport: { width, height: 800 } })
        await page.addStyleTag({ content: `.word{font-family:"${fallback}"}` })
        const fit = await page.evaluate(() => {
          const svg = document.querySelector<SVGSVGElement>(".word")!
          const text = svg.querySelector("text")!.getBoundingClientRect()
          const foot = document.querySelector(".foot")!.getBoundingClientRect()
          return { left: text.left - foot.left, right: foot.right - text.right, hidden: svg.getAttribute("aria-hidden") }
        })
        assert.ok(fit.left >= 0 && fit.right >= 0, `${fallback} at ${width}: ${JSON.stringify(fit)}`)
        assert.equal(fit.hidden, "true")
        await close(context)
      }
    }
  })

  test("metadata, and the fake or dead things are gone", async () => {
    const html = await readFile(join(DIST, "index.html"), "utf8")
    for (const want of [
      'rel="canonical" href="https://standardartifacts.com/"',
      'property="og:image" content="https://standardartifacts.com/og.jpg"',
      'property="og:site_name" content="Standard Artifacts"',
      'name="twitter:card"',
      'name="description"',
      'href="https://github.com/juancgarza/standard-artifacts"',
      'href="mailto:cloud@standardartifacts.com',
      "ChatGPT is a trademark of OpenAI. Claude is a trademark of Anthropic. Standard Artifacts isn't affiliated with or endorsed by either.",
    ]) {
      assert.ok(html.includes(want), want)
    }
    assert.ok(!/common.?artifacts|AH_TOKEN/i.test(html), "no old name")
    assert.ok(!/All systems normal|Draft v7|API reference|Works with any MCP client|>Privacy<|>Terms<|href="#"/.test(html), "removed prototype copy")
    assert.ok(!/%[A-Z_]+%/.test(html), "no unfilled values")
    for (const file of ["robots.txt", "sitemap.xml", "og.jpg", "favicon-32.png", "apple-touch-icon.png", "index.md", "THIRD_PARTY_NOTICES.txt"]) {
      assert.ok((await readFile(join(DIST, file))).length > 0, file)
    }
    assert.match(await readFile(join(DIST, "THIRD_PARTY_NOTICES.txt"), "utf8"), /MIT License/)
  })
})
