/**
 * Builds the publishable server: the app's Worker bundle and SPA, plus the launcher.
 *
 *   dist/worker.mjs   apps/app/src/worker as one ES module (what workerd runs)
 *   dist/assets/      apps/app's `vite build` output (the SPA)
 *   dist/index.mjs    the launcher API (`serve`, `run`), miniflare left external
 *   dist/bin.mjs      the `standard-artifacts-server` command
 */
import { execFileSync } from "node:child_process"
import { cpSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const pkg = here("..")
const app = here("../../../apps/app")
const dist = here("../dist")

rmSync(dist, { recursive: true, force: true })

execFileSync("pnpm", ["exec", "vite", "build", "--logLevel", "warn"], { cwd: app, stdio: "inherit" })
cpSync(`${app}/dist`, `${dist}/assets`, { recursive: true })

await build({
  entryPoints: [`${app}/src/worker/index.ts`],
  outfile: `${dist}/worker.mjs`,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  // Readable on purpose: this is AGPL code people may want to inspect.
  minify: false,
  logLevel: "warning",
  banner: { js: "// Standard Artifacts server (AGPL-3.0-only). Source: https://github.com/juancgarza/standard-artifacts/tree/main/apps/app" },
})

await build({
  entryPoints: [`${pkg}/src/index.ts`, `${pkg}/src/bin.ts`],
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  logLevel: "warning",
})
