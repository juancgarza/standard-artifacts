# stdartifacts

The command-line client for [Standard Artifacts](https://standardartifacts.com): shared tables, boards, docs and issue trackers for people and agents. It also serves the Standard Artifacts MCP tools over stdio, for Claude Code, Claude Desktop, Cursor and other MCP hosts.

Requires Node 22 or later.

## Install

```sh
npm install -g stdartifacts
# or run it without installing
npx stdartifacts --help
```

## Example

```sh
export STDARTIFACTS_URL=https://your-workspace.example   # default http://localhost:5173
export STDARTIFACTS_TOKEN=…

stdartifacts ls
stdartifacts new table "Leads"
stdartifacts table add-row Leads Name="Ada Lovelace" Status=Lead
printf '# Plan\n\n- [ ] ship\n' | stdartifacts doc append "Launch memo"
stdartifacts issue new Launch "Write the pricing page" --priority high

# MCP over stdio
claude mcp add stdartifacts -- npx stdartifacts mcp
```

Two commands load optional packages on demand: `stdartifacts shot` needs `playwright-core`, and `stdartifacts agent serve` needs `@anthropic-ai/claude-agent-sdk`. Install them next to the CLI if you use those commands.

## License

Apache-2.0. See [LICENSE](./LICENSE).
