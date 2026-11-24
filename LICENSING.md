# Licensing

Standard Artifacts uses two licenses. Each package's `package.json` names its license with an SPDX id, and the Apache-2.0 packages carry their own `LICENSE` file. Everything else falls under the [AGPL-3.0](LICENSE) at the root.

| License | Packages |
| --- | --- |
| [AGPL-3.0-only](LICENSE) | `apps/app` (the Worker and web app), `apps/runner`, `apps/desktop`, `packages/board`, `packages/doc`, `packages/table`, `packages/tracker`, `packages/room`, `packages/server` (`@standard-artifacts/server`, what `stdartifacts serve` runs), and the rest of the repo (`tests/`, `scripts/`, docs) |
| [Apache-2.0](packages/client/LICENSE) | `packages/protocol`, `packages/client`, `packages/mcp`, `apps/cli` (the `stdartifacts` CLI) |

## Why the split

**The client libraries stay easy to embed.** The protocol, the client SDK, the MCP tools and the CLI are what other software builds on: agents, scripts, IDE integrations and other apps that talk to a Standard Artifacts server. Under Apache-2.0 you can use, modify and ship them in your own product, open or closed, with only the usual notice requirements and an explicit patent grant.

**Anyone hosting a modified server has to share their changes.** The server, the web app and the artifact editors are the product itself. The AGPL-3.0 lets anyone run, study, change and self-host them. If you modify them and let people use your version over a network, section 13 requires you to offer those users the source of your version, under the same license. Improvements to a hosted Standard Artifacts come back to everyone instead of staying inside one host.

Talking to a Standard Artifacts server through the Apache-2.0 clients doesn't put your own code under the AGPL.

## Optional dependencies of the CLI

The CLI doesn't bundle `@anthropic-ai/claude-agent-sdk` or `playwright-core`. Both are optional peer dependencies, kept external in the esbuild build and loaded only by the commands that need them (`stdartifacts agent serve` and `stdartifacts shot`). The Claude Agent SDK is distributed under Anthropic's own terms, not an open-source license, so it is never included in this repository's builds; install it yourself if you want `agent serve`.

## `stdartifacts serve`

The CLI lists `@standard-artifacts/server` (AGPL-3.0-only) as a dependency so `npx stdartifacts serve` works, but never loads its code: `serve` runs the package's `standard-artifacts-server` program as a separate process. The CLI's own bundle contains no server code.

## Third-party marks

The agent brand marks in `packages/tracker/assets/brands` belong to their owners and come with their own licenses (see `SOURCES.md` there). They are used only to name the integration.

## Contributions

Contributions are accepted under the [Contributor License Agreement](CLA.md), which lets the project owner relicense them, for example to offer the server under other terms alongside the AGPL. See [CONTRIBUTING.md](CONTRIBUTING.md).
