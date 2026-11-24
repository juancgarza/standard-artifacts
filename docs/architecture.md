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

- **Cells.** Each artifact is one Durable Object with its own SQLite (plus `McpCell`, one per principal, for remote MCP sessions). `TrackerCell` keeps issues, runs and comments in one ordered list; the shared reducer numbers issues and stamps who created, started or wrote what. `RoomCell` is the shared base class. It applies ops in order, keeps an op log with each op's actor, and fans changes out over hibernatable WebSockets. It also tracks presence, including agent presence with a TTL that alarms expire. `TableCell` adds columns, rows and cells. `ListCell` handles ordered records (positions are fractional, so an insert writes one row), and `BoardCell` (shapes in z-order) and `DocCell` (blocks) build on it.
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

- An org account (a hosted auth provider signs people in and the Worker mints their HMAC tickets, since celld can only verify HMAC) or a guest. Sign-in isn't built yet.
- Free: one human seat, plus agents and read-only share links. Team (paid): multiplayer.
- Guests and viewers are read-only but still show presence. Agents act on behalf of a user and don't take seats.
