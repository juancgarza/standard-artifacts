#!/usr/bin/env node
// Checks that the npm packages install and work outside the monorepo:
//   1. `pnpm pack` each published package (prepack builds dist/) into a temp dir,
//   2. `npm install` the tarballs into a fresh project there,
//   3. check there's one copy of effect, import each library, run `stdartifacts --help`, typecheck a consumer against the
//      shipped .d.ts, and bundle protocol + client for the browser (no Node built-ins).
// Nothing is published. Usage: node scripts/pack-check.mjs [--keep]
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
const packages = [
  { name: "@standard-artifacts/protocol", dir: "packages/protocol", library: true },
  { name: "@standard-artifacts/client", dir: "packages/client", library: true },
  { name: "@standard-artifacts/mcp", dir: "packages/mcp", library: true },
  { name: "@standard-artifacts/server", dir: "packages/server", library: false },
  { name: "stdartifacts", dir: "apps/cli", library: false },
]

const work = mkdtempSync(join(tmpdir(), "stdartifacts-pack-"))
const packs = join(work, "packs")
const app = join(work, "app")
mkdirSync(packs)
mkdirSync(app)

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
const step = (title) => console.log(`\n▸ ${title}`)

try {
  step("Packing")
  for (const p of packages) run("pnpm", ["pack", "--pack-destination", packs], join(repo, p.dir))
  const tarballs = readdirSync(packs).filter((f) => f.endsWith(".tgz")).sort()
  if (tarballs.length !== packages.length) throw new Error(`expected ${packages.length} tarballs, got ${tarballs.join(", ")}`)
  for (const t of tarballs) {
    const files = run("tar", ["-tzf", join(packs, t)], work).trim().split("\n").map((f) => f.replace(/^package\//, ""))
    const allowed = (f) => f === "package.json" || f === "LICENSE" || f === "README.md" || f.startsWith("dist/")
    const extra = files.filter((f) => !allowed(f))
    for (const must of ["package.json", "LICENSE", "README.md"]) if (!files.includes(must)) throw new Error(`${t} is missing ${must}`)
    if (extra.length) throw new Error(`${t} ships files outside dist/, LICENSE, README.md: ${extra.join(", ")}`)
    console.log(`  ${t}  ${(statSync(join(packs, t)).size / 1024).toFixed(1)} kB packed`)
    for (const f of files.sort()) console.log(`    ${f}`)
  }

  step("Installing the tarballs into a fresh project")
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pack-check", private: true, type: "module" }, null, 2))
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...tarballs.map((t) => join(packs, t))], app)

  step("One copy of each shared runtime dependency")
  // effect is a peer of the libraries, so npm installs it once; a copy per package would
  // break Effect services and Schema identity across them.
  for (const dep of ["effect"]) {
    const copies = new Set(run("npm", ["ls", dep, "--all", "--parseable"], app).trim().split("\n").filter(Boolean))
    if (copies.size !== 1) throw new Error(`expected one copy of ${dep}, found ${copies.size}:\n${[...copies].join("\n")}`)
    console.log(`  ${dep}: 1 copy (${JSON.parse(readFileSync(join([...copies][0], "package.json"), "utf8")).version})`)
  }

  step("Importing each library")
  for (const p of packages.filter((p) => p.library)) {
    const n = Number(run("node", ["-e", `import(${JSON.stringify(p.name)}).then((m) => console.log(Object.keys(m).length))`], app).trim())
    if (!(n > 0)) throw new Error(`${p.name} has no exports`)
    console.log(`  ${p.name}: ${n} exports`)
  }

  step("stdartifacts --help")
  const help = run("npx", ["--no", "--", "stdartifacts", "--help"], app)
  if (!help.includes("USAGE") || !help.includes("stdartifacts")) throw new Error(`unexpected --help output:\n${help}`)
  console.log(`  ${help.trim().split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ")}`)

  step("Typechecking a consumer against the shipped .d.ts")
  writeFileSync(
    join(app, "check.ts"),
    `import { Effect } from "effect"
import { StandardArtifactsClient, StandardArtifactsError, type Client } from "@standard-artifacts/client"
import { kindOfId, parseRef, type ArtifactKind } from "@standard-artifacts/protocol"
import { StandardArtifactsMcp, serverInfo } from "@standard-artifacts/mcp"

const program = Effect.gen(function* () {
  const client: Client = yield* StandardArtifactsClient
  for (const a of yield* client.list()) console.log(a.kind, a.id, a.title)
  yield* client.table.addRows("Leads", [{ Name: "Ada Lovelace", Status: "Lead" }])
  yield* client.doc.appendMarkdown("Launch memo", "# Plan\\n\\n- [ ] ship")
})

const kind: ArtifactKind | undefined = kindOfId("t_abc")
console.log(kind, parseRef("t_abc#r_def")?.artifactId, serverInfo.name, StandardArtifactsMcp, StandardArtifactsError)

export const main = () => Effect.runPromise(program.pipe(Effect.provide(StandardArtifactsClient.layer({ url: "http://localhost:5173" }))))

// @ts-expect-error: the shipped types are real types, not any
export const wrong: number = kindOfId("t_abc")
`,
  )
  // The workspace's TypeScript, so the check doesn't depend on whatever npm serves today.
  const tsc = createRequire(join(repo, "packages/client/package.json")).resolve("typescript/bin/tsc")
  const common = ["--noEmit", "--strict", "--target", "es2022", "--lib", "es2022,dom", "check.ts"]
  run("node", [tsc, "--module", "nodenext", "--moduleResolution", "nodenext", ...common], app)
  run("node", [tsc, "--module", "esnext", "--moduleResolution", "bundler", ...common], app)
  console.log("  ok (nodenext and bundler resolution)")

  step("Bundling protocol + client for the browser")
  writeFileSync(join(app, "browser.js"), `export * from "@standard-artifacts/protocol"\nexport { StandardArtifactsClient } from "@standard-artifacts/client"\n`)
  const esbuild = createRequire(join(repo, "apps/cli/package.json"))("esbuild")
  await esbuild.build({ absWorkingDir: app, entryPoints: ["browser.js"], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "error" })
  console.log("  ok (no Node built-ins)")

  console.log("\nPack check passed.")
} finally {
  if (process.argv.includes("--keep")) console.log(`\nKept ${work}`)
  else rmSync(work, { recursive: true, force: true })
}
