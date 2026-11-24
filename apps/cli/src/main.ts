import { Console, Effect, Layer, Option, References } from "effect"
import { McpServer } from "effect/ai"
import { Argument, Command, Flag } from "effect/cli"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeStdio from "@effect/platform-node/NodeStdio"
import { StandardArtifactsClient, type RoomContent } from "@standard-artifacts/client"
import { serveLocally } from "./serve"
import { shot } from "./shot"
import { inbox, serve } from "./agent"
import { StandardArtifactsMcp, serverExtensions, serverInfo } from "@standard-artifacts/mcp"
import { folderPath, imageMarkdown, parseFolderPath, type CellValue } from "@standard-artifacts/protocol"

/**
 * `stdartifacts`: the workspace from a terminal. Everything goes through @standard-artifacts/client, so
 * it's the same API, validation and permissions as the web app and MCP.
 *
 *   STDARTIFACTS_URL    app URL (default http://localhost:5173)
 *   STDARTIFACTS_TOKEN  ticket from the account service
 *   STDARTIFACTS_AS     dev only: guest | viewer | agent
 */

const ref = Argument.String("artifact").pipe(Argument.withDescription("Artifact id or title"))
const json = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print JSON"))
const kind = Argument.Literals("kind", ["board", "table", "doc", "tracker"])

/**
 * Values are sent as typed text; the table converts them per column ("1,200" in a
 * Number column becomes 1200, "yes" ticks a Checkbox) and keeps text columns as
 * text, so a zip code like "02139" stays "02139". Empty means clear.
 */
const literal = (raw: string): CellValue => (raw === "" ? null : raw)

const readStdin = Effect.promise(async () => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
})

const printContent = (c: RoomContent, asJson: boolean) =>
  asJson ? Console.log(JSON.stringify(c, null, 2)) : Console.log(`${c.kind} ${c.artifact.id} "${c.artifact.title}" (rev ${c.seq})\n\n${c.text}`)

const ls = Command.make(
  "ls",
  {
    kind: Flag.Literals("kind", ["board", "table", "doc"]).pipe(Flag.optional),
    archived: Flag.Boolean("archived").pipe(Flag.withDefault(false), Flag.withDescription("List archived artifacts instead")),
    folder: Flag.String("folder").pipe(Flag.optional, Flag.withDescription("Only what's directly in this folder (id or path); / is the root")),
    json,
  },
  ({ kind, archived, folder, json }) =>
    Effect.gen(function* () {
      const client = yield* StandardArtifactsClient
      const wanted = Option.getOrUndefined(kind)
      const inFolder = Option.getOrUndefined(folder)
      const folders = yield* client.folder.list()
      const inside = inFolder === undefined ? undefined : parseFolderPath(inFolder).length ? (yield* client.folder.resolve(inFolder)).id : null
      const everything = archived ? (yield* client.archived()).filter((a) => !wanted || a.kind === wanted) : yield* client.list(wanted)
      const items = inside === undefined ? everything : everything.filter((a) => (a.folderId ?? null) === inside)
      if (json) return yield* Console.log(JSON.stringify(items, null, 2))
      if (!items.length) return yield* Console.log(archived ? "Nothing archived." : "No artifacts yet. Try: stdartifacts new table \"Leads\"")
      for (const a of items) yield* Console.log(`${a.id.padEnd(18)} ${a.kind.padEnd(6)} ${a.folderId ? `${folderPath(folders, a.folderId)}/` : ""}${a.title}`)
    }),
).pipe(Command.withDescription("List boards, tables and docs"))

const create = Command.make(
  "new",
  {
    kind,
    title: Argument.String("title").pipe(Argument.variadic()),
    folder: Flag.String("folder").pipe(Flag.optional, Flag.withDescription("Folder path to put it in, created if it's new")),
  },
  ({ kind, title, folder }) =>
    Effect.gen(function* () {
      const client = yield* StandardArtifactsClient
      const path = Option.getOrUndefined(folder)
      const parent = path && parseFolderPath(path).length ? yield* client.folder.ensure(path) : undefined
      const a = yield* client.create(kind, title.join(" ") || undefined, undefined, parent?.id)
      yield* Console.log(`${a.id}  ${a.kind}  ${a.title}`)
    }),
).pipe(Command.withDescription("Create a board, table or doc"))

const mv = Command.make("mv", { artifact: ref, folder: Argument.String("folder").pipe(Argument.withDescription("Folder id or path; / is the root")) }, ({ artifact, folder }) =>
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    const a = yield* client.folder.move(artifact, folder)
    yield* Console.log(`Moved "${a.title}" to ${a.folderId ? folderPath(yield* client.folder.list(), a.folderId) : "the workspace root"}`)
  }),
).pipe(Command.withDescription("Move an artifact into a folder (created if the path is new)"))

// --- folders ----------------------------------------------------------------------

const folderRef = Argument.String("folder").pipe(Argument.withDescription("Folder id or path (Marketing/Launch)"))

const folderLs = Command.make("ls", { json }, ({ json }) =>
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    const folders = yield* client.folder.list()
    if (json) return yield* Console.log(JSON.stringify(folders, null, 2))
    if (!folders.length) return yield* Console.log("No folders yet. Try: stdartifacts folder new Marketing/Launch")
    const all = yield* client.list()
    const rows = folders.map((f) => ({ f, path: folderPath(folders, f.id) })).sort((a, b) => a.path.localeCompare(b.path))
    for (const { f, path } of rows) yield* Console.log(`${f.id.padEnd(18)} ${path}  (${all.filter((a) => a.folderId === f.id).length})`)
  }),
).pipe(Command.withDescription("List folders by path, with how many artifacts each holds directly"))

const folderNew = Command.make("new", { path: Argument.String("path") }, ({ path }) =>
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    const f = yield* client.folder.ensure(path)
    yield* Console.log(`${f.id}  ${folderPath(yield* client.folder.list(), f.id)}`)
  }),
).pipe(Command.withDescription("Create a folder at a path, with any missing parents"))

const folderRename = Command.make("rename", { folder: folderRef, name: Argument.String("name") }, ({ folder, name }) =>
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    const f = yield* client.folder.update(folder, { name })
    yield* Console.log(`${f.id}  ${folderPath(yield* client.folder.list(), f.id)}`)
  }),
).pipe(Command.withDescription("Rename a folder"))

const folderMv = Command.make("mv", { folder: folderRef, parent: Argument.String("parent").pipe(Argument.withDescription("New parent's id or path; / is the root")) }, ({ folder, parent }) =>
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    const f = yield* client.folder.update(folder, { parent })
    yield* Console.log(`${f.id}  ${folderPath(yield* client.folder.list(), f.id)}`)
  }),
).pipe(Command.withDescription("Move a folder under another folder"))

const folderRm = Command.make("rm", { folder: folderRef }, ({ folder }) =>
  Effect.gen(function* () {
    const f = yield* (yield* StandardArtifactsClient).folder.remove(folder)
    yield* Console.log(`Deleted folder "${f.name}". What was inside moved up to its parent.`)
  }),
).pipe(Command.withDescription("Delete a folder; what's inside moves up to its parent"))

const folderCommand = Command.make("folder").pipe(
  Command.withDescription("Organize artifacts in folders"),
  Command.withSubcommands([folderLs, folderNew, folderRename, folderMv, folderRm]),
)

const read = Command.make("read", { artifact: ref, json }, ({ artifact, json }) =>
  Effect.flatMap(StandardArtifactsClient, (client) => client.read(artifact)).pipe(Effect.flatMap((c) => printContent(c, json))),
).pipe(Command.withDescription("Print an artifact's content (rows, shapes, or markdown)"))

const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(Argument.withDescription("What you're looking for, in plain words")),
    kind: Flag.Literals("kind", ["board", "table", "doc", "tracker"]).pipe(Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.optional, Flag.withDescription("Most hits to return, up to 50 (default 20)")),
    json,
  },
  ({ query, kind, limit, json }) =>
    Effect.gen(function* () {
      const client = yield* StandardArtifactsClient
      const found = yield* client.search(query, { kind: Option.getOrUndefined(kind), limit: Option.getOrUndefined(limit) })
      if (json) return yield* Console.log(JSON.stringify(found, null, 2))
      if (found.mode === "title") yield* Console.log("Only titles were searched: content search isn't available.\n")
      if (!found.hits.length) return yield* Console.log(`No matches for "${query}".`)
      for (const h of found.hits) {
        yield* Console.log(`${h.artifact.id.padEnd(18)} ${h.artifact.kind.padEnd(7)} ${h.artifact.title}${h.item === undefined ? "" : `  (${h.item})`}`)
        if (h.text) yield* Console.log(`  ${h.text}`)
      }
    }),
).pipe(Command.withDescription("Search the workspace's content by meaning and keywords"))

const reindex = Command.make("reindex", {}, () =>
  Effect.flatMap(StandardArtifactsClient, (client) => client.reindex()).pipe(Effect.flatMap(({ queued }) => Console.log(`Queued ${queued} artifact${queued === 1 ? "" : "s"} for indexing.`))),
).pipe(Command.withDescription("Rebuild the search index for the workspace (owners only)"))

const rm = Command.make("rm", { artifact: ref }, ({ artifact }) =>
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    const a = yield* client.resolve(artifact)
    yield* client.remove(a.id)
    yield* Console.log(`Deleted ${a.kind} ${a.id} "${a.title}"`)
  }),
).pipe(Command.withDescription("Delete an artifact and its content for good"))

const archive = Command.make("archive", { artifact: ref }, ({ artifact }) =>
  Effect.gen(function* () {
    const client = yield* StandardArtifactsClient
    const a = yield* client.resolve(artifact)
    yield* client.archive(a.id)
    yield* Console.log(`Archived ${a.kind} ${a.id} "${a.title}". Bring it back with: stdartifacts restore ${a.id}`)
  }),
).pipe(Command.withDescription("Hide an artifact and keep its content (undo with stdartifacts restore)"))

const restore = Command.make("restore", { artifact: ref }, ({ artifact }) =>
  Effect.gen(function* () {
    const a = yield* (yield* StandardArtifactsClient).restore(artifact)
    yield* Console.log(`Restored ${a.kind} ${a.id} "${a.title}"`)
  }),
).pipe(Command.withDescription("Bring back an archived artifact"))

const ops = Command.make(
  "ops",
  { artifact: ref, file: Argument.String("file").pipe(Argument.withDescription("JSON array of ops, or - for stdin"), Argument.withDefault("-")) },
  ({ artifact, file }) =>
    Effect.gen(function* () {
      const client = yield* StandardArtifactsClient
      const a = yield* client.resolve(artifact)
      const text = file === "-" ? yield* readStdin : yield* Effect.promise(() => import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")))
      const parsed: unknown = JSON.parse(text)
      const r = yield* client.apply(a.id, Array.isArray(parsed) ? parsed : [parsed])
      yield* Console.log(`Applied ${r.applied} op(s), rev ${r.seq}`)
    }),
).pipe(Command.withDescription("Apply raw ops (the same JSON the cells accept)"))

// --- table ------------------------------------------------------------------------

const addRow = Command.make(
  "add-row",
  { artifact: ref, values: Argument.String("column=value").pipe(Argument.variadic()) },
  ({ artifact, values }) =>
    Effect.gen(function* () {
      const row: Record<string, CellValue> = {}
      for (const pair of values) {
        const at = pair.indexOf("=")
        if (at < 1) return yield* Console.error(`Expected column=value, got "${pair}"`)
        row[pair.slice(0, at)] = literal(pair.slice(at + 1))
      }
      const r = yield* (yield* StandardArtifactsClient).table.addRows(artifact, [row])
      yield* Console.log(`Added row ${r.rowIds.join(", ")}`)
    }),
).pipe(Command.withDescription('Append a row: stdartifacts table add-row Leads Name="Ada" Website=https://…'))

const setCell = Command.make(
  "set",
  { artifact: ref, row: Argument.String("row"), column: Argument.String("column"), value: Argument.String("value") },
  ({ artifact, row, column, value }) =>
    Effect.gen(function* () {
      yield* (yield* StandardArtifactsClient).table.setCells(artifact, [{ row, column, value: literal(value) }])
      yield* Console.log(`Set ${row} / ${column}`)
    }),
).pipe(Command.withDescription("Set one cell by row id and column name"))

const addColumn = Command.make(
  "add-column",
  {
    artifact: ref,
    name: Argument.String("name"),
    type: Flag.Literals("type", ["text", "number", "url", "email", "checkbox", "select", "multiSelect", "artifact", "agent"]).pipe(Flag.withDefault("text" as const)),
    options: Flag.String("options").pipe(Flag.optional, Flag.withDescription("Comma-separated, for select and multiSelect columns")),
    prompt: Flag.String("prompt").pipe(Flag.optional, Flag.withDescription("Per-row instruction, for agent columns")),
  },
  ({ artifact, name, type, options, prompt }) =>
    Effect.gen(function* () {
      const id = yield* (yield* StandardArtifactsClient).table.addColumn(artifact, {
        name,
        type,
        ...Option.match(options, { onNone: () => ({}), onSome: (o) => ({ options: o.split(",").map((x) => x.trim()).filter(Boolean) }) }),
        ...Option.match(prompt, { onNone: () => ({}), onSome: (p) => ({ prompt: p }) }),
      })
      yield* Console.log(`Added column ${name} (${id})`)
    }),
).pipe(Command.withDescription("Add a column"))

const table = Command.make("table").pipe(Command.withDescription("Work with tables"), Command.withSubcommands([addRow, setCell, addColumn]))

// --- board ------------------------------------------------------------------------

const boardAdd = Command.make(
  "add",
  {
    artifact: ref,
    text: Argument.String("text").pipe(Argument.variadic()),
    color: Flag.Literals("color", ["yellow", "blue", "green", "pink", "purple", "gray"]).pipe(Flag.optional),
    kind: Flag.Literals("kind", ["note", "rect", "ellipse", "text", "frame"]).pipe(Flag.withDefault("note" as const)),
  },
  ({ artifact, text, color, kind }) =>
    Effect.gen(function* () {
      const r = yield* (yield* StandardArtifactsClient).board.add(artifact, [{ text: text.join(" "), kind, ...Option.match(color, { onNone: () => ({}), onSome: (c) => ({ color: c }) }) }])
      yield* Console.log(`Added ${kind} ${r.shapes.map((s) => s.id).join(", ")}`)
    }),
).pipe(Command.withDescription("Add a sticky note (or shape) to a board"))

const boardLink = Command.make(
  "link",
  { artifact: ref, targets: Argument.String("target").pipe(Argument.variadic({ min: 1 })) },
  ({ artifact, targets }) =>
    Effect.gen(function* () {
      const r = yield* (yield* StandardArtifactsClient).board.addLinks(artifact, targets)
      yield* Console.log(`Added ${r.shapes.map((s) => s.id).join(", ")}`)
    }),
).pipe(Command.withDescription("Show other artifacts or their items on a board, by id (t_abc, t_abc#r_1), title or app URL"))

const boardConnect = Command.make("connect", { artifact: ref, from: Argument.String("from"), to: Argument.String("to") }, ({ artifact, from, to }) =>
  Effect.gen(function* () {
    const id = yield* (yield* StandardArtifactsClient).board.connect(artifact, from, to)
    yield* Console.log(`Connected ${from} -> ${to} (${id})`)
  }),
).pipe(Command.withDescription("Draw a connector between two shapes"))

const mimeFor = (file: string) =>
  /\.png$/i.test(file) ? "image/png" : /\.jpe?g$/i.test(file) ? "image/jpeg" : /\.webp$/i.test(file) ? "image/webp" : /\.gif$/i.test(file) ? "image/gif" : undefined

/** A local image file's bytes and type, or null when it isn't a type we store. */
const readImage = (file: string) =>
  Effect.promise(async () => {
    const mime = mimeFor(file)
    if (!mime) return null
    const fs = await import("node:fs/promises")
    return { mime, bytes: new Uint8Array(await fs.readFile(file)) }
  })

const boardImage = Command.make(
  "image",
  {
    artifact: ref,
    files: Argument.String("file").pipe(Argument.variadic()),
    caption: Flag.String("caption").pipe(Flag.optional),
  },
  ({ artifact, files, caption }) =>
    Effect.gen(function* () {
      const client = yield* StandardArtifactsClient
      const board = yield* client.resolve(artifact, "board")
      const images: Array<{ bytes: Uint8Array; mime: string; caption: string }> = []
      for (const file of files) {
        const image = yield* readImage(file)
        if (!image) return yield* Console.error(`Not an image: ${file}`)
        images.push({ ...image, caption: Option.getOrElse(caption, () => file.split("/").pop() ?? file) })
      }
      const r = yield* client.board.addImages(board.id, images)
      for (const shape of r.shapes) yield* Console.log(`Added image ${shape.id}  ${shape.text ?? ""}`)
    }),
).pipe(Command.withDescription("Upload images to a board"))

const boardGetImage = Command.make(
  "get-image",
  { artifact: ref, shape: Argument.String("shape"), out: Flag.String("out").pipe(Flag.withAlias("o"), Flag.optional) },
  ({ artifact, shape, out }) =>
    Effect.gen(function* () {
      const img = yield* (yield* StandardArtifactsClient).downloadImage(artifact, shape)
      const ext = img.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png"
      const file = Option.getOrElse(out, () => `${shape}.${ext}`)
      const fs = yield* Effect.promise(() => import("node:fs/promises"))
      yield* Effect.promise(() => fs.writeFile(file, img.bytes))
      yield* Console.log(`${file}${img.shape.text ? `  "${img.shape.text}"` : ""}`)
    }),
).pipe(Command.withDescription("Download an image shape (e.g. to read a screenshot)"))

const boardHtml = Command.make(
  "html",
  {
    artifact: ref,
    file: Argument.String("file").pipe(Argument.withDefault("-"), Argument.withDescription("An .html file, or - for stdin")),
    title: Flag.String("title").pipe(Flag.optional),
    w: Flag.Int("w").pipe(Flag.optional),
    h: Flag.Int("h").pipe(Flag.optional),
  },
  ({ artifact, file, title, w, h }) =>
    Effect.gen(function* () {
      const html = file === "-" ? yield* readStdin : yield* Effect.promise(() => import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")))
      const opt = <A>(o: Option.Option<A>, key: string) => Option.match(o, { onNone: () => ({}), onSome: (v) => ({ [key]: v }) })
      // Like pasting on the board: default the title to the document's <title> or first heading.
      const found = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1] ?? html.match(/<h[1-3][^>]*>([^<]{1,120})<\/h[1-3]>/i)?.[1]
      const name = Option.orElse(title, () => Option.fromNullishOr(found?.trim() || undefined))
      const r = yield* (yield* StandardArtifactsClient).board.addHtml(artifact, { html, ...opt(name, "title"), ...opt(w, "w"), ...opt(h, "h") })
      yield* Console.log(`Added html embed ${r.shape.id} "${r.shape.text ?? ""}"`)
    }),
).pipe(Command.withDescription("Add a live HTML embed (mockup, chart, widget) to a board"))

const readSource = (file: string) =>
  file === "-" ? readStdin : Effect.promise(() => import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")))
const optionalKey = <A>(o: Option.Option<A>, key: string) => Option.match(o, { onNone: () => ({}), onSome: (v) => ({ [key]: v }) })
/** `key=` (empty) removes a property, as `null` does in the API. */
const nullable = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === "" ? null : v]))
const shapeArg = Argument.String("shape").pipe(Argument.withDescription("The design frame's shape id"))
const sourceArg = Argument.String("file").pipe(Argument.withDefault("-"), Argument.withDescription("An .html file, or - for stdin"))

const designAdd = Command.make(
  "add",
  {
    artifact: ref,
    file: sourceArg,
    title: Flag.String("title").pipe(Flag.optional),
    x: Flag.Int("x").pipe(Flag.optional),
    y: Flag.Int("y").pipe(Flag.optional),
    w: Flag.Int("w").pipe(Flag.optional),
    h: Flag.Int("h").pipe(Flag.optional),
  },
  ({ artifact, file, title, x, y, w, h }) =>
    Effect.gen(function* () {
      const html = yield* readSource(file)
      const found = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1] ?? html.match(/<h[1-3][^>]*>([^<]{1,120})<\/h[1-3]>/i)?.[1]
      const name = Option.orElse(title, () => Option.fromNullishOr(found?.trim() || undefined))
      const r = yield* (yield* StandardArtifactsClient).board.addDesign(artifact, {
        html,
        ...optionalKey(name, "title"), ...optionalKey(x, "x"), ...optionalKey(y, "y"), ...optionalKey(w, "w"), ...optionalKey(h, "h"),
      })
      yield* Console.log(`Added design frame ${r.shape.id} "${r.shape.text ?? ""}"\n${r.outline}`)
    }),
).pipe(Command.withDescription("Add an editable design frame (HTML/CSS turned into layers)"))

const designGet = Command.make(
  "get",
  { artifact: ref, shape: shapeArg, outline: Flag.Boolean("outline").pipe(Flag.withDefault(false), Flag.withDescription("Print the layer outline instead of HTML")) },
  ({ artifact, shape, outline }) =>
    Effect.gen(function* () {
      const r = yield* (yield* StandardArtifactsClient).board.getDesign(artifact, shape)
      // HTML with data-node ids: edit it and send it back with `set`, and the ids (and others' edits to them) survive.
      yield* Console.log(outline ? r.outline : r.htmlWithIds)
    }),
).pipe(Command.withDescription("Print a design frame's HTML (with data-node ids) or its outline"))

const designSet = Command.make(
  "set",
  { artifact: ref, shape: shapeArg, file: sourceArg },
  ({ artifact, shape, file }) =>
    Effect.gen(function* () {
      const html = yield* readSource(file)
      yield* (yield* StandardArtifactsClient).board.updateDesign(artifact, shape, { html })
      yield* Console.log(`Replaced design frame ${shape}`)
    }),
).pipe(Command.withDescription("Replace a design frame from HTML (data-node ids are kept)"))

const designPatch = Command.make(
  "patch",
  {
    artifact: ref,
    shape: shapeArg,
    node: Argument.String("node").pipe(Argument.withDescription("The layer's node id")),
    text: Flag.String("text").pipe(Flag.optional),
    style: Flag.KeyValuePair("style").pipe(Flag.optional, Flag.withDescription("CSS property=value; repeat it; an empty value removes the property")),
    attr: Flag.KeyValuePair("attr").pipe(Flag.optional, Flag.withDescription("attribute=value; repeat it; an empty value removes it")),
  },
  ({ artifact, shape, node, text, style, attr }) =>
    Effect.gen(function* () {
      const patch = {
        node,
        ...Option.match(text, { onNone: () => ({}), onSome: (t) => ({ text: t }) }),
        ...Option.match(style, { onNone: () => ({}), onSome: (r) => ({ style: nullable(r) }) }),
        ...Option.match(attr, { onNone: () => ({}), onSome: (r) => ({ attrs: nullable(r) }) }),
      }
      yield* (yield* StandardArtifactsClient).board.updateDesign(artifact, shape, { patches: [patch] })
      yield* Console.log(`Patched ${shape} / ${node}`)
    }),
).pipe(Command.withDescription("Change one layer's text, styles or attributes"))

const boardDesign = Command.make("design").pipe(
  Command.withDescription("Design frames: HTML/CSS layers people edit like Figma"),
  Command.withSubcommands([designAdd, designGet, designSet, designPatch]),
)

const board = Command.make("board").pipe(
  Command.withDescription("Work with boards"),
  Command.withSubcommands([boardAdd, boardLink, boardConnect, boardImage, boardGetImage, boardHtml, boardDesign]),
)

const shotCommand = Command.make(
  "shot",
  {
    artifact: ref,
    url: Argument.String("url"),
    steps: Argument.String("step").pipe(
      Argument.variadic(),
      Argument.withDescription("click:<sel> fill:<sel>=<text> type:<text> press:<key> hover:<sel> goto:<path> wait:<ms|sel> shot[:caption]"),
    ),
    as: Flag.Literals("as", ["owner", "viewer", "guest"]).pipe(Flag.withDefault("owner" as const), Flag.withDescription("Capture what this kind of person sees (dev)")),
    width: Flag.Int("width").pipe(Flag.withDefault(1280)),
    height: Flag.Int("height").pipe(Flag.withDefault(800)),
    title: Flag.String("title").pipe(Flag.optional),
  },
  ({ artifact, url, steps, as, width, height, title }) =>
    Effect.gen(function* () {
      const r = yield* shot({ board: artifact, url, steps, as, width, height, title: Option.getOrUndefined(title) })
      yield* Console.log(`Frame ${r.frame.id} "${r.frame.text}" on ${r.board.title}`)
      for (const line of r.added) yield* Console.log(`  ${line}`)
      if (r.problems.length) yield* Console.log(`  ${r.problems.length} issue(s) noted on the board`)
    }),
).pipe(Command.withDescription("Run interactions in a page and stream screenshots onto a board"))

// --- doc --------------------------------------------------------------------------

const docAppend = Command.make(
  "append",
  {
    artifact: ref,
    markdown: Argument.String("markdown").pipe(Argument.variadic(), Argument.withDescription("Markdown text; omit or use - to read stdin")),
  },
  ({ artifact, markdown }) =>
    Effect.gen(function* () {
      const text = markdown.length === 0 || (markdown.length === 1 && markdown[0] === "-") ? yield* readStdin : markdown.join(" ")
      const r = yield* (yield* StandardArtifactsClient).doc.appendMarkdown(artifact, text)
      yield* Console.log(`Appended ${r.blockIds.length} block(s)`)
    }),
).pipe(Command.withDescription("Append markdown to a doc (args or stdin)"))

const docImage = Command.make(
  "image",
  {
    artifact: ref,
    files: Argument.String("file").pipe(Argument.variadic()),
    caption: Flag.String("caption").pipe(Flag.optional),
  },
  ({ artifact, files, caption }) =>
    Effect.gen(function* () {
      const client = yield* StandardArtifactsClient
      const target = yield* client.resolve(artifact, "doc")
      const images = []
      for (const file of files) {
        const image = yield* readImage(file)
        if (!image) return yield* Console.error(`Not an image: ${file}`)
        images.push(image)
      }
      const lines = []
      for (const image of images) lines.push(imageMarkdown(Option.getOrElse(caption, () => ""), yield* client.uploadImage(target.id, image.bytes, image.mime)))
      const r = yield* client.doc.appendMarkdown(target.id, lines.join("\n\n"))
      for (const id of r.blockIds) yield* Console.log(`Added image ${id}`)
    }),
).pipe(Command.withDescription("Upload images to the end of a doc"))

const doc = Command.make("doc").pipe(Command.withDescription("Work with docs"), Command.withSubcommands([docAppend, docImage]))

// --- issues -----------------------------------------------------------------------

const trackerRef = Argument.String("tracker").pipe(Argument.withDescription("Tracker id or title"))
const issueRef = Argument.String("issue").pipe(Argument.withDescription("Issue number (12) or id"))
const statusFlag = Flag.Literals("status", ["backlog", "todo", "in_progress", "in_review", "done", "canceled"]).pipe(Flag.optional)
const priorityFlag = Flag.Literals("priority", ["none", "urgent", "high", "medium", "low"]).pipe(Flag.optional)
const opt = <A>(o: Option.Option<A>) => Option.getOrUndefined(o)
/** "-" or "none" clears a person or date. */
const orClear = (o: Option.Option<string>) => Option.match(o, { onNone: () => undefined, onSome: (v) => (v === "-" || v === "none" ? null : v) })

const issueList = Command.make("ls", { tracker: trackerRef, all: Flag.Boolean("all").pipe(Flag.withDefault(false), Flag.withDescription("Include done and canceled")) }, ({ tracker, all }) =>
  Effect.gen(function* () {
    const c = yield* (yield* StandardArtifactsClient).read(tracker, "tracker")
    if (c.kind !== "tracker") return
    const open = new Set(["backlog", "todo", "in_progress", "in_review"])
    const issues = c.state.items.flatMap((i) => (i.type === "issue" && (all || open.has(i.status)) ? [i] : []))
    if (!issues.length) return yield* Console.log("No issues.")
    for (const i of issues)
      yield* Console.log(`#${String(i.number).padEnd(4)} ${i.status.padEnd(11)} ${i.priority.padEnd(7)} ${(i.delegate?.name ?? i.owner?.name ?? "-").padEnd(10)} ${i.title}`)
  }),
).pipe(Command.withDescription("List a tracker's open issues"))

const issueNew = Command.make(
  "new",
  {
    tracker: trackerRef,
    title: Argument.String("title").pipe(Argument.variadic()),
    description: Flag.String("description").pipe(Flag.withAlias("d"), Flag.optional),
    status: statusFlag,
    priority: priorityFlag,
    owner: Flag.String("owner").pipe(Flag.optional, Flag.withDescription('"me" or a name')),
    delegate: Flag.String("delegate").pipe(Flag.optional, Flag.withDescription('"me", claude, chatgpt, codex, or a name')),
    label: Flag.String("label").pipe(Flag.optional, Flag.withDescription("Comma-separated labels")),
    due: Flag.String("due").pipe(Flag.optional, Flag.withDescription("YYYY-MM-DD")),
    link: Flag.String("link").pipe(Flag.optional, Flag.withDescription('Comma-separated artifacts (ids or titles) or "#12" issues it\'s about')),
  },
  ({ tracker, title, description, status, priority, owner, delegate, label, due, link }) =>
    Effect.gen(function* () {
      const r = yield* (yield* StandardArtifactsClient).tracker.create(tracker, {
        title: title.join(" "),
        description: opt(description),
        status: opt(status),
        priority: opt(priority),
        owner: opt(owner),
        delegate: opt(delegate),
        due: opt(due),
        labels: Option.match(label, { onNone: () => undefined, onSome: (l) => l.split(",").map((x) => x.trim()).filter(Boolean) }),
        links: Option.match(link, { onNone: () => undefined, onSome: (l) => l.split(",").map((x) => x.trim()).filter(Boolean) }),
        source: { via: "cli" },
      })
      yield* Console.log(`Created #${r.issue.number} ${r.issue.title} (${r.issue.id})`)
    }),
).pipe(Command.withDescription('Create an issue: stdartifacts issue new Launch "Write the pricing page" --delegate claude'))

const issueSet = Command.make(
  "set",
  {
    tracker: trackerRef,
    issue: issueRef,
    title: Flag.String("title").pipe(Flag.optional),
    description: Flag.String("description").pipe(Flag.withAlias("d"), Flag.optional),
    status: statusFlag,
    priority: priorityFlag,
    owner: Flag.String("owner").pipe(Flag.optional, Flag.withDescription('"me", a name, or "-" to clear')),
    delegate: Flag.String("delegate").pipe(Flag.optional, Flag.withDescription('"me", an agent, a name, or "-" to clear')),
    due: Flag.String("due").pipe(Flag.optional, Flag.withDescription('YYYY-MM-DD or "-"')),
    link: Flag.String("link").pipe(Flag.optional, Flag.withDescription('Add links: comma-separated artifacts or "#12" issues')),
    unlink: Flag.String("unlink").pipe(Flag.optional, Flag.withDescription("Remove links, named the same way")),
  },
  ({ tracker, issue, title, description, status, priority, owner, delegate, due, link, unlink }) =>
    Effect.gen(function* () {
      const r = yield* (yield* StandardArtifactsClient).tracker.update(tracker, issue, {
        ...(Option.isSome(title) && { title: title.value }),
        ...(Option.isSome(description) && { description: description.value }),
        ...(Option.isSome(status) && { status: status.value }),
        ...(Option.isSome(priority) && { priority: priority.value }),
        ...(Option.isSome(owner) && { owner: orClear(owner) ?? null }),
        ...(Option.isSome(delegate) && { delegate: orClear(delegate) ?? null }),
        ...(Option.isSome(due) && { due: orClear(due) ?? null }),
        ...(Option.isSome(link) && { link: link.value.split(",").map((x) => x.trim()).filter(Boolean) }),
        ...(Option.isSome(unlink) && { unlink: unlink.value.split(",").map((x) => x.trim()).filter(Boolean) }),
      })
      yield* Console.log(`Updated #${r.issue.number}`)
    }),
).pipe(Command.withDescription("Change an issue's fields"))

const issueComment = Command.make("comment", { tracker: trackerRef, issue: issueRef, text: Argument.String("text").pipe(Argument.variadic()) }, ({ tracker, issue, text }) =>
  Effect.gen(function* () {
    const r = yield* (yield* StandardArtifactsClient).tracker.comment(tracker, issue, text.join(" "))
    yield* Console.log(`Commented on #${r.issue.number}`)
  }),
).pipe(Command.withDescription("Comment on an issue"))

const issue = Command.make("issue").pipe(Command.withDescription("Work with issue trackers"), Command.withSubcommands([issueList, issueNew, issueSet, issueComment]))

// --- mcp --------------------------------------------------------------------------

/**
 * Stdio MCP server. Stdout carries the protocol, so logging is switched off.
 * In dev it acts as an agent unless STDARTIFACTS_AS says otherwise.
 */
const mcp = Command.make("mcp", {}, () =>
  Layer.launch(
    StandardArtifactsMcp.pipe(
      Layer.provide(McpServer.layerStdio({ ...serverInfo, extensions: serverExtensions })),
      Layer.provide(NodeStdio.layer),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "None")),
    ),
  ),
).pipe(Command.withDescription("Run the MCP server over stdio (for Claude Code, Claude Desktop, Cursor…)"))

// --- agent ------------------------------------------------------------------------

const agentServe = Command.make(
  "serve",
  {
    once: Flag.Boolean("once").pipe(Flag.withDefault(false), Flag.withDescription("Handle at most one mention, then exit")),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("Print what would be sent for the next mention; claims nothing")),
    model: Flag.String("model").pipe(Flag.withDefault("claude-opus-5-5")),
    budget: Flag.Finite("budget").pipe(Flag.withDefault(1), Flag.withDescription("Max USD per mention")),
    maxTurns: Flag.Int("max-turns").pipe(Flag.withDefault(30)),
    poll: Flag.Int("poll").pipe(Flag.withDefault(2), Flag.withDescription("Seconds between inbox checks")),
  },
  ({ once, dryRun, model, budget, maxTurns, poll }) => serve({ once, dryRun, model, budgetUsd: budget, maxTurns, pollSeconds: poll }),
).pipe(Command.withDescription("Wake Claude on @claude mentions in docs, boards and tables (Claude Agent SDK)"))

const agentInbox = Command.make("inbox", {}, () => inbox).pipe(Command.withDescription("List recent @mentions and their status"))

const agent = Command.make("agent").pipe(Command.withDescription("Run and inspect the @mention agent"), Command.withSubcommands([agentServe, agentInbox]))

// --- serve ------------------------------------------------------------------------

/** Runs @standard-artifacts/server's bin as a child process (see serve.ts). */
const serveCommand = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(Flag.optional, Flag.withDescription("Port to listen on (default 4747)")),
    data: Flag.String("data").pipe(Flag.optional, Flag.withDescription("Where the workspace is stored (default ~/.stdartifacts)")),
    name: Flag.String("name").pipe(Flag.optional, Flag.withDescription("Your display name (default: your OS account's name)")),
    noOpen: Flag.Boolean("no-open").pipe(Flag.withDefault(false), Flag.withDescription("Don't open the browser")),
  },
  ({ port, data, name, noOpen }) =>
    serveLocally([
      ...Option.match(port, { onNone: () => [], onSome: (p) => ["--port", String(p)] }),
      ...Option.match(data, { onNone: () => [], onSome: (d) => ["--data", d] }),
      ...Option.match(name, { onNone: () => [], onSome: (n) => ["--name", n] }),
      ...(noOpen ? ["--no-open"] : []),
    ]),
).pipe(Command.withDescription("Run Standard Artifacts on this machine (no sign-in, localhost only) and open it"))

// --- root -------------------------------------------------------------------------

const root = Command.make("stdartifacts").pipe(
  Command.withDescription("Boards, tables and docs for people and agents"),
  Command.withSubcommands([ls, create, mv, folderCommand, read, search, reindex, rm, archive, restore, ops, table, board, doc, issue, shotCommand, agent, mcp, serveCommand]),
)

// Under `stdartifacts mcp`, edits are attributed to an agent by default (dev); STDARTIFACTS_AS still wins.
const isMcp = process.argv[2] === "mcp"

Command.run(root, { version: "0.1.1" }).pipe(
  // Expected failures (unknown artifact, read-only, unreachable server) print one line, not a stack.
  Effect.catchTag("StandardArtifactsError", (e) => Console.error(`error: ${e.message}`).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1))))),
  Effect.provide(StandardArtifactsClient.layerConfig(isMcp ? { defaultAs: "agent" } : {})),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
