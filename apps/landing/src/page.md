# Standard Artifacts

Open-source artifacts that you and your agents work on together.

Tables, docs, boards and issue trackers that Claude, ChatGPT, Codex
and you all edit together, live. Think of ChatGPT Spaces or Claude's
artifacts, but open source, multiplayer, and running on your own machine.

    npx stdartifacts serve

This starts Standard Artifacts on http://localhost:4747 and keeps your
data in ~/.stdartifacts. No account, no cloud.

- [Connect your agent](#connect)
- [Source on GitHub](%GITHUB_URL%)

## Four surfaces, one record

Your work lives in four kinds of artifact, in one workspace. Agents
reach them through MCP tools, the CLI or the API, and what one agent
makes, the next can read and build on.

| Surface | Use it for            | Agent tools                       |
|---------|-----------------------|-----------------------------------|
| Table   | structured data       | table_add_rows, table_set_cells   |
| Board   | ideas, layout, review | board_add, board_add_html         |
| Doc     | long-form writing     | doc_append, doc_update_block      |
| Tracker | issues and agent runs | start_run, log_step, complete_run |

## Nothing happens off the tape

Each step an agent takes is stamped on its run, along with the surface
it touched. When the run ends, the tape stops and waits for a person.
Approve it or reject it, and the record stays.

- Live presence: see what an agent is touching, right now.
- Small, reviewable edits: cell-level and block-level changes instead of rewrites.
- Built for agents to read: every artifact reads as plain text.

## Connect your agent

Add one MCP server, and your agent can read and edit the artifacts you
do, pick up issues you delegate, and leave a record you can read later.

Claude Code:

    claude mcp add stdartifacts -e STDARTIFACTS_URL=http://localhost:4747 -- npx stdartifacts mcp

Codex, in ~/.codex/config.toml:

    [mcp_servers.stdartifacts]
    command = "npx"
    args = ["stdartifacts", "mcp"]
    env = { STDARTIFACTS_URL = "http://localhost:4747" }

Other MCP clients that run a command over stdio connect the same way.

ChatGPT and Claude connectors need a public HTTPS server with sign-in.
They come with Cloud. Until then, the docs show a dev tunnel
(%REMOTE_MCP_DOCS_URL%), which exposes your workspace to anyone with its URL.

## Solo or Cloud

Run it yourself for free, or let us host it for your team.

- Solo, free and open source: you and your agents, on your machine.
  Runs with `npx stdartifacts serve`; tables, docs, boards and trackers;
  Claude Code, Codex and scripts over local MCP; `stdartifacts agent serve`
  answers @claude. [View on GitHub](%GITHUB_URL%)
- Cloud, coming soon, priced per team: your team, with sign-in and roles,
  at standardartifacts.com. Everything in Solo, hosted for you; everyone
  editing together, live; ChatGPT and Claude connectors; hosted @claude
  runs. [Join the waitlist](%WAITLIST_URL%)

The server and web app are AGPL-3.0-only. The client libraries, MCP
server and CLI are Apache-2.0, so you can build on them freely
([why](%LICENSING_URL%)).

## Before you connect anything

**Is it really free?**
Yes. Solo is open source and runs on your machine with
`npx stdartifacts serve`, with no account and no cloud. Cloud, hosted
for teams, will be priced per team.

**Where does my data live?**
Solo keeps your workspace in ~/.stdartifacts on your machine, or
wherever --data points. The agents you connect read it through MCP,
like any other tool they use.

**Which agents can connect?**
Claude Code, Codex and your own scripts connect over local MCP, the CLI
or plain HTTP. Other MCP clients that run a command over stdio connect
the same way. ChatGPT and Claude connectors need a public HTTPS server
with sign-in, which comes with Cloud.

**What gets recorded when an agent works?**
While a run is open, each change made through the MCP tools lands on it
as a step, and the agent can add its own notes. A run keeps up to 300
steps. Changes made through the CLI aren't logged on a run yet.

**Does rejecting a run undo its changes?**
No. Reject marks the run as failed and keeps its steps on the record. The
changes stay in place until someone edits them, so you can see exactly
what to fix.

**Can my team use my server?**
Not yet. Self-hosting for a team needs sign-in, which isn't built, so a
self-hosted server is for one person on localhost. Cloud brings teams,
sign-in and roles.

**Can I get my data out?**
Every artifact reads as plain text over the API, CLI and MCP: rows for
tables, shapes for boards, Markdown for docs. There's no one-click export yet.

**How is it licensed?**
The server, web app and artifact UI are AGPL-3.0-only. The client
libraries, MCP server and CLI are Apache-2.0. LICENSING.md explains why
(%LICENSING_URL%).

## The chat ends. The work stays.

    npx stdartifacts serve

[Source on GitHub](%GITHUB_URL%)

---

ChatGPT is a trademark of OpenAI. Claude is a trademark of Anthropic.
Standard Artifacts isn't affiliated with or endorsed by either.
