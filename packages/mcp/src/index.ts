import { Config, Effect, Layer, Option, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { StandardArtifactsClient, CallerApp, type Client } from "@standard-artifacts/client"
import { type Artifact, ArtifactKind, BlockType, folderPath, searchArtifacts, parseFolderPath, type Folder, IssuePriority, IssueStatus, findIssue, issueStatuses, issuesOf as issuesOfState, touchedByRuns, priorityLabel, runsOf, commentsOf, runStateLabel, statusLabel, type Issue, type TrackerState, CellStatus, CellValue, ColumnType, DesignTagSchema, designFonts, maxDesignSize, maxHtmlLength, ShapeColor, type Presence, alignmentOf, alignmentText, nearMissText, DEFAULT_ALIGN_TOLERANCE } from "@standard-artifacts/protocol"

/**
 * MCP tools for agents, built on @standard-artifacts/client (and so on the HTTP API). They are
 * transport-agnostic: the CLI serves them over stdio (`stdartifacts mcp`), and the Worker
 * can serve the same toolkit over Streamable HTTP later.
 *
 * Every write also sets the agent's presence (status + what it's touching) so
 * people watching the artifact see the agent working.
 */

const d = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description })

const Ref = d(Schema.String, "Artifact id (b_…, t_…, d_…, i_…), its title, or its title after a folder path (Marketing/Launch/Press list)")
const FolderRef = d(Schema.String, "Folder id (f_…) or path (Marketing/Launch)")
const IssueRef = d(Schema.String, "Issue number (12 or #12) or id")
const Text = Schema.String

const tool = <const Name extends string, P extends Schema.Struct.Fields>(name: Name, description: string, parameters: P) =>
  Tool.make(name, { description, parameters: Schema.Struct(parameters), success: Text, failure: Text })

/** Read-only tools say so, so hosts can run them without asking. */
const readonly = <T extends Tool.Any>(t: T) => t.annotate(Tool.Readonly, true) as T

/** A link to an artifact's `stdartifacts://` resource, as MCP `resource_link` content. */
const ResourceLink = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
})

/**
 * Search for ChatGPT's composer @-mentions (OpenAI's `openai/mentions`
 * extension): people type "@" and pick a board, table or doc, which is attached
 * as a link to its `stdartifacts://` resource. The host calls it, not the model ("app"
 * visibility), but other clients may use it as a plain search.
 */
export const mentionSearchTool = "search_mentions"
const SearchMentions = Tool.make(mentionSearchTool, {
  description: "Search the workspace's boards, tables and docs by title. Returns links to their stdartifacts:// resources.",
  parameters: Schema.Struct({ query: d(Schema.String, "Search text; may be empty (most recently updated first)") }),
  success: Schema.Struct({ items: Schema.Array(ResourceLink) }),
  failure: Text,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Meta, { ui: { visibility: ["app"] } })

export const StandardArtifactsToolkit = Toolkit.make(
  readonly(
    tool("list_artifacts", "List the workspace's boards, tables and docs with their ids and the folder each is in.", {
      kind: Schema.optionalKey(ArtifactKind),
      folder: Schema.optionalKey(d(Schema.String, "Only what's directly in this folder (id or path); \"/\" is the workspace root")),
    }),
  ),
  SearchMentions,
  readonly(
    tool(
      "search_workspace",
      "Search everything in the workspace by meaning and keywords: doc text, table rows, board notes and issues. Use it when you don't know which artifact holds something. Hits give an artifact id and, for content matches, the item id (block, row or shape) or issue number to use with read_artifact and the edit tools.",
      {
        query: d(Schema.String, "What you're looking for, in plain words"),
        kind: Schema.optionalKey(ArtifactKind),
        limit: Schema.optionalKey(d(Schema.Number, "Most hits to return, up to 50 (default 20)")),
      },
    ),
  ),
  tool("create_artifact", "Create a board, table, doc or tracker (issues). Returns its id.", {
    kind: ArtifactKind,
    title: Schema.String,
    folder: Schema.optionalKey(d(Schema.String, "Folder path to put it in (Marketing/Launch), created if it's new; or a folder id")),
  }),
  readonly(
    Tool.make("list_folders", {
      description: "List the workspace's folders by path, with how many artifacts each holds directly. A folder's path is its namespace.",
      parameters: Tool.EmptyParams,
      success: Text,
      failure: Text,
    }),
  ),
  tool("create_folder", "Create a folder at a path, along with any missing parents. If it already exists, returns it.", {
    path: d(Schema.String, "e.g. Marketing/Launch. Names are unique among siblings, ignoring case."),
  }),
  tool("move_artifact", "Move an artifact into a folder (created if the path is new), or to the workspace root.", {
    artifact: Ref,
    folder: d(Schema.String, "Folder id or path; \"/\" is the workspace root"),
  }),
  tool("update_folder", "Rename a folder, move it under another folder, or both. Artifacts inside stay with it, though their paths change.", {
    folder: FolderRef,
    name: Schema.optionalKey(d(Schema.String, "New name (no slashes)")),
    parent: Schema.optionalKey(d(Schema.String, "New parent folder (id or path); \"/\" is the workspace root")),
  }),
  tool("delete_folder", "Delete a folder. No artifacts are deleted: everything inside moves up to its parent.", {
    folder: FolderRef,
  }),
  readonly(
    tool(
      "read_artifact",
      "Read an artifact's current content in a compact form: table rows by column id, board shapes with positions and connectors, or a doc as markdown. Ids in the output are what other tools take.",
      { artifact: Ref },
    ),
  ),
  tool(
    "set_presence",
    "Show what you're doing to people viewing the artifact: a short status and the item you're focused on (shape id, block id, or rowId:columnId). Clear it with ttl 0 when done.",
    {
      artifact: Ref,
      status: Schema.optionalKey(d(Schema.String, "e.g. 'Researching Ramp'")),
      focus: Schema.optionalKey(d(Schema.String, "Shape id, block id, or rowId:columnId")),
      ttl: Schema.optionalKey(d(Schema.Number, "Seconds to stay visible (default 30, 0 clears)")),
    },
  ),
  tool("table_add_rows", "Append rows to a table. Each row maps column name to value. Multi-select columns take an array of option names (or \"a, b\"). Artifact columns take a list of links: artifact ids, titles, app URLs, or t_abc#r_1 for one item in an artifact.", {
    artifact: Ref,
    rows: Schema.Array(Schema.Record(Schema.String, CellValue)),
  }),
  tool(
    "table_set_cells",
    "Set table cells by row id and column name. Values are converted to the column type (\"1,200\" → 1200 in Number columns); multi-select columns take an array of option names or \"a, b\"; artifact columns take a list of links (artifact ids, titles, app URLs, or t_abc#r_1 for one item). Use status 'running' while you research a cell and 'done' with sources when you fill it.",
    {
      artifact: Ref,
      cells: Schema.Array(
        Schema.Struct({
          row: d(Schema.String, "Row id (r_…)"),
          column: d(Schema.String, "Column name or id"),
          value: CellValue,
          status: Schema.optionalKey(CellStatus),
          sources: Schema.optionalKey(Schema.Array(d(Schema.String, "https:// URL"))),
        }),
      ),
    },
  ),
  tool("table_add_column", "Add a column. For select columns pass options (set multiSelect: true for a tag column that holds several); for agent columns pass the per-row prompt; artifact columns hold links to other artifacts or their items, including rows of this table.", {
    artifact: Ref,
    name: Schema.String,
    type: ColumnType,
    options: Schema.optionalKey(Schema.Array(Schema.String)),
    multiSelect: Schema.optionalKey(d(Schema.Boolean, "Select columns only: allow several options per cell")),
    prompt: Schema.optionalKey(Schema.String),
  }),
  tool(
    "board_add",
    "Add sticky notes or shapes to a board. Omit x/y to place them in a free column to the right of existing content. Returns the new shape ids, and says if one landed just off a line its neighbours share.",
    {
      artifact: Ref,
      items: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          kind: Schema.optionalKey(Schema.Literals(["note", "rect", "ellipse", "text", "frame"])),
          color: Schema.optionalKey(ShapeColor),
          x: Schema.optionalKey(Schema.Number),
          y: Schema.optionalKey(Schema.Number),
          w: Schema.optionalKey(Schema.Number),
          h: Schema.optionalKey(Schema.Number),
        }),
      ),
    },
  ),
  tool(
    "board_add_links",
    "Show other artifacts, or one item in them, on a board as read-only previews that open their source. People who can't open what's linked see only that the link isn't available. " +
      "Omit x/y to place them to the right of existing content. Returns the new shape ids; move, resize or connect them like any shape. To point one elsewhere, remove it and add another.",
    {
      artifact: Ref,
      links: d(Schema.Array(Schema.String).check(Schema.isMinLength(1)), "What to show: artifact titles, ids (t_abc), items (t_abc#r_1), or links copied from the app"),
      x: Schema.optionalKey(Schema.Number),
      y: Schema.optionalKey(Schema.Number),
    },
  ),
  tool("board_connect", "Draw a connector arrow between two shapes.", {
    artifact: Ref,
    from: d(Schema.String, "Shape id"),
    to: d(Schema.String, "Shape id"),
  }),
  tool(
    "board_add_html",
    "Add a live HTML embed to a board: a mockup, chart, widget or mini-app that people see and can interact with on the canvas. " +
      "The snippet runs in a sandboxed frame and must be self-contained: inline <style> and <script> only, no fetch/XHR or external scripts, stylesheets or fonts; " +
      "images may be https: or data: URLs. Draw charts with inline SVG or <canvas>. A fragment or a full document both work. " +
      "Omit x/y to place it to the right of existing content. Returns the new shape id; change it later with board_update (html, text for the title).",
    {
      artifact: Ref,
      html: d(Schema.String, `The snippet's source (max ${maxHtmlLength.toLocaleString("en-US")} characters)`),
      title: Schema.optionalKey(d(Schema.String, "Caption shown above the embed")),
      x: Schema.optionalKey(Schema.Number),
      y: Schema.optionalKey(Schema.Number),
      w: Schema.optionalKey(d(Schema.Number, "Width in board units (default 480)")),
      h: Schema.optionalKey(d(Schema.Number, "Height in board units (default 360)")),
    },
  ),
  readonly(
    tool(
      "board_get_html",
      "Read one html embed's full source (read_artifact only lists embeds). Use it before editing an embed so you can change parts instead of rewriting it.",
      { artifact: Ref, shape: d(Schema.String, "The html embed's shape id") },
    ),
  ),
  tool("board_update", "Move, resize, recolor or retext shapes, or replace an html embed's source. After a move or resize, the result says if a shape ended up just off a line its neighbours share, with the fix.", {
    artifact: Ref,
    shapes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        x: Schema.optionalKey(Schema.Number),
        y: Schema.optionalKey(Schema.Number),
        w: Schema.optionalKey(Schema.Number),
        h: Schema.optionalKey(Schema.Number),
        text: Schema.optionalKey(Schema.String),
        color: Schema.optionalKey(ShapeColor),
        html: Schema.optionalKey(d(Schema.String, "Html embeds only: the new source (same rules as board_add_html)")),
      }),
    ),
  }),
  readonly(
    tool(
      "board_check_alignment",
      "See what people see on the canvas as red alignment guides: which shapes line up, and which nearly do. " +
        "Lists shapes that share an edge or centre (left, center, right, top, middle, bottom) with the gaps between them, shapes that sit just off a line others share, and rows or columns whose gaps are nearly but not quite even. " +
        "Every near miss comes with a Fix to pass to board_update. Use it after laying shapes out, or to check that someone's board is tidy. Arrows are left out: they follow the shapes they connect.",
      {
        artifact: Ref,
        shapes: Schema.optionalKey(d(Schema.Array(Schema.String), "Only report on these shape ids (they're still compared with everything on the board). Default: all shapes")),
        tolerance: Schema.optionalKey(d(Schema.Number, `How far off, in board units, still counts as nearly aligned (default ${DEFAULT_ALIGN_TOLERANCE})`)),
      },
    ),
  ),
  tool(
    "board_add_design",
    "Add a design frame to a board: HTML/CSS turned into editable layers that render as real DOM on the canvas (people select layers, restyle them in an inspector and edit text in place). " +
      "Write plain HTML with inline style=\"\" or a <style> block: rules are inlined, with var(--tokens) replaced by their values and ::before/::after turned into layers (rules for :hover and other states, and @media, are skipped). Allowed tags: div section header footer nav main article aside span p h1-h4 strong em small a button img input label ul ol li hr; " +
      "others are unwrapped, an inline <svg> becomes an image, and script/iframe are dropped. CSS: layout (display flex/grid, gap, padding, margin, align/justify, grid-template-columns, position except fixed), size, transform, background (url() https or data images only), border, radius, box-shadow, opacity, clip-path, mask, and type " +
      `(color, font-size/weight, line-height, letter-spacing, text-align/transform/decoration; font-family from: ${designFonts.join(", ")}). No scripts, event handlers or animations. ` +
      "Omit x/y to place it to the right of existing content. Returns the frame's shape id and its layer outline.",
    {
      artifact: Ref,
      html: d(Schema.String, `The design as HTML (max ${maxDesignSize.toLocaleString("en-US")} characters once parsed)`),
      title: Schema.optionalKey(d(Schema.String, "Caption shown above the frame")),
      x: Schema.optionalKey(Schema.Number),
      y: Schema.optionalKey(Schema.Number),
      w: Schema.optionalKey(d(Schema.Number, "Width in board units (default 480)")),
      h: Schema.optionalKey(d(Schema.Number, "Height in board units (default 360)")),
    },
  ),
  readonly(
    tool(
      "board_get_design",
      "Read a design frame: an outline of its layers (one line per node: id, tag, text, styles) and its HTML with data-node=\"…\" ids. Use the ids with board_update_design; if you send the HTML back, keep the data-node attributes so layers people have selected keep their ids.",
      { artifact: Ref, shape: d(Schema.String, "The design frame's shape id") },
    ),
  ),
  tool(
    "board_update_design",
    "Edit a design frame. Prefer small edits: `patches` change single layers by id (style and attrs merge per property; null removes one; text replaces the text), `insert` adds HTML into a parent layer, `remove` deletes layers. " +
      "`html` replaces the whole frame (same rules as board_add_design). Each patch is its own op, so people editing other layers keep their changes. Move, resize or retitle the frame with board_update.",
    {
      artifact: Ref,
      shape: d(Schema.String, "The design frame's shape id"),
      html: Schema.optionalKey(d(Schema.String, "Replace the whole design with this HTML")),
      patches: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            node: d(Schema.String, "Layer id from board_get_design"),
            text: Schema.optionalKey(Schema.NullOr(Schema.String)),
            tag: Schema.optionalKey(DesignTagSchema),
            style: Schema.optionalKey(d(Schema.Record(Schema.String, Schema.NullOr(Schema.String)), 'CSS properties to set, e.g. {"background": "#111", "padding": null}')),
            attrs: Schema.optionalKey(d(Schema.Record(Schema.String, Schema.NullOr(Schema.String)), "src (https/data image), href (https, mailto:, #), alt, placeholder, type")),
          }),
        ),
      ),
      insert: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            parent: d(Schema.String, "Layer id to insert into"),
            index: Schema.optionalKey(d(Schema.Number, "Position among the parent's children (default: last)")),
            html: d(Schema.String, "HTML fragment; each top-level element becomes a layer"),
          }),
        ),
      ),
      remove: Schema.optionalKey(d(Schema.Array(Schema.String), "Layer ids to delete (with everything inside them)")),
    },
  ),
  tool("doc_append", "Append markdown to a doc (headings, lists, todos, quotes, code, dividers, images as ![caption](https://…) and read-only previews of other artifacts as ![[artifact id]] or ![[artifact id#shape, row or issue id]], each on its own line), at the end or after a block id.", {
    artifact: Ref,
    markdown: Schema.String,
    after: Schema.optionalKey(d(Schema.String, "Block id to insert after")),
  }),
  tool("doc_update_block", "Rewrite one doc block's text, type, or todo state.", {
    artifact: Ref,
    block: d(Schema.String, "Block id (k_…)"),
    text: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(BlockType),
    checked: Schema.optionalKey(Schema.Boolean),
  }),
  tool("remove_items", "Remove table rows, board shapes (and their connectors), doc blocks, or tracker issues (with their runs and comments) by id.", {
    artifact: Ref,
    ids: Schema.Array(Schema.String),
  }),
  // --- Trackers (issues worked by people and agents) ---
  readonly(
    tool(
      "my_issues",
      "Issues delegated to you (this app's agent: ChatGPT, Claude, Codex…) across every tracker, open ones first. Start here when you're asked to work your queue; then start_run on one.",
      { status: Schema.optionalKey(d(Schema.Literals(["open", "all"]), "Default open")) },
    ),
  ),
  readonly(
    tool("list_issues", "List a tracker's issues grouped by status, with owner, delegate, labels and runs.", {
      artifact: Ref,
      status: Schema.optionalKey(d(Schema.Literals(["open", "all"]), "Default open")),
    }),
  ),
  readonly(
    tool("get_issue", "One issue in full: description, properties, where it came from, what it links to (read those first), every run with its steps, and comments.", {
      artifact: Ref,
      issue: IssueRef,
    }),
  ),
  tool(
    "create_issue",
    "Create an issue in a tracker. The owner (accountable person) defaults to the person you act for; delegate it to yourself (\"me\"), another agent (claude, chatgpt, codex) or a person. Say where it came from with `from` when you made it out of another artifact's item.",
    {
      artifact: Ref,
      title: Schema.String,
      description: Schema.optionalKey(d(Schema.String, "Markdown")),
      status: Schema.optionalKey(IssueStatus),
      priority: Schema.optionalKey(IssuePriority),
      labels: Schema.optionalKey(Schema.Array(Schema.String)),
      owner: Schema.optionalKey(d(Schema.String, "\"me\" or a person's name")),
      delegate: Schema.optionalKey(d(Schema.String, "\"me\", an agent (claude, chatgpt, codex) or a person's name")),
      due: Schema.optionalKey(d(Schema.String, "YYYY-MM-DD")),
      links: Schema.optionalKey(d(Schema.Array(Schema.String), 'What it\'s about: boards, tables, docs or trackers (ids or titles), or "#12" for another issue in this tracker')),
      from: Schema.optionalKey(
        Schema.Struct({
          artifact: d(Schema.String, "The artifact it came from (id or title)"),
          item: Schema.optionalKey(d(Schema.String, "Shape, block or row id in it")),
        }),
      ),
    },
  ),
  tool("update_issue", "Change an issue: title, description, status, priority, labels, owner, delegate (null clears), due date, and its links to other artifacts and issues.", {
    artifact: Ref,
    issue: IssueRef,
    title: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(IssueStatus),
    priority: Schema.optionalKey(IssuePriority),
    labels: Schema.optionalKey(Schema.Array(Schema.String)),
    owner: Schema.optionalKey(Schema.NullOr(Schema.String)),
    delegate: Schema.optionalKey(Schema.NullOr(Schema.String)),
    due: Schema.optionalKey(Schema.NullOr(Schema.String)),
    link: Schema.optionalKey(d(Schema.Array(Schema.String), 'Add links: artifact ids or titles, or "#12" for another issue here')),
    unlink: Schema.optionalKey(d(Schema.Array(Schema.String), "Remove links, named the same way")),
  }),
  tool("comment_issue", "Comment on an issue (markdown).", { artifact: Ref, issue: IssueRef, text: Schema.String }),
  tool(
    "start_run",
    "Start working an issue: records a run on it (you, the app you run in, the time) and moves it to In progress. While the run is open, every change you make with this server's tools is logged as a step on it automatically; add log_step for anything else worth knowing (what you read, decisions). Finish with complete_run.",
    { artifact: Ref, issue: IssueRef, model: Schema.optionalKey(d(Schema.String, "The model you are, if you know it")) },
  ),
  tool("log_step", "Add a step to your open run: something you did or found that the automatic steps don't show.", {
    text: d(Schema.String, "One line, e.g. 'Read the Launch memo; pricing section is out of date'"),
    artifact: Schema.optionalKey(d(Schema.String, "An artifact this step is about (id or title)")),
    items: Schema.optionalKey(d(Schema.Array(Schema.String), "Ids of what it touched in that artifact")),
  }),
  tool(
    "complete_run",
    "Finish your open run with a summary of what you did and what's left. Use needs_review when a person should check the work (the default), done when nothing needs checking, failed when you couldn't do it. Moves the issue to In review or Done to match.",
    {
      summary: d(Schema.String, "Markdown: what you did, links or ids of what you changed, open questions"),
      state: Schema.optionalKey(Schema.Literals(["needs_review", "done", "failed"])),
    },
  ),
)

// --- Tracker text -------------------------------------------------------------------

const isOpen = (i: Issue) => issueStatuses.find((s) => s.id === i.status)?.open ?? true

/** One line per issue, for lists. */
function issueLine(i: Issue, state: TrackerState) {
  const runs = runsOf(state, i.id)
  const last = runs.at(-1)
  return [
    `#${i.number} ${i.title}`,
    `[${statusLabel(i.status)}]`,
    i.priority !== "none" ? `[${priorityLabel(i.priority)}]` : "",
    i.owner ? `owner ${i.owner.name}` : "",
    i.delegate ? `delegate ${i.delegate.name}${i.delegate.type === "agent" ? " (agent)" : ""}` : "",
    i.labels?.length ? `labels ${i.labels.join(", ")}` : "",
    i.due ? `due ${i.due}` : "",
    last ? `last run ${runStateLabel[last.state]} by ${last.agent.name}` : "",
    `id ${i.id}`,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Everything about one issue, for get_issue and its stdartifacts:// resource. */
function issueDetail(i: Issue, state: TrackerState, titles: ReadonlyMap<string, Artifact> = new Map(), trackerId?: string) {
  const src = i.source
  const name = (id: string) => {
    const a = titles.get(id)
    return a ? `${a.title} (${a.kind} ${id})` : id
  }
  const linkName = (l: NonNullable<Issue["links"]>[number]) => {
    if (!l.item) return name(l.artifactId)
    const other = issuesOfState(state).find((x) => x.id === l.item)
    return other ? `#${other.number} ${other.title} (issue here)` : `${l.item} in ${name(l.artifactId)}`
  }
  const touched = touchedByRuns(state, i.id, trackerId)
  const out = [
    `#${i.number} ${i.title} (${i.id})`,
    `Status ${statusLabel(i.status)} · Priority ${priorityLabel(i.priority)} · Owner ${i.owner?.name ?? "none"} · Delegate ${i.delegate ? `${i.delegate.name}${i.delegate.type === "agent" ? " (agent)" : ""}` : "none"}${i.labels?.length ? ` · Labels ${i.labels.join(", ")}` : ""}${i.due ? ` · Due ${i.due}` : ""}`,
    `Created by ${i.createdByName ?? i.createdBy ?? "someone"} ${src.client ? `via ${src.client}` : `via ${src.via}`}${src.from ? ` from ${src.from.title ?? src.from.artifactId}${src.from.item ? ` (${src.from.item})` : ""}` : ""} at ${i.createdAt}`,
    ...(i.links?.length ? [`Linked: ${i.links.map(linkName).join("; ")}`] : []),
    ...(touched.length ? [`Touched by runs: ${touched.map(name).join("; ")}`] : []),
    "",
    i.description || "(no description)",
  ]
  for (const r of runsOf(state, i.id)) {
    out.push("", `Run ${r.id}: ${r.agent.name}${r.client && r.client !== r.agent.name ? ` via ${r.client}` : ""} · ${runStateLabel[r.state]} · started ${r.startedAt}${r.endedAt ? ` · ended ${r.endedAt}` : ""}`)
    for (const st of r.steps) out.push(`  - ${st.text}${st.ok === false ? " (failed)" : ""}`)
    if (r.summary) out.push(`  Summary: ${r.summary}`)
  }
  const comments = commentsOf(state, i.id)
  if (comments.length) out.push("", "Comments:", ...comments.map((c) => `  ${c.name ?? "someone"} (${c.at}): ${c.text}`))
  return out.join("\n")
}

/** Over MCP, "me" as a delegate is the calling app's agent (ChatGPT, Codex…), not the account it signs in with. */
const asMe = (ref: string, who: { readonly agent: string }) => (ref.trim().toLowerCase() === "me" ? who.agent : ref)

/**
 * The app on the other end of an MCP session, from `clientInfo.name`, and the
 * agent that stands for it: issues delegated to that agent are "mine".
 */
export function clientOf(name: string | undefined): { readonly agent: string; readonly name: string } {
  const n = (name ?? "").toLowerCase()
  if (n.includes("openai") || n.includes("chatgpt")) return { agent: "chatgpt", name: "ChatGPT" }
  if (n.includes("codex")) return { agent: "codex", name: "Codex" }
  if (n.includes("claude-code") || n.includes("claude code")) return { agent: "claude", name: "Claude Code" }
  if (n.includes("claude") || n === "") return { agent: "claude", name: "Claude" }
  if (n.includes("cursor")) return { agent: "cursor", name: "Cursor" }
  return { agent: n.replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "agent", name: (name ?? "Agent").slice(0, 80) }
}

export const StandardArtifactsToolkitLive = StandardArtifactsToolkit.toLayer(
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    /** One presence identity per server, so an agent session shows up as one cursor. (Made here, not at import: Workers forbid randomness in global scope.) */
    const runId = `mcp-${crypto.randomUUID().slice(0, 8)}`
    // Set by the mention runner: doc writes from this server become reviewable suggestions for that request.
    const suggestFor = yield* Config.option(Config.String("STDARTIFACTS_SUGGEST_MENTION")).pipe(Effect.orDie)
    const suggest = Option.match(suggestFor, { onNone: () => undefined, onSome: (mentionId) => ({ by: "agent", mentionId }) })

    /** Translate a focus string into the presence shape each surface understands. */
    const focusPresence = Effect.fn("Mcp.focus")(function* (ref: string, focus: string | undefined) {
      const none: Presence = {}
      if (!focus) return none
      const c = yield* client.read(ref)
      let at: Presence = none
      if (c.kind === "board") {
        const s = c.state.items.find((i) => i.id === focus)
        if (s) at = { selection: [s.id], cursor: { x: s.x + s.w / 2, y: s.y + s.h / 2 } }
      } else if (c.kind === "doc") {
        at = { blockId: focus }
      } else if (c.kind === "tracker") {
        const i = findIssue(c.state, focus)
        if (i) at = { issueId: i.id }
      } else {
        const [rowId, colRef] = focus.split(":")
        const col = c.state.columns.find((x) => x.id === colRef || x.name === colRef)
        if (rowId && col) at = { selection: { rowId, colId: col.id } }
      }
      return at
    })

    /**
     * Open runs, per MCP session: while one is open, every write through
     * `working` is logged on it as a step, so an agent's record doesn't depend
     * on it remembering to report.
     */
    const runs = new WeakMap<object, { readonly tracker: string; readonly run: string; readonly issue: string }>()
    const session = Effect.serviceOption(McpSchema.McpRequestContext).pipe(Effect.map(Option.getOrUndefined))
    /**
     * Which session a call belongs to. Over HTTP every POST gets its own client
     * id, but a session's negotiated `clientInfo` is one object for its
     * lifetime, so it keys the session. (Stdio has a single session.)
     */
    const fallback = {}
    const sessionKey = (ctx: McpSchema.McpRequestContext["Service"] | undefined): object => ctx?.clientInfo ?? fallback
    const openRun = Effect.map(session, (ctx) => runs.get(sessionKey(ctx)))

    /** Best-effort "agent is working" presence around a write, plus a step on the open run. Never fails the tool. */
    const working = <A, E>(ref: string, status: string, focus: string | undefined, write: Effect.Effect<A, E>, items?: (a: A) => ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const a = yield* client.resolve(ref)
        const at = yield* focusPresence(a.id, focus).pipe(Effect.orElseSucceed((): Presence => ({})))
        yield* client.presence(a.id, runId, { thinking: true, status, ...at }, 20).pipe(Effect.ignore)
        const result = yield* write.pipe(
          Effect.tapError(() =>
            Effect.flatMap(openRun, (r) => (r ? client.tracker.logStep(r.tracker, r.run, { text: `${status} in ${a.title} (failed)`, artifactId: a.id, ok: false }).pipe(Effect.ignore) : Effect.void)),
          ),
        )
        yield* client.presence(a.id, runId, { status: "Done", ...at }, 8).pipe(Effect.ignore)
        const r = yield* openRun
        if (r) {
          const touched = items?.(result) ?? (focus ? [focus] : [])
          yield* client.tracker.logStep(r.tracker, r.run, { text: `${status} in ${a.title}`, artifactId: a.id, ...(touched.length && { items: touched.slice(0, 50) }) }).pipe(Effect.ignore)
        }
        return result
      })

    /** Which app is on the other end of this session, and the agent that stands for it. */
    const caller = Effect.map(session, (ctx) => clientOf(ctx?.clientInfo?.name))

    /** Every tool runs through here, so all its API calls say which app they're for. */
    const run = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
      Effect.flatMap(caller, (who) => effect.pipe(Effect.provideService(CallerApp, who.name), Effect.mapError((e) => e.message)))
    const ids = (xs: ReadonlyArray<string>) => xs.join(", ")

    /**
     * After placing or moving shapes: the ones now just off a line their
     * neighbours share, so an agent learns it without asking (a person would
     * have seen the guide while dragging). Empty when all is well; never fails the tool.
     */
    const offLine = (ref: string, touched: ReadonlyArray<string>) =>
      client.read(ref).pipe(
        Effect.map((c) => {
          if (c.kind !== "board" || !touched.length) return ""
          const near = alignmentOf(c.state, { ids: touched }).near
          if (!near.length) return ""
          const shown = near.slice(0, 3).map((m) => `- ${nearMissText(c.state, m)}`)
          return `\n\nAlmost aligned${near.length > shown.length ? ` (${near.length - shown.length} more in board_check_alignment)` : ""}:\n${shown.join("\n")}`
        }),
        Effect.orElseSucceed(() => ""),
      )

    return {
      search_mentions: ({ query }) =>
        run(
          Effect.gen(function* () {
            const all = yield* client.list()
            const items = searchArtifacts(all, query).map(resourceLink)
            // Issues too ("#12", "pricing"), from the most recently updated trackers.
            if (query.trim()) {
              const trackers = all.filter((a) => a.kind === "tracker").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
              for (const t of trackers) {
                const c = yield* client.tracker.issues(t.id).pipe(Effect.orElseSucceed(() => undefined))
                if (c) items.push(...searchIssues(c.issues, query).map((i) => issueLink(t, i)))
              }
            }
            return { items: items.slice(0, 25) }
          }),
        ),
      search_workspace: ({ query, kind, limit }) =>
        run(
          client.search(query, { kind, limit }).pipe(
            Effect.map(({ hits, mode }) => {
              const note = mode === "title" ? "Only titles were searched: content search isn't available right now.\n\n" : ""
              if (!hits.length) return `${note}No matches for "${query}".`
              const lines = hits.map((h) => {
                const head = `${h.artifact.id}  ${h.artifact.kind}  ${h.artifact.title}`
                return h.item === undefined ? head : `${head}  item ${h.item}\n  ${h.text ?? ""}`
              })
              return `${note}${lines.join("\n")}`
            }),
          ),
        ),
      list_artifacts: ({ kind, folder }) =>
        run(
          Effect.gen(function* () {
            const folders = yield* client.folder.list()
            const inside = folder === undefined ? undefined : parseFolderPath(folder).length ? (yield* client.folder.resolve(folder)).id : null
            const all = yield* client.list(kind)
            const shown = inside === undefined ? all : all.filter((a) => (a.folderId ?? null) === inside)
            if (!shown.length) return inside === undefined ? "No artifacts yet." : "Nothing here."
            return shown.map((a) => `${a.id}  ${a.kind}  ${a.title}${a.folderId ? `  (in ${folderPath(folders, a.folderId)})` : ""}`).join("\n")
          }),
        ),
      create_artifact: ({ kind, title, folder }) =>
        run(
          Effect.gen(function* () {
            const who = yield* caller
            const parent = folder && parseFolderPath(folder).length ? yield* client.folder.ensure(folder) : undefined
            const a = yield* client.create(kind, title, who.name, parent?.id)
            const folders = parent ? yield* client.folder.list() : []
            return `Created ${a.kind} ${a.id} "${a.title}"${parent ? ` in ${folderPath(folders, parent.id)}` : ""}`
          }),
        ),
      list_folders: () =>
        run(
          Effect.gen(function* () {
            const folders = yield* client.folder.list()
            if (!folders.length) return "No folders yet."
            const all = yield* client.list()
            return folders
              .map((f) => ({ f, path: folderPath(folders, f.id) }))
              .sort((a, b) => a.path.localeCompare(b.path))
              .map(({ f, path }) => {
                const n = all.filter((a) => a.folderId === f.id).length
                return `${f.id}  ${path}  (${n} artifact${n === 1 ? "" : "s"})`
              })
              .join("\n")
          }),
        ),
      create_folder: ({ path }) =>
        run(
          Effect.gen(function* () {
            const f = yield* client.folder.ensure(path)
            return `Folder ${f.id} ${folderPath(yield* client.folder.list(), f.id)}`
          }),
        ),
      move_artifact: ({ artifact, folder }) =>
        run(
          Effect.gen(function* () {
            const a = yield* client.folder.move(artifact, folder)
            return a.folderId ? `Moved "${a.title}" to ${folderPath(yield* client.folder.list(), a.folderId)}` : `Moved "${a.title}" to the workspace root`
          }),
        ),
      update_folder: ({ folder, name, parent }) =>
        run(
          Effect.gen(function* () {
            const f = yield* client.folder.update(folder, { name, parent })
            return `Folder ${f.id} is now ${folderPath(yield* client.folder.list(), f.id)}`
          }),
        ),
      delete_folder: ({ folder }) =>
        run(
          client.folder.remove(folder).pipe(Effect.map((f: Folder) => `Deleted folder "${f.name}". What was inside moved up to its parent.`)),
        ),
      read_artifact: ({ artifact }) =>
        run(client.read(artifact).pipe(Effect.map((c) => `${c.kind} ${c.artifact.id} "${c.artifact.title}" (rev ${c.seq})\n\n${c.text}`))),
      set_presence: ({ artifact, status, focus, ttl }) =>
        run(
          Effect.gen(function* () {
            const a = yield* client.resolve(artifact)
            const at = yield* focusPresence(a.id, focus)
            yield* client.presence(a.id, runId, { thinking: !!status, ...(status ? { status } : {}), ...at }, ttl ?? 30)
            return ttl === 0 ? "Presence cleared" : "Presence set"
          }),
        ),
      table_add_rows: ({ artifact, rows }) =>
        run(working(artifact, `Adding ${rows.length} row${rows.length === 1 ? "" : "s"}`, undefined, client.table.addRows(artifact, rows)).pipe(Effect.map((r) => `Added rows: ${ids(r.rowIds)}`))),
      table_set_cells: ({ artifact, cells }) =>
        run(
          working(artifact, `Filling ${cells.length} cell${cells.length === 1 ? "" : "s"}`, cells[0] && `${cells[0].row}:${cells[0].column}`, client.table.setCells(artifact, cells)).pipe(
            Effect.map((r) => `Updated ${r.applied} cell${r.applied === 1 ? "" : "s"}`),
          ),
        ),
      table_add_column: ({ artifact, ...column }) =>
        run(working(artifact, `Adding column ${column.name}`, undefined, client.table.addColumn(artifact, column)).pipe(Effect.map((id) => `Added column ${column.name} (${id})`))),
      board_add: ({ artifact, items }) =>
        run(
          working(artifact, `Adding ${items.length} item${items.length === 1 ? "" : "s"}`, undefined, client.board.add(artifact, items)).pipe(
            Effect.flatMap((r) => {
              const added = r.shapes.map((s) => s.id)
              // Only shapes the agent placed itself can be off: the free column lines the rest up.
              const placed = added.filter((_, i) => items[i]?.x !== undefined || items[i]?.y !== undefined)
              return Effect.map(offLine(r.artifact.id, placed), (hint) => `Added shapes: ${ids(added)}${hint}`)
            }),
          ),
        ),
      board_add_links: ({ artifact, links, ...at }) =>
        run(working(artifact, `Linking ${links.length} artifact${links.length === 1 ? "" : "s"}`, undefined, client.board.addLinks(artifact, links, at)).pipe(Effect.map((r) => `Added links: ${ids(r.shapes.map((s) => s.id))}`))),
      board_connect: ({ artifact, from, to }) =>
        run(working(artifact, "Connecting ideas", to, client.board.connect(artifact, from, to)).pipe(Effect.map((id) => `Connected ${from} -> ${to} (${id})`))),
      board_get_html: ({ artifact, shape }) =>
        run(
          client.read(artifact).pipe(
            Effect.flatMap((c) => {
              const s = c.kind === "board" ? c.state.items.find((i) => i.id === shape) : undefined
              return s && s.kind === "html" && typeof s.html === "string"
                ? Effect.succeed(`html embed ${s.id} "${s.text ?? ""}" (${s.html.length} chars)\n\n${s.html}`)
                : Effect.fail({ message: `No html embed "${shape}" on this board` })
            }),
          ),
        ),
      board_add_html: ({ artifact, html, title, ...at }) =>
        run(
          working(artifact, "Building an HTML embed", undefined, client.board.addHtml(artifact, { html, ...(title !== undefined && { title }), ...at })).pipe(
            // The shape doesn't exist until the write lands, so point the agent's presence at it afterwards.
            Effect.tap(({ artifact: a, shape: s }) =>
              client.presence(a.id, runId, { status: "Added an HTML embed", selection: [s.id], cursor: { x: s.x + s.w / 2, y: s.y + s.h / 2 } }, 8).pipe(Effect.ignore),
            ),
            Effect.map(({ shape }) => `Added html embed ${shape.id} "${shape.text}" at (${Math.round(shape.x)},${Math.round(shape.y)}) ${shape.w}x${shape.h}`),
          ),
        ),
      board_add_design: ({ artifact, html, title, ...at }) =>
        run(
          working(artifact, "Designing", undefined, client.board.addDesign(artifact, { html, ...(title !== undefined && { title }), ...at })).pipe(
            // The frame doesn't exist until the write lands, so point the agent's presence at it afterwards.
            Effect.tap(({ artifact: a, shape: s }) =>
              // The cursor waits at the frame's top-right corner: its label would cover the design at the centre.
              client.presence(a.id, runId, { status: "Added a design", selection: [s.id], cursor: { x: s.x + s.w, y: s.y } }, 8).pipe(Effect.ignore),
            ),
            Effect.map(({ shape, outline }) => `Added design frame ${shape.id} "${shape.text}" at (${Math.round(shape.x)},${Math.round(shape.y)}) ${shape.w}x${shape.h}\n\nLayers:\n${outline}`),
          ),
        ),
      board_get_design: ({ artifact, shape }) =>
        run(
          client.board
            .getDesign(artifact, shape)
            .pipe(Effect.map((r) => `design frame ${r.shape.id} "${r.shape.text ?? ""}" (${Object.keys(r.tree.nodes).length} layers)\n\nLayers:\n${r.outline}\n\nHTML:\n${r.htmlWithIds}`)),
        ),
      board_update_design: ({ artifact, shape, html, patches, insert, remove }) => {
        /** The first layer this edit touches, outlined in the agent's color for people watching. */
        const node = patches?.[0]?.node ?? insert?.[0]?.parent
        return run(
          working(
            artifact,
            "Editing a design",
            shape,
            client.board.updateDesign(artifact, shape, {
              ...(html !== undefined && { html }),
              ...(patches && { patches }),
              ...(insert && { insert }),
              ...(remove && { remove }),
            }),
          ).pipe(
            Effect.tap(({ artifact: a, shape: s, inserted }) => {
              const focus = inserted[0] ?? node
              return client
                // The layer outline shows where the agent worked; the cursor stays at the corner so its label doesn't cover that layer.
                .presence(a.id, runId, { status: "Edited a design", selection: [s.id], cursor: { x: s.x + s.w, y: s.y }, ...(focus && { design: { shape: s.id, node: focus } }) }, 8)
                .pipe(Effect.ignore)
            }),
            Effect.map((r) => `Applied ${r.applied} change${r.applied === 1 ? "" : "s"} to ${shape}${r.inserted.length ? `; new layers: ${r.inserted.join(", ")}` : ""}`),
          ),
        )
      },
      board_update: ({ artifact, shapes }) =>
        run(
          working(artifact, "Rearranging", shapes[0]?.id, client.board.update(artifact, shapes)).pipe(
            Effect.flatMap((r) => {
              const moved = shapes.filter((s) => s.x !== undefined || s.y !== undefined || s.w !== undefined || s.h !== undefined).map((s) => s.id)
              return Effect.map(offLine(artifact, moved), (hint) => `Updated ${r.applied} shape${r.applied === 1 ? "" : "s"}${hint}`)
            }),
          ),
        ),
      board_check_alignment: ({ artifact, shapes, tolerance }) =>
        run(
          client.read(artifact).pipe(
            Effect.flatMap((c) => {
              if (c.kind !== "board") return Effect.fail({ message: `"${c.artifact.title}" is a ${c.kind}, not a board` })
              const unknown = shapes?.find((id) => !c.state.items.some((s) => s.id === id && s.kind !== "arrow"))
              if (unknown !== undefined) return Effect.fail({ message: `No shape "${unknown}" on this board (arrows don't count)` })
              return Effect.succeed(`board ${c.artifact.id} "${c.artifact.title}" (rev ${c.seq})\n\n${alignmentText(c.state, alignmentOf(c.state, { ids: shapes, tolerance }))}`)
            }),
          ),
        ),
      doc_append: ({ artifact, markdown, after }) =>
        run(
          working(artifact, "Writing", after, client.doc.appendMarkdown(artifact, markdown, after, suggest)).pipe(
            Effect.map((r) => `Appended blocks: ${ids(r.blockIds)}${suggest ? " (as a suggestion for the person to accept)" : ""}`),
          ),
        ),
      doc_update_block: ({ artifact, block, ...patch }) =>
        run(
          working(artifact, "Editing", block, client.doc.updateBlock(artifact, block, patch, suggest)).pipe(
            Effect.map(() => `Updated ${block}${suggest && patch.text !== undefined ? " (as a suggestion: the original is kept until accepted)" : ""}`),
          ),
        ),
      remove_items: ({ artifact, ids: xs }) =>
        run(working(artifact, `Removing ${xs.length}`, undefined, client.removeItems(artifact, xs)).pipe(Effect.map((r) => `Removed (${r.applied} op)`))),

      my_issues: ({ status }) =>
        run(
          Effect.gen(function* () {
            const who = yield* caller
            const trackers = yield* client.list("tracker")
            const lines: Array<string> = []
            for (const t of trackers) {
              const c = yield* client.tracker.issues(t.id)
              const mine = c.issues.filter((i) => i.delegate?.type === "agent" && i.delegate.id === who.agent && (status === "all" || isOpen(i)))
              for (const i of mine) lines.push(`${t.title} (${t.id}) ${issueLine(i, c.state)}`)
            }
            return lines.length ? lines.join("\n") : `Nothing is delegated to ${who.name} right now.`
          }),
        ),
      list_issues: ({ artifact, status }) =>
        run(
          client.tracker.issues(artifact).pipe(
            Effect.map(({ artifact: a, issues, state }) => {
              const shown = issues.filter((i) => status === "all" || isOpen(i))
              if (!shown.length) return `${a.title} (${a.id}): no ${status === "all" ? "" : "open "}issues.`
              return [`${a.title} (${a.id})`, ...issueStatuses.flatMap((g) => {
                const group = shown.filter((i) => i.status === g.id)
                return group.length ? [`## ${g.label}`, ...group.map((i) => issueLine(i, state))] : []
              })].join("\n")
            }),
          ),
        ),
      get_issue: ({ artifact, issue }) =>
        run(
          Effect.gen(function* () {
            const { artifact: t, state } = yield* client.tracker.issues(artifact)
            const i = findIssue(state, issue)
            if (!i) return yield* Effect.fail({ message: `No issue "${issue}"` })
            const all = yield* client.list()
            return issueDetail(i, state, new Map(all.map((a) => [a.id, a])), t.id)
          }),
        ),
      create_issue: ({ artifact, from, ...input }) =>
        run(
          Effect.gen(function* () {
            const who = yield* caller
            const source = from
              ? yield* client.resolve(from.artifact).pipe(Effect.map((a) => ({ artifactId: a.id, title: a.title, ...(from.item && { item: from.item }) })))
              : undefined
            const r = yield* working(
              artifact,
              `Creating issue "${input.title}"`,
              undefined,
              client.tracker.create(artifact, { ...input, ...(input.delegate !== undefined && { delegate: asMe(input.delegate, who) }), by: who.name, source: { via: "mcp", client: who.name, ...(source && { from: source }) } }),
              (x) => [x.issue.id],
            )
            return `Created #${r.issue.number} ${r.issue.title} (${r.issue.id}) in ${r.artifact.title}${r.issue.delegate ? `, delegated to ${r.issue.delegate.name}` : ""}`
          }),
        ),
      update_issue: ({ artifact, issue, ...input }) =>
        run(
          Effect.flatMap(caller, (who) =>
            working(
              artifact,
              `Updating issue ${issue}${input.status ? ` to ${statusLabel(input.status)}` : ""}`,
              issue,
              client.tracker.update(artifact, issue, { ...input, ...(input.delegate !== undefined && { delegate: input.delegate === null ? null : asMe(input.delegate, who) }) }),
              (x) => [x.issue.id],
            ),
          ).pipe(
            Effect.map((r) => `Updated #${r.issue.number}`),
          ),
        ),
      comment_issue: ({ artifact, issue, text }) =>
        run(
          Effect.flatMap(caller, (who) => working(artifact, `Commenting on issue ${issue}`, issue, client.tracker.comment(artifact, issue, text, who.name), (x) => [x.issue.id])).pipe(
            Effect.map((r) => `Commented on #${r.issue.number}`),
          ),
        ),
      start_run: ({ artifact, issue, model }) =>
        run(
          Effect.gen(function* () {
            const ctx = yield* session
            const who = yield* caller
            const prev = runs.get(sessionKey(ctx))
            if (prev) return yield* Effect.fail({ message: `You already have an open run on issue ${prev.issue}; complete_run it first.` })
            const r = yield* client.tracker.startRun(artifact, issue, { client: who.name, agentName: who.name, ...(model && { model }) })
            runs.set(sessionKey(ctx), { tracker: r.artifact.id, run: r.run.id, issue: `#${r.issue.number}` })
            if (r.issue.status === "todo" || r.issue.status === "backlog") yield* client.tracker.update(r.artifact.id, r.issue.id, { status: "in_progress" })
            yield* client.presence(r.artifact.id, runId, { thinking: true, status: `Working #${r.issue.number}`, issueId: r.issue.id }, 60).pipe(Effect.ignore)
            return `Started run ${r.run.id} on #${r.issue.number} ${r.issue.title}. Your changes are logged on it; call complete_run when you're done.`
          }),
        ),
      log_step: ({ text, artifact, items }) =>
        run(
          Effect.gen(function* () {
            const r = yield* openRun
            if (!r) return yield* Effect.fail({ message: "No open run. Call start_run on an issue first." })
            const a = artifact ? yield* client.resolve(artifact) : undefined
            yield* client.tracker.logStep(r.tracker, r.run, { text, ...(a && { artifactId: a.id }), ...(items?.length && { items: items.slice(0, 50) }) })
            return "Logged"
          }),
        ),
      complete_run: ({ summary, state }) =>
        run(
          Effect.gen(function* () {
            const ctx = yield* session
            const r = runs.get(sessionKey(ctx))
            if (!r) return yield* Effect.fail({ message: "No open run. Call start_run on an issue first." })
            const outcome = state ?? "needs_review"
            yield* client.tracker.completeRun(r.tracker, r.run, { state: outcome, summary })
            runs.delete(sessionKey(ctx))
            const c = yield* client.tracker.issues(r.tracker)
            const i = findIssue(c.state, r.issue)
            const next = outcome === "needs_review" ? "in_review" : outcome === "done" ? "done" : undefined
            if (i && next && isOpen(i)) yield* client.tracker.update(r.tracker, i.id, { status: next })
            yield* client.presence(r.tracker, runId, {}, 0).pipe(Effect.ignore)
            return `Run ${r.run} on ${r.issue} is ${runStateLabel[outcome]}.`
          }),
        ),
    }
  }),
)

// --- resources ----------------------------------------------------------------------

/** Each artifact is readable as `stdartifacts://<kind>/<id>`: the same compact text `read_artifact` returns. */
export const resourceUri = (a: Pick<Artifact, "kind" | "id">) => `stdartifacts://${a.kind}/${a.id}`

const kindNames = { board: "Board", table: "Table", doc: "Doc", tracker: "Tracker" } as const

export const resourceLink = (a: Artifact): typeof ResourceLink.Type => ({
  type: "resource_link",
  uri: resourceUri(a),
  name: a.title,
  title: a.title,
  description: `${kindNames[a.kind]} · updated ${a.updatedAt.slice(0, 10)}`,
  mimeType: "text/markdown",
})

const ArtifactResource = McpServer.resource`stdartifacts://${McpSchema.param("kind", ArtifactKind)}/${McpSchema.param("id", Schema.String)}`({
  name: "Artifact",
  description: "A board, table or doc: its content as compact text (table rows, board shapes, or the doc as markdown).",
  mimeType: "text/markdown",
  content: (uri, _kind, id) =>
    Effect.gen(function* () {
      const client = yield* StandardArtifactsClient
      const c = yield* client.read(id)
      return `# ${c.artifact.title}\n\n${c.kind} ${c.artifact.id} (rev ${c.seq}). Edit it with this server's tools.\n\n${c.text}`
    }).pipe(Effect.mapError((e) => new Error(`Can't read ${uri}: ${e.message}`))),
})

/** An issue's resource: `stdartifacts://tracker/<tracker id>/<number>`. */
export const issueUri = (trackerId: string, number: number) => `stdartifacts://tracker/${trackerId}/${number}`

const issueLink = (t: Artifact, i: Issue): typeof ResourceLink.Type => ({
  type: "resource_link",
  uri: issueUri(t.id, i.number),
  name: `#${i.number} ${i.title}`,
  title: `#${i.number} ${i.title}`,
  description: `Issue in ${t.title} · ${statusLabel(i.status)}${i.delegate ? ` · ${i.delegate.name}` : ""}`,
  mimeType: "text/markdown",
})

/** Issues whose number ("12", "#12") or title words match. */
export function searchIssues(issues: ReadonlyArray<Issue>, query: string, limit = 10): Array<Issue> {
  const q = query.trim().toLowerCase()
  const n = /^#?(\d+)$/.exec(q)?.[1]
  if (n) return issues.filter((i) => i.number === Number(n))
  const terms = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return issues.filter((i) => terms.every((t) => words(i.title).some((w) => w.startsWith(t)))).slice(0, limit)
}

const IssueResource = McpServer.resource`stdartifacts://tracker/${McpSchema.param("tracker", Schema.String)}/${McpSchema.param("number", Schema.String)}`({
  name: "Issue",
  description: "One issue in a tracker: properties, description, its agent runs with every step, and comments.",
  mimeType: "text/markdown",
  content: (uri, tracker, number) =>
    Effect.gen(function* () {
      const client = yield* StandardArtifactsClient
      const c = yield* client.tracker.issues(tracker)
      const i = findIssue(c.state, number)
      if (!i) return yield* Effect.fail({ message: `No issue ${number} in ${c.artifact.title}` })
      const all = yield* client.list()
      return `# ${i.title}\n\nIssue in ${c.artifact.title} (${c.artifact.id}). Work it with this server's tracker tools.\n\n${issueDetail(i, c.state, new Map(all.map((a) => [a.id, a])), c.artifact.id)}`
    }).pipe(Effect.mapError((e) => new Error(`Can't read ${uri}: ${e.message}`))),
})

export const serverInfo = {
  name: "stdartifacts",
  version: "0.1.1",
  instructions:
    "Tools for working alongside people on shared boards, tables, docs and issue trackers. Start with search_workspace, list_artifacts or read_artifact; ids from read_artifact are what the edit tools take. " +
    "Artifacts can live in folders, and a folder's path (Marketing/Launch) is its namespace: put new work where it belongs with create_artifact's folder, and use list_folders to see how the workspace is organized. " +
    "People see your presence live, so use set_presence with a short status while you research, and prefer small, reviewable edits. " +
    "When you work an issue (my_issues lists the ones delegated to you), call start_run first and complete_run at the end: the run, and every change you make in between, is recorded on the issue for the people accountable for it.",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05],
} as const

/**
 * Extensions advertised in `initialize` (`capabilities.extensions`). Hosts that
 * don't know one ignore it.
 */
export const serverExtensions = {
  "openai/mentions": { searchTool: mentionSearchTool },
} as const

/** The tools and resources, registered on whatever McpServer transport the host provides (stdio, HTTP). */
export const StandardArtifactsMcp = Layer.mergeAll(McpServer.toolkit(StandardArtifactsToolkit).pipe(Layer.provide(StandardArtifactsToolkitLive)), ArtifactResource, IssueResource)

export type { Client }
