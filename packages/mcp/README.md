# @standard-artifacts/mcp

[MCP](https://modelcontextprotocol.io) tools and `stdartifacts://` resources for [Standard Artifacts](https://standardartifacts.com), so agents can read and edit shared tables, boards, docs and issue trackers alongside people. Built on [Effect AI](https://effect.website) and [`@standard-artifacts/client`](https://www.npmjs.com/package/@standard-artifacts/client).

The layer is transport-agnostic: register it on whichever `McpServer` transport your host provides (stdio, Streamable HTTP). If you only want a ready-made stdio server, run `npx stdartifacts mcp` from the [`stdartifacts`](https://www.npmjs.com/package/stdartifacts) CLI.

## Install

```sh
npm install @standard-artifacts/mcp @standard-artifacts/client effect
```

`effect` (4.x) is a peer dependency, so your app and the Standard Artifacts packages share one copy of it.

## Example

A stdio server in Node (add `@effect/platform-node` for the stdio layer):

```ts
import { Layer } from "effect"
import { McpServer } from "effect/ai"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeStdio from "@effect/platform-node/NodeStdio"
import { StandardArtifactsClient } from "@standard-artifacts/client"
import { StandardArtifactsMcp, serverExtensions, serverInfo } from "@standard-artifacts/mcp"

StandardArtifactsMcp.pipe(
  Layer.provide(McpServer.layerStdio({ ...serverInfo, extensions: serverExtensions })),
  Layer.provide(NodeStdio.layer),
  Layer.provide(StandardArtifactsClient.layerConfig({ defaultAs: "agent" })),
  Layer.launch,
  NodeRuntime.runMain,
)
```

`layerConfig` reads `STDARTIFACTS_URL` and `STDARTIFACTS_TOKEN` from the environment.

## License

Apache-2.0. See [LICENSE](./LICENSE).
