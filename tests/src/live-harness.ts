import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { FAKE_API_KEY, FAKE_CLIENT_ID, startFakeWorkOS, type FakeWorkOS } from "./fake-workos.ts"

/**
 * The app in live mode, with sign-in, against a fake WorkOS. It runs the same
 * Worker bundle and web build as `stdartifacts serve` (packages/server/dist,
 * which `pnpm test` builds first) in Miniflare, on its own port, with its own
 * in-memory Durable Objects: nothing touches the dev server the other suites use.
 */

const dist = fileURLToPath(new URL("../../packages/server/dist/", import.meta.url))
export const TICKET_SECRET = "live-test-ticket-secret-0123456789"
export const COOKIE_PASSWORD = "live-test-cookie-password-0123456789abcdef"

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer()
    s.once("error", fail)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number }
      s.close(() => done(port))
    })
  })

export interface LiveApp {
  readonly base: string
  readonly fake: FakeWorkOS
  close(): Promise<void>
}

/** Start the Worker in live mode. `bindings` override or remove (undefined) the defaults, e.g. to leave sign-in unconfigured. */
export async function startLive(bindings: Record<string, string | undefined> = {}): Promise<LiveApp> {
  if (!existsSync(`${dist}worker.mjs`)) throw new Error("packages/server isn't built: run pnpm --filter @standard-artifacts/server build")
  const fake = await startFakeWorkOS()
  const port = await freePort()
  const all: Record<string, string | undefined> = {
    AUTH_MODE: "live",
    TICKET_SECRET,
    WORKOS_API_KEY: FAKE_API_KEY,
    WORKOS_CLIENT_ID: FAKE_CLIENT_ID,
    WORKOS_COOKIE_PASSWORD: COOKIE_PASSWORD,
    WORKOS_API_URL: fake.url,
    SEARCH_PREFIX: "standard-artifacts-live-test",
    ...bindings,
  }
  const cells = { WORKSPACE: "WorkspaceCell", TABLE: "TableCell", BOARD: "BoardCell", DOC: "DocCell", TRACKER: "TrackerCell", MCP: "McpCell" }
  const mf = new Miniflare({
    name: "standard-artifacts-live-test",
    host: "127.0.0.1",
    port,
    modules: true,
    modulesRoot: dist,
    scriptPath: `${dist}worker.mjs`,
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined)),
    durableObjects: Object.fromEntries(Object.entries(cells).map(([binding, className]) => [binding, { className, useSQLite: true }])),
    assets: {
      directory: `${dist}assets`,
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false, static_routing: { user_worker: ["/api/*", "/mcp"] } },
      assetConfig: { not_found_handling: "single-page-application", has_static_routing: true },
    },
  })
  const ready = await mf.ready
  return {
    base: `http://127.0.0.1:${ready.port}`,
    fake,
    close: async () => {
      await mf.dispose()
      await fake.close()
    },
  }
}

/** A browser stand-in: keeps cookies, follows nothing on its own, and can sign in through the fake AuthKit. */
export class Visitor {
  readonly cookies = new Map<string, string>()
  ticket: string | undefined

  readonly app: LiveApp
  readonly email: string

  constructor(app: LiveApp, email: string) {
    this.app = app
    this.email = email
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.app.base}${path}`
    const headers = new Headers(init.headers)
    if (url.startsWith(this.app.base) && this.cookies.size) headers.set("cookie", this.cookieHeader())
    const res = await fetch(url, { ...init, headers, redirect: "manual" })
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";")
      const eq = pair!.indexOf("=")
      const name = pair!.slice(0, eq).trim()
      const value = pair!.slice(eq + 1).trim()
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "") this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return res
  }

  /** Through /api/auth/login → the fake AuthKit → /api/auth/callback. Returns where it landed. */
  async signIn(options: { invitationToken?: string; returnTo?: string } = {}): Promise<string> {
    this.app.fake.signInAs(this.email)
    const q = new URLSearchParams()
    if (options.invitationToken) q.set("invitation_token", options.invitationToken)
    if (options.returnTo) q.set("return_to", options.returnTo)
    const login = await this.fetch(`/api/auth/login?${q}`)
    if (login.status !== 302) throw new Error(`login: ${login.status} ${await login.text()}`)
    const hosted = await this.fetch(login.headers.get("location")!)
    if (hosted.status !== 302) throw new Error(`authorize: ${hosted.status} ${await hosted.text()}`)
    const callback = await this.fetch(hosted.headers.get("location")!)
    if (callback.status !== 302) throw new Error(`callback: ${callback.status} ${await callback.text()}`)
    return callback.headers.get("location")!
  }

  /** POST /api/auth/ticket; remembers the ticket for `api`. */
  async session(): Promise<{ status: number; body: any }> {
    const res = await this.fetch("/api/auth/ticket", { method: "POST", headers: { origin: this.app.base } })
    const body = await res.json()
    if (body?.signedIn) this.ticket = body.ticket
    return { status: res.status, body }
  }

  /** The HttpApi with the current ticket as a bearer token (and no cookies, like the web app's API calls). */
  async api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.app.base}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.ticket && { authorization: `Bearer ${this.ticket}` }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  async post(path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await this.fetch(path, {
      method: "POST",
      headers: { origin: this.app.base, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
}

/** Call the HttpApi with an arbitrary bearer (a token, a forged ticket). */
export async function bearer<T = any>(app: LiveApp, token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}
