import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, userInfo } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"

/**
 * Standard Artifacts on your own machine: the app's Worker and SPA, run by
 * Miniflare (workerd) with no Cloudflare account.
 *
 * - Solo mode: AUTH_MODE=dev, so there's no sign-in and you are the owner.
 *   It listens on 127.0.0.1 only, and the Worker refuses non-localhost hosts.
 * - Each artifact's Durable Object keeps its SQLite under the data directory
 *   (default ~/.stdartifacts), so the workspace survives restarts. One server
 *   per data directory: a lockfile there says which process and port has it.
 * - Bindings match apps/app/wrangler.jsonc: no RunnerCell, no containers.
 *   @claude mentions wait for `stdartifacts agent serve`.
 */

export const DEFAULT_PORT = 4747
export const HOST = "127.0.0.1"
const COMPATIBILITY_DATE = "2026-06-01"
const LOCK_FILE = "server.lock"

export interface ServeOptions {
  /** Default 4747. 0 picks a free port. */
  readonly port?: number | undefined
  /** Where Durable Object data lives. Default ~/.stdartifacts. */
  readonly data?: string | undefined
  /** Your display name in the workspace. Default: the OS account's name. */
  readonly name?: string | undefined
}

export interface RunningServer {
  readonly url: string
  readonly dataDir: string
  readonly name: string
  readonly close: () => Promise<void>
}

export const defaultDataDir = () => join(homedir(), ".stdartifacts")

/** dist/, next to this module once built. */
const distDir = fileURLToPath(new URL(".", import.meta.url))

/** Start the server and resolve once it answers. */
export async function serve(options: ServeOptions = {}): Promise<RunningServer> {
  const worker = join(distDir, "worker.mjs")
  const assets = join(distDir, "assets")
  if (!existsSync(worker) || !existsSync(join(assets, "index.html"))) {
    throw new Error(`The server isn't built (no ${worker}). Run: pnpm --filter @standard-artifacts/server build`)
  }
  const dataDir = resolve(options.data ?? defaultDataDir())
  mkdirSync(join(dataDir, "do"), { recursive: true })
  const port = options.port ?? DEFAULT_PORT
  const name = ownerName(options.name)

  const lock = acquireLock(dataDir)
  let mf: Miniflare | undefined
  try {
    // workerd aborts noisily on a taken port, so check first.
    if (port !== 0 && !(await portFree(port))) throw new Error(`Port ${port} is in use. Pick another with --port.`)

    const cells = { WORKSPACE: "WorkspaceCell", TABLE: "TableCell", BOARD: "BoardCell", DOC: "DocCell", TRACKER: "TrackerCell", MCP: "McpCell", OAUTH: "OAuthCell" }
    const optional = (key: string) => (process.env[key] ? { [key]: process.env[key] } : {})

    mf = new Miniflare({
      name: "standard-artifacts",
      host: HOST,
      port,
      modules: true,
      modulesRoot: distDir,
      scriptPath: worker,
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        AUTH_MODE: "dev",
        DEV_OWNER_NAME: name,
        SEARCH_PREFIX: "standard-artifacts-solo",
        // Optional services, from the environment: content search, a tunnel host.
        ...optional("TURBOPUFFER_API_KEY"),
        ...optional("TURBOPUFFER_URL"),
        ...optional("DEV_ALLOWED_HOSTS"),
      },
      durableObjects: Object.fromEntries(Object.entries(cells).map(([binding, className]) => [binding, { className, useSQLite: true }])),
      durableObjectsPersist: join(dataDir, "do"),
      assets: {
        directory: assets,
        // As wrangler.jsonc: the SPA, with the Worker first for /api/*, /mcp and OAuth discovery.
        routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false, static_routing: { user_worker: ["/api/*", "/mcp", "/mcp/*", "/.well-known/oauth-*"] } },
        assetConfig: { not_found_handling: "single-page-application", has_static_routing: true },
      },
    })
    const ready = await mf.ready
    lock.hold(Number(ready.port))
    const running = mf
    return {
      url: `http://${HOST}:${ready.port}`,
      dataDir,
      name,
      close: () => running.dispose().finally(() => lock.release()),
    }
  } catch (error) {
    await mf?.dispose().catch(() => {})
    lock.release()
    throw error
  }
}

export interface RunOptions extends ServeOptions {
  /** Open the browser once it's up. Default true. */
  readonly open?: boolean | undefined
}

/** `standard-artifacts-server`: start, print how to connect, open the browser, stop cleanly on Ctrl+C. */
export async function run(options: RunOptions = {}): Promise<RunningServer> {
  const server = await serve(options)
  console.log(banner(server))
  if (options.open !== false) openBrowser(server.url)

  let stopping = false
  const stop = () => {
    // A second Ctrl+C (or the CLI forwarding the one the terminal already sent) shouldn't cut the first short.
    if (stopping) return
    stopping = true
    void server.close().finally(() => process.exit(0))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop)
  return server
}

export function banner({ url, dataDir, name }: RunningServer): string {
  const home = homedir()
  const data = dataDir.startsWith(home) ? `~${dataDir.slice(home.length)}` : dataDir
  return [
    "",
    `  Standard Artifacts is running at ${url}`,
    `  Data: ${data}`,
    `  You're the owner, as "${name}" (change it with --name).`,
    "",
    "  Connect Claude Code over MCP:",
    `    claude mcp add stdartifacts -e STDARTIFACTS_URL=${url} -- npx stdartifacts mcp`,
    "  or over HTTP:",
    `    claude mcp add --transport http stdartifacts ${url}/mcp`,
    "",
    "  Point the CLI at it:",
    `    export STDARTIFACTS_URL=${url}`,
    "",
    "  Solo mode: no sign-in, and only this machine can reach it. Ctrl+C to stop.",
    "",
  ].join("\n")
}

/**
 * Who you are in the workspace: `--name`, else the OS account's full name
 * (cheap to ask on macOS and Linux), else the account's username, else "You".
 */
export function ownerName(explicit?: string): string {
  const clean = (s: string | undefined) => s?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined
  return clean(explicit) ?? clean(fullName()) ?? clean(username()) ?? "You"
}

function username(): string | undefined {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

function fullName(): string | undefined {
  const user = username()
  const ask = (command: string, args: Array<string>) =>
    execFileSync(command, args, { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim()
  try {
    if (process.platform === "darwin") return ask("id", ["-F"])
    // The GECOS field: "Full Name,room,phone,…".
    if (process.platform === "linux" && user) return ask("getent", ["passwd", user]).split(":")[4]?.split(",")[0]
  } catch {
    // No full name to be had cheaply; the username will do.
  }
  return undefined
}

interface LockInfo {
  readonly pid: number
  readonly port?: number
}

/**
 * One server per data directory: two workerd processes on the same SQLite
 * files would corrupt them. The lock records our pid, then the port once
 * we're listening. A lock whose process is gone is stale and gets taken over.
 */
function acquireLock(dataDir: string) {
  const path = join(dataDir, LOCK_FILE)
  const write = (info: LockInfo, flag: "wx" | "w") => writeFileSync(path, `${JSON.stringify(info)}\n`, { flag })
  for (let attempt = 0; ; attempt++) {
    try {
      write({ pid: process.pid }, "wx")
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error
      const held = readLock(path)
      if (held && held.pid !== process.pid && alive(held.pid)) {
        const where = held.port ? `on port ${held.port} (http://${HOST}:${held.port})` : "(still starting)"
        throw new Error(`Another Standard Artifacts server is already using ${dataDir}, ${where}, pid ${held.pid}. Stop it, or pass a different --data.`)
      }
      rmSync(path, { force: true })
    }
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    process.off("exit", release)
    if (readLock(path)?.pid === process.pid) rmSync(path, { force: true })
  }
  // A crash or process.exit() still lets go; a kill -9 leaves a stale lock, which the next start takes over.
  process.on("exit", release)
  return { hold: (port: number) => write({ pid: process.pid, port }, "w"), release }
}

function readLock(path: string): LockInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>
    return typeof info.pid === "number" ? { pid: info.pid, ...(typeof info.port === "number" && { port: info.port }) } : undefined
  } catch {
    return undefined
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer()
    probe.once("error", () => done(false))
    probe.listen(port, HOST, () => probe.close(() => done(true)))
  })
}

function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]]
  try {
    const child = spawn(command, args as Array<string>, { stdio: "ignore", detached: true })
    child.on("error", () => console.log(`  Open ${url} in your browser.`))
    child.unref()
  } catch {
    console.log(`  Open ${url} in your browser.`)
  }
}
