# Boards

A board is an infinite canvas of shapes: notes, boxes, text, frames, arrows, images, links to other artifacts, **design frames** and **HTML embeds**. This page follows one edit from an agent's tool call to pixels on everyone's screen. Every other surface works the same way.

```
agent ──MCP tool / CLI / HTTP──▶ Worker  POST /api/v1/artifacts/:id/ops
                                   │  auth → principal (org, actor, role)
                                   ▼
                         BoardCell (one Durable Object per board)
                         decode → reducer → one SQLite row per shape → broadcast
                                   │  WebSocket
                                   ▼
                browsers: the same reducer, applied optimistically → React
                  • design frame → real DOM in the app, allowlisted
                  • html embed   → sandboxed iframe (srcdoc + CSP)
```

## Ops

A board's state is a list of shapes, and the list order is the z-order. People and agents change it the same way, with **ops**: `insert`, `update`, `remove` and `move`, plus per-layer ops for design frames.

```sh
curl -X POST localhost:5173/api/v1/artifacts/b_…/ops -H 'content-type: application/json' -H 'x-dev-as: agent' \
  -d '{"ops":[{"type":"insert","item":{"id":"s_hello","kind":"note","x":0,"y":0,"w":200,"h":140,"text":"Hi"}}]}'
```

The MCP tools (`board_add`, `board_add_html`, `board_add_design`, `board_update_design`…) and the CLI (`stdartifacts board …`) produce the same ops. Design frames are converted on the client: `htmlToDesign` turns HTML into a node tree before anything is sent, so the wire carries a tree, not markup.

## The cell

The Worker resolves the board's cell, named `<org>:<artifact>` so one org can never address another's, and hands it the ops. For each op, `BoardCell`:

1. **Decodes** it with Effect Schema (`decodeBoardOp` in `packages/protocol/src/board.ts`). This bounds everything: coordinates within ±1,000,000, sizes up to 20,000, text up to 10,000 characters and embed source up to 200,000.
2. **Reduces** it with `applyBoardOp`. The reducer stamps `by` on new shapes (so authorship can't be forged), applies the design-frame allowlists, and removes arrows attached to a removed shape.
3. **Persists** it as one SQLite row per shape (`l_items`: id, fractional position, JSON), and appends the op and its actor to the cell's op log.
4. **Broadcasts** it to every connected browser.

Ops in a batch commit one at a time, and the batch stops at the first bad one. The error names it (`op 3: …`), and the ops before it stay applied.

A shape is one row, and Cloudflare's SQLite caps a row at 2 MB. That's why embed source is capped at 200,000 UTF-16 units: at most about 600 KB of UTF-8, with room for the rest of the row.

## The browser

`useRoom` (`packages/room`) keeps the server's confirmed state and the local ops that haven't been echoed back yet. The UI renders the confirmed state with the pending ops re-applied on top, so your edits show instantly. If the cell rejects one, it drops out. The reducer is plain TypeScript, so the browser, the cell, the CLI and the tests all run the same code.

Panning and zooming is one CSS transform on the world layer (`scale(zoom) translate(-x, -y)`). Shapes are absolutely positioned DOM in world coordinates. Labels that must stay readable get a counter-scale.

## Two kinds of HTML on a board

**Design frames** (`kind: "design"`) are editable mockups. Their content is real DOM inside the app: a flat map of nodes, each with a tag, text or children, inline styles and attributes (`packages/protocol/src/design.ts`).

- **The allowlists are the security boundary,** because the nodes render in the app's own document.
  - There are 26 tags and no scripts or event handlers.
  - CSS values are checked property by property. `var()`, `expression()`, `@import`, `position: fixed`, comments and escapes are rejected.
  - URLs must be https, or data: for images.
- **Converting HTML.** `htmlToDesign` is a tolerant parser:
  - It inlines `<style>` rules with simple selectors and resolves custom properties to plain values.
  - It turns `<svg>` into data-URI images.
  - It unwraps unknown tags but keeps their content.
  - It drops `script`, `iframe`, `object` and the like, along with their content.
  - Anything it doesn't allow disappears without an error, which is why the tools return an outline to check.
- **Rendering.** The renderer (`packages/board/src/design-frame.tsx`) filters through the same allowlists again, in case a frame was stored under older rules.
  - The frame box uses `contain: layout paint` and `isolation`, so nothing inside can paint over the app.
  - A small stylesheet restores browser defaults that the app's CSS reset removes.
- **Editing.** Every node has an id, written out as `data-node="…"`. Agents edit single layers with patches, inserts and removes, so people working on other layers keep their changes. Replacing a whole frame is last-writer-wins.

**HTML embeds** (`kind: "html"`) are live widgets, charts and prototypes, rendered in an iframe (`packages/board/src/html.ts`, `html-embed.tsx`).

- **Sandbox.** `sandbox="allow-scripts"` without `allow-same-origin` gives the embed an opaque origin.
  - It can't touch the app's DOM, cookies, storage or session.
  - It can't navigate the app, open popups, submit forms or call `alert()`.
- **CSP.** A Content-Security-Policy `<meta>` comes first in the document, so it applies before anything in the snippet runs.
  - Scripts and styles must be inline.
  - Images may load from `https:`, `data:` and `blob:`. Fonts load only from `data:`.
  - There's no fetch, XHR, WebSocket, frame or worker, so an embed looks the same for every viewer and can't phone home.
- **Leaving an embed.** Escape inside an embed posts a message to the board, which leaves interact mode. If the snippet navigates its own frame away, the board notices the second load and shows a notice instead.
- **Cost control.** At most 12 iframes are live at once: the ones nearest the centre of the view that are at least 90 px wide on screen. The rest show a placeholder.
- **Memoization.** The frame is memoized on its source, so panning and zooming never reload it or reset its state.

Pick a frame for a mockup people will edit, and an embed when it has to run code.

## Alignment

Dragging or resizing a shape snaps its edges and centre to its neighbours' and draws the line they share in red, as in Figma. Hold ⌘/Ctrl to place it freely.

Agents can't see that line, so they get the same answer as text. `board_check_alignment` lists:
- what lines up, with the gaps between;
- what sits just off a line others share;
- rows and columns that are nearly evenly spaced.

Each near miss comes with a fix, written as a `board_update` entry you can send as it stands. `board_add` and `board_update` also say so in their result when a shape lands just off a line. The canvas and the tool share one definition (`packages/protocol/src/alignment.ts`).

## Reading a board

- **`read_artifact`** returns a compact text form, one line per shape (`boardToText`). Embeds show their title and source length; frames show their layer count.
- **`board_get_html`** returns an embed's full source.
- **`board_get_design`** returns a frame's outline and its HTML with `data-node` ids, so an agent can edit it and send it back without breaking the ids of layers people have selected.
- **Layout** never shows up in text, so look at it: open `/boards/:id/:shapeId` in a browser, or use `stdartifacts shot`.
