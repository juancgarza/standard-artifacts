import * as Alchemy from "alchemy"
import * as Command from "alchemy/Command"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

/**
 * One Worker serves the SPA (Vite build output) and /api/*, with a Durable
 * Object namespace per cell type. The Worker is a plain async module, so the
 * same code also runs on celld (see wrangler.jsonc). Binding names must match
 * `Env` in src/worker/env.ts.
 *
 *   alchemy dev     Worker + cells in local workerd on :1337, plus Vite HMR on
 *                   :5173 proxying /api (and room sockets) to it. No cloud calls.
 *   alchemy deploy  builds the SPA and the agent runner's image, and deploys both
 *                   to Cloudflare. The image build needs Docker.
 */
/** The image for hosted agent runs. Only built when a stage binds it, so dev never needs Docker. */
const runner = () =>
  Cloudflare.Container("Runner", {
    schedulingPolicy: "durable_object",
    context: `${import.meta.dirname}/../..`,
    dockerfile: "apps/runner/Dockerfile",
  })

export const App = Cloudflare.Website.StaticSite(
  "App",
  Alchemy.Stack.useSync((stack) => ({
    command: "vite build",
    outdir: "dist",
    main: "./src/worker/index.ts",
    env: {
      WORKSPACE: Cloudflare.DurableObject("WorkspaceCell"),
      TABLE: Cloudflare.DurableObject("TableCell"),
      BOARD: Cloudflare.DurableObject("BoardCell"),
      DOC: Cloudflare.DurableObject("DocCell"),
      TRACKER: Cloudflare.DurableObject("TrackerCell"),
      MCP: Cloudflare.DurableObject("McpCell"),
      // Hosted agent runs need Docker to build, so dev stages stay without them and use `stdartifacts agent serve`.
      ...(!stack.stage.startsWith("dev") && { RUNNER: Cloudflare.DurableObject("RunnerCell", { containers: [runner()] }) }),
      ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: Redacted.make(process.env.ANTHROPIC_API_KEY) }),
      ...(process.env.TICKET_SECRET && { TICKET_SECRET: Redacted.make(process.env.TICKET_SECRET) }),
      // Sign-in with WorkOS (live mode). Without them, live mode refuses every sign-in and says what's missing.
      ...(process.env.WORKOS_API_KEY && { WORKOS_API_KEY: Redacted.make(process.env.WORKOS_API_KEY) }),
      ...(process.env.WORKOS_CLIENT_ID && { WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID }),
      ...(process.env.WORKOS_COOKIE_PASSWORD && { WORKOS_COOKIE_PASSWORD: Redacted.make(process.env.WORKOS_COOKIE_PASSWORD) }),
      ...(process.env.APP_URL && { APP_URL: process.env.APP_URL }),
      // Ticketless "dev owner" access only ever exists in dev stages.
      AUTH_MODE: stack.stage.startsWith("dev") ? "dev" : "live",
      // Dev answers localhost only; this lets a tunnel host in too (see dev-guard.ts).
      ...(stack.stage.startsWith("dev") && process.env.DEV_ALLOWED_HOSTS && { DEV_ALLOWED_HOSTS: process.env.DEV_ALLOWED_HOSTS }),
      // Content search is on when the key is set; without it, search matches titles only.
      SEARCH_PREFIX: `standard-artifacts-${stack.stage}`,
      ...(process.env.TURBOPUFFER_API_KEY && { TURBOPUFFER_API_KEY: Redacted.make(process.env.TURBOPUFFER_API_KEY) }),
      ...(process.env.TURBOPUFFER_URL && { TURBOPUFFER_URL: process.env.TURBOPUFFER_URL }),
    },
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*", "/mcp"] },
    dev: { port: 1337, strictPort: true },
  })),
)

export default Alchemy.Stack(
  // The old product name, kept on purpose: local Durable Object data is keyed by it, so changing it starts dev empty.
  "AhComponents",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Command.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const app = yield* App
    const ui = yield* Command.Dev("Vite", {
      command: "vite dev --port 5173 --strictPort",
      // Alchemy runs with NODE_ENV=production; Vite derives import.meta.env.DEV from it.
      env: { API_URL: "http://localhost:1337", NODE_ENV: "development" },
    })
    return { url: app.url, ui: ui.url }
  }),
)
