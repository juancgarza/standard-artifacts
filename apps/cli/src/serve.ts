import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { constants } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { StandardArtifactsError } from "@standard-artifacts/client"

/**
 * `stdartifacts serve`: the whole app on this machine. The server is
 * @standard-artifacts/server (AGPL-3.0). This runs its `standard-artifacts-server`
 * bin as a child process and never loads its code, so the CLI stays Apache-2.0.
 */
export const serveLocally = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const bin = yield* Effect.try({
      try: serverBin,
      catch: (e) =>
        new StandardArtifactsError({
          message: `Can't find the server (@standard-artifacts/server): ${e instanceof Error ? e.message : String(e)}. Reinstall stdartifacts, or run: npm install @standard-artifacts/server`,
        }),
    })
    const code = yield* runChild(process.execPath, [bin, ...args])
    if (code !== 0) process.exitCode = code
  })

/** The `standard-artifacts-server` bin, found through the installed package's own package.json. */
function serverBin(): string {
  const manifest = createRequire(import.meta.url).resolve("@standard-artifacts/server/package.json")
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: Record<string, string> }
  const relative = bin?.["standard-artifacts-server"]
  if (!relative) throw new Error("its package.json has no standard-artifacts-server bin")
  const path = join(dirname(manifest), relative)
  if (!existsSync(path)) throw new Error(`${path} is missing (is the package built?)`)
  return path
}

/**
 * Run a child on the terminal's stdio and resolve with its exit code. Ctrl+C
 * reaches it from the terminal as well; when we're interrupted (SIGINT or
 * SIGTERM to us alone), pass SIGTERM on and wait for it to shut down cleanly.
 */
const runChild = (command: string, args: Array<string>) =>
  Effect.callback<number, StandardArtifactsError>((resume) => {
    const child = spawn(command, args, { stdio: "inherit" })
    const exited = new Promise<void>((done) => child.once("exit", () => done()))
    child.once("error", (e) => resume(Effect.fail(new StandardArtifactsError({ message: `Could not start the server: ${e.message}` }))))
    child.once("exit", (code, signal) => resume(Effect.succeed(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1))))
    return Effect.promise(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      return exited
    })
  })
