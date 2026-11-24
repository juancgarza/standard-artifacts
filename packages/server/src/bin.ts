import { parseArgs } from "node:util"
import { DEFAULT_PORT, run } from "@standard-artifacts/server"

const usage = `Usage: standard-artifacts-server [--port ${DEFAULT_PORT}] [--data ~/.stdartifacts] [--name <name>] [--no-open]

Runs Standard Artifacts on this machine (http://127.0.0.1:${DEFAULT_PORT}), with no sign-in.

  --port <n>     Port to listen on (default ${DEFAULT_PORT})
  --data <dir>   Where the workspace is stored (default ~/.stdartifacts)
  --name <name>  Your display name (default: your OS account's name)
  --no-open      Don't open the browser`

try {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      data: { type: "string" },
      name: { type: "string" },
      open: { type: "boolean", default: true },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log(usage)
    process.exit(0)
  }
  const port = values.port === undefined ? undefined : Number(values.port)
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new Error(`Invalid --port: ${values.port}`)
  await run({ port, data: values.data, name: values.name, open: values.open && !values["no-open"] })
} catch (error) {
  console.error(`error: ${(error as Error).message ?? error}`)
  process.exit(1)
}
