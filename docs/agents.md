# Agents: issues, runs and @-mentions

Agents work here the way people do, through the same API and permissions, and leave a record you can check.

## Issues: work for people and agents, on the record

A **tracker** holds issues (Linear-style: status, priority, labels, due date), grouped by status, with a detail panel. Keys: `C` new issue, ↑/↓ or J/K to move, Enter to open, Esc to close.

- **Owner and delegate.** The owner is the accountable person. The delegate does the work: the owner, someone else, or an agent (Claude, ChatGPT, Codex).
- **Source.** Each issue records where it came from: the app, the CLI, or MCP. Over MCP it also records which client sent it (ChatGPT, Claude, Codex) and the artifact it was made from, e.g. "created via ChatGPT (MCP) from Pricing memo".
- **Runs.** A run is one attempt by an agent: who, from which app, which model, how long, its state (Running, Needs review, Done, Failed), a summary, and its steps.
  - Over MCP, an agent works its queue with `my_issues` (issues delegated to that app's agent), then `start_run`, then `complete_run`.
  - While a run is open, every change it makes through the MCP tools is logged as a step automatically, linked to what it touched. `log_step` adds anything else.
  - People approve or reject a run on the issue.
- **Links.** An issue links the boards, tables, docs and trackers it's about, or other issues ("#12"); they show as cards with live previews. What its runs touched shows under them, ready to link. Agents link with `create_issue` (`links`) and `update_issue` (`link`/`unlink`), and `get_issue` lists links first so agents start from them. The reference type (`ArtifactRef`: an artifact, optionally one item in it) is the same one other surfaces will use for embeds and backlinks.
- **MCP.** The tools are `list_issues`, `get_issue`, `create_issue`, `update_issue`, `comment_issue`, `my_issues`, `start_run`, `log_step` and `complete_run`.
  - Issues are readable as `stdartifacts://tracker/<id>/<number>`.
  - ChatGPT's composer @-mentions find them ("#12", or words from the title).

## @-mentions wake an agent

Type `@claude …` (or `@agent …`) in a doc block, a board note or a table cell:

1. The cell sees that a person added a mention. Agent edits never file one, so agents can't wake each other into loops. It files the mention in the org's inbox, which lives in the workspace cell and is durable.
2. A mention becomes claimable once its text has been still for 3 seconds, so "@claude research…" isn't picked up halfway through typing. Further edits keep a queued request current. Editing an already-answered mention doesn't re-run it.
3. `stdartifacts agent serve` claims mentions (each claim is a 10-minute lease, with up to 3 attempts). It shows the agent's presence on the exact spot and runs a **Claude Agent SDK** session. The session's only tools are this repo's MCP server plus web search and fetch: no file or shell tools, none of your settings, a turn limit and a USD budget.
4. The agent replies in place. In a doc, it writes blocks right under the mention as a suggestion. In a table, it fills cells and gives sources. On a board, it answers in the request's thread and changes the canvas only for canvas work. Then it completes the mention with a summary.

On boards, **Ask Claude** (in the selection's toolbar, the main toolbar, or ⌘J) opens a prompt bar. The selection is its context; with nothing selected, the context is what's in view. No note is created to hold the request. It's pinned as a thread on the shape, or on the spot it's about. Pins show whether the agent is queued, working, done or failed. Follow-ups in the thread carry the earlier turns, and **Resolve** removes the pin. Typing `@claude` in a note also starts a thread on that note.

```sh
export ANTHROPIC_API_KEY=…            # or Bedrock/Vertex credentials; claude.ai logins aren't for third-party apps
stdartifacts agent serve                         # --once, --budget 1, --max-turns 30, --model claude-opus-5-5
stdartifacts agent serve --dry-run               # show the prompt and tools for the next mention; calls nothing
stdartifacts agent inbox                         # recent mentions and their status
```

The inbox API (`GET /mentions`, `POST /mentions/claim`, `POST /mentions/:id/complete`) is what any other runner would use.

### Hosted runs

On a Cloudflare deploy, nobody has to run `stdartifacts agent serve`. When a mention is ready, the workspace cell's alarm starts a container for it (`RunnerCell`), which runs `stdartifacts agent serve --once`, answers and exits. Nothing sits idle, and runs can't see each other. It's on when the stage binds `RUNNER` and sets `ANTHROPIC_API_KEY` and `TICKET_SECRET`; dev stages and celld keep using `stdartifacts agent serve`.

- **No secrets in the container.** It has no internet. Everything it sends goes through a Worker (`RunnerOutbound`, rules in `runner-outbound.ts`), which adds the Anthropic key and a short-lived ticket. The ticket acts for the person who asked, as an editor.
- **The web is read-only.** A run can GET public pages, with credentials removed, and those hosts are logged. It can't POST anywhere else. A GET can still carry data in its URL, so this limits a prompt-injected page rather than ruling it out.
- **Limits.** 3 runs at once per org, with the rest queued. $1 and 30 turns per run, and 9 minutes before a stuck run is stopped. `RUNNER_DAILY_RUNS` per org in 24 hours (default 50), after which requests fail with a reason.
- **Recovery.** A failed start retries after 30 seconds, and after three tries the request fails with a reason. A run that dies leaves its lease to expire, and then it's retried, up to the usual three attempts.

The image is `apps/runner/Dockerfile`, built from the repo root by `alchemy deploy`, which needs Docker.
