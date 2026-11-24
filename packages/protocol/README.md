# @standard-artifacts/protocol

The contract behind [Standard Artifacts](https://standardartifacts.com): shared tables, boards, docs and issue trackers for people and agents. It holds the [Effect Schema](https://effect.website) definitions for artifacts and their state, the ops each surface accepts, the room wire protocol, and the typed `HttpApi` the server implements.

It has no Node-only dependencies, so it runs in Node 22+, browsers and Workers.

## Install

```sh
npm install @standard-artifacts/protocol effect
```

`effect` (4.x) is a peer dependency, so your app and the Standard Artifacts packages share one copy of it.

## Example

```ts
import { Schema } from "effect"
import { Artifact, kindOfId, markdownToBlocks, newId, parseRef } from "@standard-artifacts/protocol"

kindOfId("t_abc") // "table"
parseRef("t_abc#r_def") // { artifactId: "t_abc", item: "r_def" }

const blocks = markdownToBlocks("# Plan\n\n- [ ] ship", () => newId("k_"))

const artifact = Schema.decodeUnknownSync(Artifact)(await fetch(url).then((r) => r.json()))
```

To call the API, use [`@standard-artifacts/client`](https://www.npmjs.com/package/@standard-artifacts/client), which is built on this package.

## License

Apache-2.0. See [LICENSE](./LICENSE).
