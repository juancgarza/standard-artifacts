/**
 * Bundles the main process and the preload script into dist/.
 *
 * A packaged build loads the address it was built for: app.standardartifacts.com,
 * or STDARTIFACTS_DESKTOP_URL when it's set here (a staging build, say).
 * Unpackaged runs (`pnpm dev`) read STDARTIFACTS_DESKTOP_URL when they start instead.
 */
import { build } from "esbuild"

const DEFAULT_URL = "https://app.standardartifacts.com"
const url = process.env.STDARTIFACTS_DESKTOP_URL?.trim() || DEFAULT_URL
const parsed = new URL(url)
if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`STDARTIFACTS_DESKTOP_URL must be an http(s) address, not ${url}`)
if (parsed.origin !== new URL(DEFAULT_URL).origin) console.warn(`Packaged builds from this will load ${parsed.origin}`)

await build({
  entryPoints: ["src/main.ts", "src/preload.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  loader: { ".html": "text" },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  define: { PACKAGED_APP_URL: JSON.stringify(parsed.origin) },
  logLevel: "warning",
})
