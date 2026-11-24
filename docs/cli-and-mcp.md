
# CLI and MCP

The `stdartifacts` CLI, the MCP server it runs over stdio, and the same tools over Streamable HTTP at `/mcp`.

```sh
pnpm cli                                   # builds apps/cli/dist/stdartifacts.mjs
alias stdartifacts="node $PWD/apps/cli/dist/stdartifacts.mjs"
stdartifacts ls
stdartifacts new table "Leads"
stdartifacts table add-row Leads Name="Ada Lovelace" Website=https://ada.dev Status=Lead
stdartifacts table add-column Leads Related --type artifact   # links to other artifacts or their items, by id, title or app URL
stdartifacts table add-row Leads Name="Grace" Related="Launch memo, t_abc#r_def"
printf '# Plan\n\n- [ ] ship\n' | stdartifacts doc append "Launch memo"
stdartifacts doc image "Launch memo" chart.png --caption "Signups"
printf '![[t_abc]]\n\n![[b_abc#s_def|The plan]]\n' | stdartifacts doc append "Launch memo"  # read-only previews of a table and a board shape
stdartifacts board add "Roadmap" "Idea from the terminal" --color green
stdartifacts board link Roadmap "Launch plan" t_abc#r_1   # previews of other artifacts or their items, by title, id or app URL
stdartifacts board design add Roadmap hero.html       # HTML/CSS → editable layers (prints the outline)
stdartifacts board design get Roadmap s_… > hero.html # HTML with data-node ids; edit it, then:
stdartifacts board design set Roadmap s_… hero.html   # ids (and others' edits to them) survive
stdartifacts board design patch Roadmap s_… n_… --text "Ship it" --style color=#e5484d
stdartifacts new tracker "Launch"
stdartifacts issue new Launch "Write the pricing page" --priority high --delegate claude
stdartifacts issue set Launch 1 --status in_review
stdartifacts issue ls Launch
stdartifacts read Leads
stdartifacts folder new Marketing/Launch              # a folder's path is its namespace; parents are created too
stdartifacts new doc "Launch memo" --folder Marketing/Launch
stdartifacts mv Leads Marketing/Launch                # "/" moves it back to the root
stdartifacts read Marketing/Launch/Leads              # refs can go through the path
stdartifacts ls --folder Marketing/Launch
stdartifacts folder rm Marketing/Launch               # deletes only the folder; what's inside moves up
stdartifacts archive Leads                            # hide it, keep its content
stdartifacts ls --archived
stdartifacts restore Leads                            # bring it back (stdartifacts rm deletes for good)

# MCP (stdio) for Claude Code. In dev, edits are attributed to an agent.
claude mcp add stdartifacts -- node $PWD/apps/cli/dist/stdartifacts.mjs mcp
```

### Remote MCP (Codex, ChatGPT)

The Worker serves the same tools over Streamable HTTP at `/mcp`. It authenticates each request (`Authorization: Bearer <ticket>`) and hands it to that principal's `McpCell`, a Durable Object that keeps the MCP sessions and calls the API in-process. Edits go through the same permissions as everything else, so a viewer's session can read but not write. In dev, requests without `x-dev-as` act as an agent.

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.stdartifacts]
url = "http://localhost:5173/mcp"
# live: bearer_token_env_var = "STDARTIFACTS_TOKEN"
```

ChatGPT needs a public HTTPS URL. In dev, tunnel the Worker port (Vite rejects unknown hosts): `cloudflared tunnel --url http://localhost:1337`. A dev server only answers requests for localhost, so add the tunnel’s host to `DEV_ALLOWED_HOSTS` (comma-separated) and restart it: `DEV_ALLOWED_HOSTS=<tunnel>.trycloudflare.com pnpm dev` (or tunnel port 4747 and run `DEV_ALLOWED_HOSTS=… npx stdartifacts serve`). Then add `https://<tunnel>/mcp` as a connector in developer mode. Careful: this exposes your workspace. A dev server has no sign-in, so anyone with that URL can read and edit everything in it as you. Close the tunnel and drop the variable when you’re done.

What ChatGPT gets beyond the tools:

- **@-mentions.** The server advertises OpenAI's `openai/mentions` extension. Typing `@` in the composer searches boards, tables and docs by title (`search_mentions`), and the pick is attached as a link to its `stdartifacts://<kind>/<id>` resource.
- **Resources.** `resources/read` on `stdartifacts://board/b_…` (or `table`, `doc`) returns the artifact as compact text, the same as `read_artifact`.
- **Read-only hints.** Reads are marked `readOnlyHint`, so hosts can run them without asking.

Configuration: `STDARTIFACTS_URL` (default http://localhost:5173), `STDARTIFACTS_TOKEN` (ticket), and `STDARTIFACTS_AS` (dev only: guest, viewer or agent).
