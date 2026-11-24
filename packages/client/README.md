# @standard-artifacts/client

A typed [Effect](https://effect.website) client for the [Standard Artifacts](https://standardartifacts.com) HTTP API: shared tables, boards, docs and issue trackers for people and agents. On top of the raw API it adds helpers that speak in names and markdown instead of ops, such as "set the Status column" or "append this markdown to the doc".

It uses `fetch` and nothing Node-only, so it runs in Node 22+, browsers and Workers.

## Install

```sh
npm install @standard-artifacts/client effect
```

`effect` (4.x) is a peer dependency, so your app and the Standard Artifacts packages share one copy of it.

## Example

```ts
import { Effect } from "effect"
import { StandardArtifactsClient } from "@standard-artifacts/client"

const program = Effect.gen(function* () {
  const client = yield* StandardArtifactsClient
  for (const a of yield* client.list()) console.log(a.kind, a.id, a.title)
  yield* client.table.addRows("Leads", [{ Name: "Ada Lovelace", Status: "Lead" }])
  yield* client.doc.appendMarkdown("Launch memo", "# Plan\n\n- [ ] ship")
})

await Effect.runPromise(
  program.pipe(Effect.provide(StandardArtifactsClient.layer({ url: "http://localhost:5173" }))),
)
```

`StandardArtifactsClient.layerConfig()` reads the connection from `STDARTIFACTS_URL` (default `http://localhost:5173`) and `STDARTIFACTS_TOKEN` instead. Failures are `StandardArtifactsError`s with a one-line message.

## License

Apache-2.0. See [LICENSE](./LICENSE).
