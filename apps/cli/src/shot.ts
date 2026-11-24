import { Effect } from "effect"
import { StandardArtifactsError, StandardArtifactsClient, pngSize } from "@standard-artifacts/client"
import { maxImageBytes } from "@standard-artifacts/protocol"

/**
 * `stdartifacts shot`: drive a page with Playwright and stream screenshots onto a board
 * as a captioned timeline, so people and agents can review a flow visually.
 *
 * Steps (run in order; a screenshot is taken at each `shot`):
 *   click:<selector>   dblclick:<selector>   hover:<selector>
 *   fill:<selector>=<text>   type:<text>   press:<key>
 *   goto:<url|/path>   wait:<ms|selector>   shot[:caption]
 * Selectors are Playwright selectors: text=Kanban, role=tab[name="Kanban"], css.
 */

type Step = { readonly kind: string; readonly arg: string }

const parse = (raw: string): Step => {
  const at = raw.indexOf(":")
  return at < 0 ? { kind: raw, arg: "" } : { kind: raw.slice(0, at), arg: raw.slice(at + 1) }
}

const describe = (s: Step) => (s.kind === "shot" ? "" : `${s.kind} ${s.arg}`.trim())

export const shot = (options: {
  readonly board: string
  readonly url: string
  readonly steps: ReadonlyArray<string>
  /** Dev: capture as a viewer or guest (sets the app's "View as" before load). */
  readonly as: "owner" | "viewer" | "guest"
  readonly width: number
  readonly height: number
  readonly title: string | undefined
}) =>
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    const board = yield* client.resolve(options.board, "board")
    const steps = options.steps.map(parse)
    if (!steps.some((s) => s.kind === "shot")) steps.push({ kind: "shot", arg: "" })
    const shots = steps.filter((s) => s.kind === "shot").length
    const runId = `shot-${Date.now().toString(36)}`
    const scale = 560 / options.width
    const size = { w: 560, h: Math.round(options.height * scale) }
    const start = new URL(options.url)
    const title =
      options.title ?? `${start.pathname}${options.as !== "owner" ? ` as ${options.as}` : ""} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`

    const timeline = yield* client.board.timeline(board.id, title, shots, size)
    const { chromium } = yield* Effect.tryPromise({
      try: () => import("playwright-core"),
      catch: () => new StandardArtifactsError({ message: "playwright-core is not installed" }),
    })
    const browser = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          process.env.STDARTIFACTS_CHROME
            ? chromium.launch({ executablePath: process.env.STDARTIFACTS_CHROME, headless: true })
            : chromium.launch({ channel: "chrome", headless: true }),
        catch: (e) => new StandardArtifactsError({ message: `Could not start Chrome (set STDARTIFACTS_CHROME to a Chromium path): ${String(e)}` }),
      }),
      (b) => Effect.promise(() => b.close()),
    )
    const page = yield* Effect.promise(() => browser.newPage({ viewport: { width: options.width, height: options.height } }))
    if (options.as !== "owner") yield* Effect.promise(() => page.addInitScript((who) => sessionStorage.setItem("standard-artifacts:dev-as", who), options.as))
    const problems: Array<string> = []
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`))
    // Format console errors from their arguments: text() keeps raw "%o %s" placeholders.
    page.on("console", (m) => {
      if (m.type() !== "error") return
      void Promise.all(m.args().map((a) => a.jsonValue().then((v) => (typeof v === "string" ? v : JSON.stringify(v)), () => a.toString())))
        .then((parts) => problems.push(`console: ${(parts.join(" ") || m.text()).slice(0, 200)}`))
    })
    page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()} ${new URL(r.url()).pathname}`))

    const presence = (status: string) => client.presence(board.id, runId, { thinking: true, status, cursor: timeline.next() }, 30).pipe(Effect.ignore)
    const act = (s: Step) =>
      Effect.tryPromise({
        try: async () => {
          switch (s.kind) {
            case "goto":
              return void (await page.goto(new URL(s.arg, start).toString(), { waitUntil: "networkidle" }))
            case "click":
              return void (await page.click(s.arg))
            case "dblclick":
              return void (await page.dblclick(s.arg))
            case "hover":
              return void (await page.hover(s.arg))
            case "fill": {
              const eq = s.arg.indexOf("=")
              return void (await page.fill(s.arg.slice(0, eq), s.arg.slice(eq + 1)))
            }
            case "type":
              return void (await page.keyboard.type(s.arg))
            case "press":
              return void (await page.keyboard.press(s.arg))
            case "wait":
              return void (/^\d+$/.test(s.arg) ? await page.waitForTimeout(Number(s.arg)) : await page.waitForSelector(s.arg))
            default:
              throw new Error(`Unknown step "${s.kind}"`)
          }
        },
        catch: (e) => new StandardArtifactsError({ message: `Step "${s.kind}:${s.arg}" failed: ${String(e).split("\n")[0]}` }),
      })

    yield* presence(`Opening ${start.pathname}`)
    yield* act({ kind: "goto", arg: options.url })
    let n = 0
    let last = "Loaded"
    const added: Array<string> = []
    for (const s of steps) {
      if (s.kind !== "shot") {
        yield* presence(`Step: ${describe(s)}`)
        yield* act(s)
        last = describe(s)
        continue
      }
      n++
      yield* presence(`Capturing ${n}/${shots}`)
      yield* Effect.promise(() => page.waitForTimeout(400))
      let bytes = new Uint8Array(yield* Effect.promise(() => page.screenshot({ type: "png" })))
      let mime = "image/png"
      if (bytes.byteLength > maxImageBytes) {
        bytes = new Uint8Array(yield* Effect.promise(() => page.screenshot({ type: "jpeg", quality: 80 })))
        mime = "image/jpeg"
      }
      const px = pngSize(bytes) ?? { w: options.width, h: options.height }
      const caption = `${n}. ${s.arg || last}`
      const shape = yield* timeline.append({ bytes, mime, caption, w: size.w, h: Math.round(px.h * (size.w / px.w)) })
      added.push(`${shape.id}  ${caption}`)
      last = "Then"
    }

    if (problems.length) {
      const unique = [...new Set(problems)].slice(0, 8)
      yield* client.board.add(board.id, [
        {
          text: `⚠️ ${problems.length} issue${problems.length === 1 ? "" : "s"} during this run:\n${unique.join("\n")}`,
          color: "pink",
          x: timeline.frame.x + timeline.frame.w + 40,
          y: timeline.frame.y,
          w: 320,
          h: 60 + unique.length * 22,
        },
      ])
    }
    yield* client.presence(board.id, runId, { status: `Captured ${shots} screenshot${shots === 1 ? "" : "s"}` }, 10).pipe(Effect.ignore)
    return { board, frame: timeline.frame, added, problems }
  }).pipe(Effect.scoped)
