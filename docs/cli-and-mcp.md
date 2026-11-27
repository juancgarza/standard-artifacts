
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

## Connect an agent

On a server with sign-in (Standard Artifacts Cloud, or self-hosted with WorkOS), agents connect to the MCP server by URL and sign in in your browser: no tokens to paste. **Settings → Connections** shows these steps with your server's URL filled in. Below, `https://app.standardartifacts.com/mcp` stands for it.

When an app connects, your browser opens a consent page. It shows the app, where it sends you back to (with a warning if that looks wrong), and who you're signed in as. Pick the **workspace** the agent works in and its **access**:

- **Read and write**: it edits as your role allows, never above Editor. On the Free plan only the owner edits, so an Editor's agents read only until the workspace is on Team.
- **Read only**: it reads, and can't change anything.

Approve, and you're sent back to the app. The agent's work shows as the app acting for you ("Claude Code via Ada"). It appears under **Settings → Connections → Connected agents**, with when it was last used, until you **Disconnect** it; that takes effect on its next request. Owners see and can disconnect everyone's agents in the workspace.

**Claude (claude.ai and Claude Desktop)**

1. Open **Settings → Connectors** and choose **Add custom connector**. On a Team or Enterprise plan, an owner adds it first under **Organization settings → Connectors**.
2. Name it **Standard Artifacts** and paste `https://app.standardartifacts.com/mcp`.
3. Choose **Add**, then **Connect**, and approve in the browser. Claude.ai and Claude Desktop share the connector.

**Claude Code**

```sh
claude mcp add --transport http --scope user standard-artifacts https://app.standardartifacts.com/mcp
```

Then run `/mcp` in Claude Code, pick `standard-artifacts` and choose **Authenticate**. Claude Code keeps itself signed in from then on.

**ChatGPT**

1. Open **Settings → Apps & Connectors → Advanced settings** and turn on **Developer mode**. A workspace admin may need to allow custom connectors first.
2. Choose **Create**. Name it **Standard Artifacts**, paste the URL, and pick **OAuth** for authentication.
3. Create it, then **Connect** and approve in the browser.

**Codex**

```sh
codex mcp add standard-artifacts --url https://app.standardartifacts.com/mcp
codex mcp login standard-artifacts
```

The login opens the browser. Start a new Codex session to load the tools.

**Cursor**: use **Add to Cursor** in Settings → Connections, or add this to `~/.cursor/mcp.json`, then choose **Connect** under Cursor Settings → MCP:

```json
{ "mcpServers": { "standard-artifacts": { "url": "https://app.standardartifacts.com/mcp" } } }
```

**VS Code**: use **Add to VS Code** in Settings → Connections, or run the command below. Start the server from the MCP Servers list and allow it to sign in.

```sh
code --add-mcp '{"name":"standard-artifacts","type":"http","url":"https://app.standardartifacts.com/mcp"}'
```

**Other clients**: most take a Streamable HTTP URL and sign in with OAuth on first connect. A client that can't sign in can send an [access token](#access-tokens-live-servers) as `Authorization: Bearer <token>` instead.

To check a connection, `GET /mcp/whoami` with the agent's bearer token returns who it acts for, the workspace, its access, and the app.

### How sign-in works

The Worker is a small OAuth 2.1 authorization server for `/mcp`, following the MCP authorization spec. WorkOS stays the identity provider: the consent page uses your browser session and sends you to sign in if there isn't one. The code is in `apps/app/src/worker/oauth*.ts` and `cells/grants.ts`.

- **Discovery.** `/mcp` without a token answers 401 with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"` (RFC 9728). That names this server as the authorization server, whose metadata is at `/.well-known/oauth-authorization-server` (RFC 8414).
- **Clients** register at `/api/oauth/register` (RFC 7591), or use an https URL serving their metadata as `client_id` (a Client ID Metadata Document). Those are fetched without following redirects, within 5 seconds and 16 KB, and only from public host names.
- **Authorization** is the code flow with PKCE (S256 only) at `/api/oauth/authorize`, which leads to the consent page at `/authorize`. Redirect URIs must match what the client registered exactly, except loopback ones (`127.0.0.1`, `[::1]`, `localhost`), which may use any port (RFC 8252). Nothing is sent to a redirect URI until it checks out. The answer carries `iss` (RFC 9207).
- **Tokens** come from `/api/oauth/token`. They're opaque, kept only as SHA-256 hashes, and bound to `<origin>/mcp` (RFC 8707): the API refuses them. Access tokens last an hour. Refresh tokens last 30 days and rotate on every use. Presenting a used one again ends the whole grant (reuse detection), except for a retry within 30 seconds whose answer the client never got. `/api/oauth/revoke` (RFC 7009) ends the grant behind either token.
- **Grants** bind one person, one app and one workspace, with the access chosen at consent. Every request checks the person's role with the account service (at most 5 minutes old) and the plan, as access tokens do.
- **401 or 403.** A token that's unknown, expired, revoked or disconnected answers 401 with the `resource_metadata` challenge, so the client signs in again. A grant whose person left the workspace answers 403 with the reason: signing in again wouldn't help.
- **Storage.** Grants, codes and tokens live in the workspace's WorkspaceCell. A grant belongs to one workspace from the moment it exists, so revoking, listing and a member's removal stay in one place. Client registrations, consent requests (15 minutes, used once) and rate limits live in one `OAuthCell`, since they exist before anyone picks a workspace.
- **Hardening.** The consent answer needs the session cookie, a same-origin JSON request, and a CSRF token tied to the request and the person. The consent page refuses to work inside a frame, and the OAuth endpoints send `frame-ancestors 'none'`. Registration, authorization and token requests are rate limited per IP, generously, since hosted clients share IPs.
- A dev server (`pnpm dev`, `stdartifacts serve`) has no sign-in: none of this is served, and `/mcp` needs no token.

### Access tokens (live servers)

A server with sign-in (Standard Artifacts Cloud, or self-hosted with WorkOS) needs a token for the CLI and MCP. Create one under **Settings → Access tokens**; it's shown once. Then:

```sh
export STDARTIFACTS_URL=https://app.example.com
export STDARTIFACTS_TOKEN=sat_…
stdartifacts ls
claude mcp add stdartifacts -e STDARTIFACTS_URL=https://app.example.com -e STDARTIFACTS_TOKEN=$STDARTIFACTS_TOKEN -- npx stdartifacts mcp
claude mcp add --transport http stdartifacts https://app.example.com/mcp --header "Authorization: Bearer $STDARTIFACTS_TOKEN"
```

- A token acts as you, in the workspace you created it in, with your current role. If an owner changes your role, the token follows within 5 minutes. If you leave the workspace, it stops working.
- Under `stdartifacts mcp`, and over remote MCP, the same token acts as an agent for you, named after the token ("Claude Code"), never above editor. `STDARTIFACTS_AS=agent` does the same for the CLI.
- Only a hash is stored. Revoke a token in Settings and it stops working on its next request. A token can't create more tokens.
- A dev server (`pnpm dev`, `stdartifacts serve`) needs no token.

### Remote MCP (Codex, ChatGPT)

The Worker serves the same tools over Streamable HTTP at `/mcp`. It authenticates each request (`Authorization: Bearer <token>`: an OAuth token from [signing in](#connect-an-agent), an access token, or a ticket) and hands it to that principal's `McpCell`, a Durable Object that keeps the MCP sessions and calls the API in-process. An OAuth token stops at the Worker: the cell gets a 5-minute ticket for the grant's agent instead. Edits go through the same permissions as everything else, so a viewer's session can read but not write. In dev, requests without `x-dev-as` act as an agent.

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

Configuration: `STDARTIFACTS_URL` (default http://localhost:5173), `STDARTIFACTS_TOKEN` (an access token from Settings, or a ticket), and `STDARTIFACTS_AS` (dev: guest, viewer or agent; with an access token, only agent applies).
