# Architecture

How Standard Artifacts is put together: one Worker, one Durable Object per artifact, and one reducer per surface shared by the server and the browser. For a single surface end to end, see [Boards](boards.md).

## Repo layout

```
apps/app            one Worker: the SPA (Vite) + /api/*, plus a Durable Object ("cell") per artifact
  alchemy.run.ts    infrastructure as Effects: local dev + Cloudflare deploys
  wrangler.jsonc    deploy config for celld (self-hosted Durable Objects)
  src/worker        Effect services + HttpApi handlers; cells/ holds the Durable Objects
  src/web           dashboard shell: sidebar (Folders, Boards, Tables, Docs), home, folder and artifact pages
packages/protocol   Effect Schema contract: artifacts, principals, room wire protocol, table ops, HttpApi
packages/room       browser room client: optimistic ops, reconnects, presence (+ React hook)
packages/table      <TableView>: Grid and Kanban views over one table cell
packages/board      <BoardView>: infinite canvas (notes, shapes, text, frames, connectors), live cursors
packages/doc        <DocView>: block editor with markdown shortcuts; per-block presence
packages/tracker    <TrackerView>: issues worked by people and agents; runs record what agents did
packages/client     typed SDK over the HttpApi (+ helpers: column names, markdown → blocks, auto-placed notes)
packages/mcp        MCP tools + stdartifacts:// resources on @standard-artifacts/client; transport-agnostic
apps/cli            `stdartifacts` CLI on @standard-artifacts/client; `stdartifacts mcp` serves MCP over stdio (the Worker serves it at /mcp)
apps/desktop        Electron host around the web app: windows, menus, deep links
```

## One API for every interface

Everything goes through one API (`@standard-artifacts/protocol` → `Api`), so the web app, the CLI, MCP and scripts share validation, permissions, the op log and presence:

```
web app ──────────┐
stdartifacts CLI ─┼─▶ @standard-artifacts/client ──HTTP──▶ Worker /api/v1 ──▶ cells
MCP ──────────────┘
```

## Cells and runtime

- **Cells.** Each artifact is one Durable Object with its own SQLite (plus `McpCell`, one per principal, for remote MCP sessions, and `OAuthCell`, one per deployment, for remote MCP sign-in). `TrackerCell` keeps issues, runs and comments in one ordered list; the shared reducer numbers issues and stamps who created, started or wrote what. `RoomCell` is the shared base class. It applies ops in order, keeps an op log with each op's actor, and fans changes out over hibernatable WebSockets. It also tracks presence, including agent presence with a TTL that alarms expire. `TableCell` adds columns, rows and cells. `ListCell` handles ordered records (positions are fractional, so an insert writes one row), and `BoardCell` (shapes in z-order) and `DocCell` (blocks) build on it.
- **Runtime.** celld is a fleet of identical daemons, not a process per artifact. A cell is claimed by whichever node gets the first request (through a lease in the bucket), hibernates when idle, and moves to another node if its node dies. Locally, `alchemy dev` runs the same cells in workerd.
- **One reducer per surface.** `applyTableOp`, `applyBoardOp` and `applyDocOp` in `@standard-artifacts/protocol` run in the cell (authoritative) and in the browser (optimistic), so both always agree.
- **Agents** use the same three calls on every surface: `GET /api/v1/artifacts/:id/content` returns the state plus a compact text form (rows, shapes, or the doc as markdown), `POST …/ops` writes, and `POST …/presence` shows a cursor or "thinking" status with a TTL. These go through the same validation and permissions as people. MCP tools will wrap them.
- **Docs today** are last-writer-wins per block, with presence showing who is in which block. Character-level merging inside a single block (a CRDT such as Yjs) is a later upgrade.
- **Portable runtime.** The Worker is a plain async module using only Workers, Durable Objects (SQLite) and static assets, so it runs on Cloudflare and on celld. Hosted agent runs are the exception: they use Cloudflare Containers, and they're off anywhere else.

## Tabs

The app shell keeps a set of open pages, like Notion's tabs. The URL is always the active tab, so links and reload work as they do without tabs.

- **One rule.** When the location changes, a tab already holding that address becomes active; otherwise the active tab takes the address (`apps/app/src/web/tabs-model.ts`). Links and `navigate()` need no changes. A pinned tab stays on its page, so a link followed from one opens a new tab.
- **Opening.** ⌘-click or middle-click any in-app link, ⌘↵ in search, or right-click a row in the sidebar or on Home. ⌥T, ⌥W, ⌥[ and ⌥] drive them from the keyboard, since browsers keep ⌘T and ⌘W. The strip is always there, and its + opens a tab with the mouse; small screens get a count button instead.
- **Hidden tabs hold no connection.** Artifact pages render in the shell under React's `<Activity>`: the last 5 keep their state while hidden, but their effects clean up, so the room's socket closes and nobody sees you on a page you left. `useRoom` keeps its client across this, so a page keeps its content until the cell answers.
- **Per viewer, per window.** Hrefs and pins are stored under `standard-artifacts:tabs:<org>:<actor>`: session storage for this window, local storage to start the next one. Nothing reaches the server. Share-link guests have no tabs.

## Access model

- **Who.** Every request resolves to a principal: an org, an actor and a role (`owner`, `editor` or `viewer`). An actor is a person (`usr_…`), an agent acting for a person, or a share-link guest. Cells trust only principals that arrive in short-lived HMAC tickets, since celld can only verify HMAC.
- **Dev mode** (`AUTH_MODE=dev`: `pnpm dev`, `stdartifacts serve`) has no sign-in. A request without credentials is the local owner, and the server only answers localhost.
- **Live mode with sign-in** (Standard Artifacts Cloud, or self-hosted with WorkOS; see [Self-hosting with sign-in](development.md#self-hosting-with-sign-in)). WorkOS is the account service and the source of truth for orgs, members and roles.
  - **Session.** `/api/auth/login` sends the browser to WorkOS AuthKit, and `/api/auth/callback` exchanges the code. The session is an httpOnly, SameSite=Lax cookie (Secure and `__Host-` prefixed, except over plain http to localhost) sealed with AES-GCM under `WORKOS_COOKIE_PASSWORD`. It holds the WorkOS refresh token plus the user, org and role from the latest access token. It never reaches a cell.
  - **Tickets.** The web app calls `POST /api/auth/ticket` for a 5-minute ticket and sends it as a bearer token, and as `?ticket=` on room and workspace sockets (browsers can't set headers on sockets). It asks again a minute before expiry, one tab at a time. When the WorkOS access token has under a minute left, minting refreshes it first (WorkOS rotates the refresh token, and the cookie keeps the new one), so a role change or removal reaches new tickets within minutes. The ticket is also set as a cookie, for `<img>` asset URLs, and that's all it opens: asset GETs.
  - **Ids.** A person is `usr_` plus their WorkOS user id without its `user_` prefix (`user_01HX…` → `usr_01HX…`). An org's id is its WorkOS organization id, which also names its WorkspaceCell.
  - **Orgs.** A session is scoped to one org. Someone signing in with none gets "<First name>'s workspace" as its owner. Switching (`POST /api/auth/switch`) asks WorkOS for a token in another of the person's orgs, and the app starts over there. The last org used is remembered for the next sign-in.
  - **Roles** come from WorkOS role slugs: `owner`, `editor` and `viewer` map to themselves, WorkOS's defaults `admin` and `member` map to owner and editor, and anything else is viewer. With several, the highest wins.
  - **Members.** Owners invite by email with a role (WorkOS invitations), resend or revoke invites, change roles and remove people (`/api/v1/org/*`). The last owner can't be removed or demoted. Every member can see the list. Owner actions are checked against WorkOS again before anything changes, and a membership or invitation from another org reads as not found.
  - **Plan** rides in the ticket. It comes from the WorkOS organization's `plan` metadata (`free` or `team`, default `free`), or, with billing on, from the org's WorkspaceCell, which Stripe's webhook updates. Share links and access tokens read it live too.
- **Access tokens** (`sat_…`) are for the CLI, MCP and scripts (`STDARTIFACTS_TOKEN`). A person creates one in Settings and sees it once. The org's WorkspaceCell keeps only a SHA-256 hash, scoped to that person and org, with their role. That role is checked with WorkOS every 5 minutes; a token whose owner left the org is deleted. With `x-dev-as: agent` (what `stdartifacts mcp` sends), a token acts as an agent for its owner, never above editor. Making a token takes the browser's session, not just a ticket, and a token can't manage members or make share links.
- **Connected agents** (remote MCP clients such as Claude, ChatGPT and Codex) sign in with OAuth: the Worker is the authorization server, and WorkOS the identity provider behind its consent page. A grant binds a person, an app and an org with "read and write" or "read only" access, under the person's current role and plan, and lives in the org's WorkspaceCell. Its tokens work only at `/mcp`. See [How sign-in works](cli-and-mcp.md#how-sign-in-works).
- **Agents** act on behalf of a person and don't take seats. Hosted runs get a 10-minute ticket for the person who asked, with that person's role under the plan now, never above editor. With billing on, hosted runs are for Team that's active, or trialing (25 runs per trial). Elsewhere a mention waits for the person's own agent; see [Hosted runs](agents.md#hosted-runs).
- **Guests.** A share link (`sh.…`) gives a read-only guest one artifact, signed in or not. Guests and viewers are read-only but still show presence.
- **Plans.** Free: one human who edits (the owner), plus unlimited agents and read-only share links. Team: multiplayer, billed per seat, where a seat is an Owner or an Editor; viewers, agents and tokens are free. With billing on (Cloud, Stripe; see [Billing](development.md#billing-cloud)):
  - Stripe is the source of truth for who pays, and a signed webhook mirrors the subscription into WorkOS org metadata.
  - Only a trialing or active subscription is Team. On Free, and while Team is past due or paused, adding an Editor or Owner answers `UpgradeRequired`, and Editors' tickets and tokens act as viewer. Their WorkOS role doesn't change, so it comes back once billing is fixed, and nothing is deleted.
  - With billing off (no Stripe settings), none of this applies: an Editor on a Free workspace edits, as before.
