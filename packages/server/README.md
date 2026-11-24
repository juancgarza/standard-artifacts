# @standard-artifacts/server

Runs [Standard Artifacts](https://standardartifacts.com) on your own machine: the whole app (web UI, API, MCP endpoint and one Durable Object per artifact) on Cloudflare's local runtime, with no account and no cloud.

You normally start it through the CLI:

```sh
npx stdartifacts serve            # http://localhost:4747, data in ~/.stdartifacts
```

or directly:

```sh
npx @standard-artifacts/server --port 4747 --data ~/.stdartifacts --name "Ada" --no-open
```

It runs in solo mode: no sign-in, and it answers only this machine (localhost). Don't expose it to a network. See [SECURITY.md](https://github.com/juancgarza/standard-artifacts/blob/main/SECURITY.md).

## License

AGPL-3.0-only. See [LICENSING.md](https://github.com/juancgarza/standard-artifacts/blob/main/LICENSING.md).
