import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import {
  Api,
  assetPath,
  cellKey,
  designOutline,
  designToHtml,
  findFolderByPath,
  htmlToDesign,
  htmlToDesignNodes,
  isTags,
  kinds,
  linkSize,
  parseFolderPath,
  parseRef,
  type Folder,
  markdownToBlocks,
  newId,
  type Artifact,
  type ArtifactKind,
  type BoardState,
  type CellStatus,
  type CellValue,
  type Column,
  type DesignNodePatch,
  type ColumnType,
  type Presence,
  type RoomContent,
  type Shape,
  type ShapeColor,
  type ShapeKind,
  type ShapePatch,
  type TableState,
  type BlockPatch,
  actorKey,
  actorName,
  findIssue,
  issuesOf,
  knownAgents,
  type Assignee,
  type Issue,
  type IssuePerson,
  type IssuePriority,
  type IssueSource,
  type IssueStatus,
  type Principal,
  type Run,
  type RunState,
  type RunStep,
  type TrackerPatch,
  type TrackerState,
  type ArtifactRef,
  sameRef,
} from "@standard-artifacts/protocol"

/**
 * The SDK every non-browser interface builds on (CLI, MCP, scripts). It wraps
 * the typed HttpApi client and adds helpers that speak in names and markdown
 * instead of raw ops: "set the Status column", "append this markdown".
 */

export class StandardArtifactsError extends Schema.TaggedError<StandardArtifactsError>()("StandardArtifactsError", { message: Schema.String }) {}

export interface Connection {
  /** Base URL of the app, e.g. http://localhost:5173 */
  readonly url: string
  /** HMAC ticket from the account service. */
  readonly token?: Redacted.Redacted<string> | undefined
  /** Dev only: act as "agent" | "guest" | "viewer" (honored when the server runs AUTH_MODE=dev). */
  readonly as?: string | undefined
  /**
   * The fetch to send requests with (default: the global one). The Worker's
   * remote MCP server passes one that calls the API in-process.
   */
  readonly fetch?: typeof globalThis.fetch | undefined
}

const describe = (e: unknown, url: string): string => {
  if (typeof e === "object" && e !== null) {
    if ("_tag" in e && e._tag === "HttpClientError" && "message" in e && typeof e.message === "string" && e.message.startsWith("Transport error")) {
      return `Could not reach ${url}. Is the app running? (set STDARTIFACTS_URL to point elsewhere)`
    }
    if ("_tag" in e && "message" in e && typeof e.message === "string" && e.message) return e.message
    if ("message" in e && typeof e.message === "string") return e.message
  }
  return String(e)
}

const fail = (message: string) => Effect.fail(new StandardArtifactsError({ message }))

export type NoteInput = {
  readonly text: string
  readonly kind?: Exclude<ShapeKind, "arrow" | "artifact">
  readonly color?: ShapeColor
  readonly x?: number
  readonly y?: number
  readonly w?: number
  readonly h?: number
}

/** Write doc changes as reviewable suggestions from this agent (and request). */
export type SuggestAs = { readonly by: string; readonly mentionId?: string | undefined }

export type CellInput = {
  readonly row: string
  /** Column name or id. */
  readonly column: string
  readonly value: CellValue
  readonly status?: CellStatus
  readonly sources?: ReadonlyArray<string>
}

/**
 * The app an agent's calls come from ("Codex"), set around each MCP tool call.
 * Its edits are attributed to that app, not to the account's shared agent.
 */
export class CallerApp extends Context.Service<CallerApp, string>()("@standard-artifacts/CallerApp") {}

/** Say which app is calling, when one is. Headers are ASCII, so anything else in a name is dropped. */
const withCallerApp = (req: HttpClientRequest.HttpClientRequest) =>
  Effect.map(Effect.serviceOption(CallerApp), (app) => {
    const name = Option.getOrElse(app, () => "").replace(/[^\x20-\x7e]/g, "").trim()
    return name ? HttpClientRequest.setHeader(req, "x-standard-artifacts-client", name) : req
  })

const make = (connection: Connection) =>
  Effect.gen(function* () {
    // `Fetch` is read when a request runs, so a custom one is provided around each request.
    const custom = connection.fetch
    const viaFetch = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
      custom ? HttpClient.transform(client, (effect) => Effect.provideService(effect, FetchHttpClient.Fetch, custom)) : client
    const api = yield* HttpApiClient.make(Api, {
      baseUrl: connection.url,
      transformClient: (client) =>
        client.pipe(
          HttpClient.mapRequest((req) => {
            let r = req
            if (connection.token) r = HttpClientRequest.bearerToken(r, Redacted.value(connection.token))
            if (connection.as) r = HttpClientRequest.setHeader(r, "x-dev-as", connection.as)
            return r
          }),
          HttpClient.mapRequestEffect(withCallerApp),
          viaFetch,
        ),
    })
    // Raw HTTP for bytes (image upload/download), with the same auth as the typed client.
    const plain = yield* HttpClient.HttpClient
    const http = plain.pipe(
      HttpClient.mapRequest((req) => {
        let r = HttpClientRequest.prependUrl(req, connection.url)
        if (connection.token) r = HttpClientRequest.bearerToken(r, Redacted.value(connection.token))
        if (connection.as) r = HttpClientRequest.setHeader(r, "x-dev-as", connection.as)
        return r
      }),
      HttpClient.mapRequestEffect(withCallerApp),
      viaFetch,
    )
    const call = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError((e) => new StandardArtifactsError({ message: describe(e, connection.url) })))

    const list = Effect.fn("StandardArtifactsClient.list")(function* (kind?: ArtifactKind) {
      const snap = yield* call(api.workspace.snapshot())
      return kind ? snap.artifacts.filter((a) => a.kind === kind) : snap.artifacts
    })

    /** Accept an id, or a title (exact, then case-insensitive prefix). */
    const match = (all: ReadonlyArray<Artifact>, ref: string) => {
      // Every title starts with "": a blank name mustn't quietly mean the first artifact.
      if (!ref.trim()) return undefined
      const lower = ref.toLowerCase()
      return (
        all.find((a) => a.id === ref) ??
        all.find((a) => a.title === ref) ??
        all.filter((a) => a.title.toLowerCase().startsWith(lower)).at(0)
      )
    }

    const resolve = Effect.fn("StandardArtifactsClient.resolve")(function* (ref: string, kind?: ArtifactKind) {
      const snap = yield* call(api.workspace.snapshot())
      const all = kind ? snap.artifacts.filter((a) => a.kind === kind) : snap.artifacts
      // A title wins over a path, since titles can hold slashes: "Q3/Q4 plan".
      const segments = parseFolderPath(ref)
      const folder = segments.length > 1 ? findFolderByPath(snap.folders, segments.slice(0, -1)) : undefined
      const hit = match(all, ref) ?? (folder && match(all.filter((a) => a.folderId === folder.id), segments.at(-1)!))
      if (!hit) return yield* fail(`No ${kind ? kinds[kind].singular.toLowerCase() : "artifact"} matches "${ref}"`)
      return hit
    })

    const read = Effect.fn("StandardArtifactsClient.read")(function* (ref: string, kind?: ArtifactKind) {
      const artifact = yield* resolve(ref, kind)
      return yield* call(api.rooms.content({ params: { id: artifact.id } }))
    })

    const apply = Effect.fn("StandardArtifactsClient.apply")(function* (id: string, ops: ReadonlyArray<unknown>) {
      return yield* call(api.rooms.applyOps({ params: { id }, payload: { ops } }))
    })

    const presence = Effect.fn("StandardArtifactsClient.presence")(function* (id: string, runId: string, value: Presence, ttl = 20) {
      return yield* call(api.rooms.agentPresence({ params: { id }, payload: { runId, presence: value, ttl } }))
    })

    const content = <K extends RoomContent["kind"]>(ref: string, kind: K) =>
      read(ref, kind).pipe(
        Effect.flatMap((c) => (c.kind === kind ? Effect.succeed(c as Extract<RoomContent, { kind: K }>) : fail(`"${ref}" is not a ${kind}`))),
      )

    // --- Tables --------------------------------------------------------------------

    const column = (state: TableState, ref: string): Effect.Effect<Column, StandardArtifactsError> => {
      const lower = ref.toLowerCase()
      const c = state.columns.find((c) => c.id === ref) ?? state.columns.find((c) => c.name.toLowerCase() === lower)
      return c ? Effect.succeed(c) : fail(`No column "${ref}". Columns: ${state.columns.map((c) => c.name).join(", ")}`)
    }

    /** Artifact columns also take titles, as issue links do. Ids and links go through as they are, for the cell to check. */
    const withTitles = Effect.fn("StandardArtifactsClient.table.withTitles")(function* (col: Column, value: CellValue) {
      if (col.type !== "artifact" || (typeof value !== "string" && !isTags(value))) return value
      const out: Array<string> = []
      for (const raw of isTags(value) ? value : value.split(/[,\n]/)) {
        const text = raw.trim()
        if (text) out.push(parseRef(text) ? text : (yield* resolve(text)).id)
      }
      return out
    })

    const table = {
      /** Rows keyed by column name (or id). Returns the new row ids. */
      addRows: Effect.fn("StandardArtifactsClient.table.addRows")(function* (ref: string, rows: ReadonlyArray<Record<string, CellValue>>) {
        const c = yield* content(ref, "table")
        const values: Record<string, Record<string, CellValue>> = {}
        const rowIds: Array<string> = []
        for (const row of rows) {
          const rowId = newId("r_")
          rowIds.push(rowId)
          values[rowId] = {}
          for (const [name, v] of Object.entries(row)) {
            const col = yield* column(c.state, name)
            values[rowId][col.id] = yield* withTitles(col, v)
          }
        }
        yield* apply(c.artifact.id, [{ type: "addRows", rowIds, values }])
        return { artifact: c.artifact, rowIds }
      }),
      setCells: Effect.fn("StandardArtifactsClient.table.setCells")(function* (ref: string, cells: ReadonlyArray<CellInput>) {
        const c = yield* content(ref, "table")
        const ops: Array<unknown> = []
        for (const cell of cells) {
          if (!c.state.rowIds.includes(cell.row)) return yield* fail(`No row "${cell.row}"`)
          const col = yield* column(c.state, cell.column)
          // Queued and running cells hold progress text, not a value.
          const settled = !cell.status || cell.status === "done"
          const value = settled ? yield* withTitles(col, cell.value) : cell.value
          ops.push({ type: "setCell", rowId: cell.row, colId: col.id, value, ...(cell.status && { status: cell.status }), ...(cell.sources && { sources: cell.sources }) })
        }
        return yield* apply(c.artifact.id, ops)
      }),
      addColumn: Effect.fn("StandardArtifactsClient.table.addColumn")(function* (
        ref: string,
        input: { name: string; type: ColumnType; options?: ReadonlyArray<string>; multiSelect?: boolean; prompt?: string },
      ) {
        const c = yield* content(ref, "table")
        const id = newId("c_")
        // A column's type is what makes it multi-select; the flag only picks that type.
        const { multiSelect, ...column } = input
        const type = multiSelect && column.type === "select" ? "multiSelect" : column.type
        yield* apply(c.artifact.id, [{ type: "addColumn", column: { id, ...column, type } }])
        return id
      }),
      removeRows: Effect.fn("StandardArtifactsClient.table.removeRows")(function* (ref: string, rowIds: ReadonlyArray<string>) {
        const c = yield* content(ref, "table")
        return yield* apply(c.artifact.id, [{ type: "removeRows", rowIds }])
      }),
    }

    // --- Boards --------------------------------------------------------------------

    const board = {
      /** Add notes/shapes; unplaced ones are laid out in a column to the right of existing content. */
      add: Effect.fn("StandardArtifactsClient.board.add")(function* (ref: string, notes: ReadonlyArray<NoteInput>) {
        const c = yield* content(ref, "board")
        const placed = nextSlots(c.state, notes.length)
        const shapes: Array<Shape> = notes.map((n, i) => {
          const kind = n.kind ?? "note"
          const size = kind === "frame" ? { w: 520, h: 340 } : kind === "text" ? { w: 220, h: 44 } : kind === "note" ? { w: 200, h: 140 } : { w: 160, h: 100 }
          const slot = placed[i] ?? { x: 0, y: 0 }
          return {
            id: newId("s_"),
            kind,
            x: n.x ?? slot.x,
            y: n.y ?? slot.y,
            w: n.w ?? size.w,
            h: n.h ?? size.h,
            text: n.text,
            color: n.color ?? (kind === "note" ? "yellow" : "blue"),
          }
        })
        yield* apply(c.artifact.id, shapes.map((item) => ({ type: "insert", item, ...(item.kind === "frame" ? { after: null } : {}) })))
        return { artifact: c.artifact, shapes }
      }),
      /** Show other artifacts or their items (ids, titles or app links), in a free column to the right of existing content. */
      addLinks: Effect.fn("StandardArtifactsClient.board.addLinks")(function* (ref: string, targets: ReadonlyArray<string>, at: { x?: number; y?: number } = {}) {
        const c = yield* content(ref, "board")
        const slot = nextSlots(c.state, 1)[0] ?? { x: 0, y: 0 }
        let y = at.y ?? slot.y
        const shapes: Array<Shape> = []
        for (const target of targets) {
          const link = parseRef(target) ?? { artifactId: (yield* resolve(target)).id }
          const size = linkSize(link)
          shapes.push({ id: newId("s_"), kind: "artifact", x: at.x ?? slot.x, y, ...size, ref: link })
          y += size.h + 40
        }
        yield* apply(c.artifact.id, shapes.map((item) => ({ type: "insert", item })))
        return { artifact: c.artifact, shapes }
      }),
      /** Upload images and place them in a free column to the right of existing content. */
      addImages: Effect.fn("StandardArtifactsClient.board.addImages")(function* (
        ref: string,
        images: ReadonlyArray<{ bytes: Uint8Array; mime: string; caption?: string }>,
      ) {
        const c = yield* content(ref, "board")
        const slots = nextSlots(c.state, images.length)
        const shapes: Array<Shape> = []
        let y = slots[0]?.y ?? 0
        for (const image of images) {
          const src = yield* uploadImage(c.artifact.id, image.bytes, image.mime)
          const px = pngSize(image.bytes) ?? { w: 800, h: 500 }
          const w = Math.min(560, px.w)
          const h = Math.round(px.h * (w / px.w))
          shapes.push({ id: newId("s_"), kind: "image", x: slots[0]?.x ?? 0, y, w, h, src, ...(image.caption && { text: image.caption }) })
          y += h + 70
        }
        yield* apply(c.artifact.id, shapes.map((item) => ({ type: "insert", item })))
        return { artifact: c.artifact, shapes }
      }),
      connect: Effect.fn("StandardArtifactsClient.board.connect")(function* (ref: string, from: string, to: string) {
        const c = yield* content(ref, "board")
        const id = newId("s_")
        yield* apply(c.artifact.id, [{ type: "insert", item: { id, kind: "arrow", x: 0, y: 0, w: 0, h: 0, from, to } }])
        return id
      }),
      /**
       * Start a captioned image timeline below everything on the board: a frame
       * sized for `count` images, filled in by `append` as each image arrives
       * (so people watch it build), each connected to the previous one.
       */
      timeline: Effect.fn("StandardArtifactsClient.board.timeline")(function* (ref: string, title: string, count: number, size: { w: number; h: number }) {
        const c = yield* content(ref, "board")
        const boxes = c.state.items.filter((s) => s.kind !== "arrow")
        const top = boxes.length ? Math.max(...boxes.map((s) => s.y + s.h)) + 160 : 0
        const left = boxes.length ? Math.min(...boxes.map((s) => s.x)) : 0
        const gap = 90
        const frame: Shape = {
          id: newId("s_"),
          kind: "frame",
          x: left,
          y: top,
          w: count * size.w + (count - 1) * gap + 80,
          h: size.h + 150,
          text: title,
          color: "gray",
        }
        yield* apply(c.artifact.id, [{ type: "insert", item: frame, after: null }])
        let previous: string | undefined
        let index = 0
        const append = (image: { bytes: Uint8Array; mime: string; caption: string; w?: number; h?: number }) =>
          Effect.gen(function* () {
            const src = yield* uploadImage(c.artifact.id, image.bytes, image.mime)
            const w = image.w ?? size.w
            const h = image.h ?? size.h
            const shape: Shape = { id: newId("s_"), kind: "image", x: left + 40 + index * (size.w + gap), y: top + 50, w, h, src, text: image.caption }
            const ops: Array<unknown> = [{ type: "insert", item: shape }]
            if (previous) ops.push({ type: "insert", item: { id: newId("s_"), kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: previous, to: shape.id } })
            yield* apply(c.artifact.id, ops)
            previous = shape.id
            index++
            return shape
          })
        return { artifact: c.artifact, frame, append, next: () => ({ x: left + 40 + index * (size.w + gap) + size.w / 2, y: top + 50 + size.h / 2 }) }
      }),
      /**
       * Add an html embed: a self-contained snippet (inline scripts and styles;
       * images over https or data:, no other network) rendered live in a
       * sandboxed frame. Unplaced, it goes in a free column to the right of
       * existing content.
       */
      addHtml: Effect.fn("StandardArtifactsClient.board.addHtml")(function* (
        ref: string,
        input: { html: string; title?: string; x?: number; y?: number; w?: number; h?: number },
      ) {
        const c = yield* content(ref, "board")
        const slot = nextSlots(c.state, 1)[0] ?? { x: 0, y: 0 }
        const shape: Shape = {
          id: newId("s_"),
          kind: "html",
          x: input.x ?? slot.x,
          y: input.y ?? slot.y,
          w: input.w ?? 480,
          h: input.h ?? 360,
          html: input.html,
          text: input.title ?? "HTML",
        }
        yield* apply(c.artifact.id, [{ type: "insert", item: shape }])
        return { artifact: c.artifact, shape }
      }),
      update: Effect.fn("StandardArtifactsClient.board.update")(function* (ref: string, updates: ReadonlyArray<{ id: string } & ShapePatch>) {
        const c = yield* content(ref, "board")
        return yield* apply(c.artifact.id, updates.map(({ id, ...patch }) => ({ type: "update", id, patch })))
      }),
      /**
       * Add a design frame: HTML parsed into layers (real DOM on the canvas, no
       * iframe). Only an allowlist of tags, inline CSS properties and attributes
       * survives; scripts, event handlers and unsafe URLs are dropped. Unplaced,
       * it goes in a free column to the right of existing content.
       */
      addDesign: Effect.fn("StandardArtifactsClient.board.addDesign")(function* (
        ref: string,
        input: { html: string; title?: string; x?: number; y?: number; w?: number; h?: number },
      ) {
        const c = yield* content(ref, "board")
        const design = htmlToDesign(input.html)
        const slot = nextSlots(c.state, 1)[0] ?? { x: 0, y: 0 }
        const shape: Shape = {
          id: newId("s_"),
          kind: "design",
          x: input.x ?? slot.x,
          y: input.y ?? slot.y,
          w: input.w ?? 480,
          h: input.h ?? 360,
          design,
          text: input.title ?? "Design",
        }
        yield* apply(c.artifact.id, [{ type: "insert", item: shape }])
        return { artifact: c.artifact, shape, outline: designOutline(design) }
      }),
      /** One design frame: its tree, clean HTML, HTML with `data-node` ids (to edit and send back), and an outline. */
      getDesign: Effect.fn("StandardArtifactsClient.board.getDesign")(function* (ref: string, shapeId: string) {
        const c = yield* content(ref, "board")
        const shape = c.state.items.find((s) => s.id === shapeId)
        if (!shape || shape.kind !== "design" || !shape.design) return yield* fail(`No design frame "${shapeId}" on ${c.artifact.title}`)
        const tree = shape.design
        return { artifact: c.artifact, shape, tree, html: designToHtml(tree), htmlWithIds: designToHtml(tree, { ids: true }), outline: designOutline(tree) }
      }),
      /**
       * Edit a design frame: replace it from HTML (ids in `data-node` are kept),
       * and/or patch nodes by id (style/attrs merge per property, `null`
       * removes), insert HTML fragments into a parent, or remove nodes. Each
       * patch, insert and removal is its own node-level op, so people editing
       * other layers keep their changes.
       */
      updateDesign: Effect.fn("StandardArtifactsClient.board.updateDesign")(function* (
        ref: string,
        shapeId: string,
        input: {
          html?: string
          patches?: ReadonlyArray<{ node: string } & DesignNodePatch>
          insert?: ReadonlyArray<{ parent: string; index?: number; html: string }>
          remove?: ReadonlyArray<string>
        },
      ) {
        const c = yield* content(ref, "board")
        const shape = c.state.items.find((s) => s.id === shapeId)
        if (!shape || shape.kind !== "design" || !shape.design) return yield* fail(`No design frame "${shapeId}" on ${c.artifact.title}`)
        const ops: Array<unknown> = []
        const inserted: Array<string> = []
        if (input.html !== undefined) ops.push({ type: "update", id: shapeId, patch: { design: htmlToDesign(input.html) } })
        for (const { node, ...patch } of input.patches ?? []) ops.push({ type: "designNode", shape: shapeId, node, patch })
        // Fresh ids must not clash with the frame's existing nodes (or each other).
        const reserved = new Set(Object.keys(shape.design.nodes))
        for (const ins of input.insert ?? []) {
          const { roots, nodes } = htmlToDesignNodes(ins.html, { reserved })
          for (const n of nodes) reserved.add(n.id)
          const byId = new Map(nodes.map((n) => [n.id, n]))
          /** A top-level layer and everything below it: one insert op each, in order. */
          const subtree = (root: string) => {
            const out = []
            const stack = [root]
            while (stack.length) {
              const n = byId.get(stack.pop()!)
              if (!n) continue
              out.push(n)
              stack.push(...n.children)
            }
            return out
          }
          roots.forEach((root, k) => {
            const sub = subtree(root)
            ops.push({ type: "designInsert", shape: shapeId, parent: ins.parent, ...(ins.index !== undefined && { index: ins.index + k }), root, nodes: sub })
            inserted.push(root)
          })
        }
        if (input.remove?.length) ops.push({ type: "designRemove", shape: shapeId, ids: input.remove })
        if (!ops.length) return yield* fail("Nothing to change: pass html, patches, insert or remove")
        const result = yield* apply(c.artifact.id, ops)
        return { artifact: c.artifact, shape, applied: result.applied, inserted }
      }),
    }

    // --- Docs ----------------------------------------------------------------------

    /** Store an image in a board's or doc's cell. Returns its URL for an image shape's or block's `src`. */
    const uploadImage = Effect.fn("StandardArtifactsClient.uploadImage")(function* (artifactId: string, bytes: Uint8Array, mime: string) {
      const res = yield* call(http.execute(HttpClientRequest.post(`/api/v1/artifacts/${artifactId}/assets`).pipe(HttpClientRequest.bodyUint8Array(bytes, mime))))
      const body = (yield* call(res.json)) as { url?: string; message?: string }
      if (res.status !== 201 || !body.url) return yield* fail(body.message ?? `Upload failed (${res.status})`)
      return body.url
    })

    /** Download an image shape's bytes (by shape id) so an agent can look at it. */
    const downloadImage = Effect.fn("StandardArtifactsClient.downloadImage")(function* (ref: string, shapeId: string) {
      const c = yield* content(ref, "board")
      const shape = c.state.items.find((s) => s.id === shapeId)
      if (!shape || shape.kind !== "image" || !shape.src) return yield* fail(`No image shape "${shapeId}" on ${c.artifact.title}`)
      // Our own assets go through the authenticated client; external https images are fetched as-is.
      const client = shape.src.startsWith("/") ? http : plain
      const res = yield* call(client.execute(HttpClientRequest.get(shape.src)))
      if (res.status !== 200) return yield* fail(`Download failed (${res.status})`)
      const bytes = new Uint8Array(yield* call(res.arrayBuffer))
      return { shape, bytes, mime: res.headers["content-type"] ?? "application/octet-stream" }
    })

    // --- Trackers ------------------------------------------------------------------

    const whoami = Effect.fn("StandardArtifactsClient.whoami")(function* () {
      return (yield* call(api.workspace.snapshot())).principal
    })

    /** "me", an agent ("claude", "ChatGPT"), or a person already on an issue (by name or id). */
    const assignee = (state: TrackerState, p: Principal, ref: string): Effect.Effect<Assignee, StandardArtifactsError> => {
      const lower = ref.trim().toLowerCase()
      if (lower === "me") {
        if (p.actor.type === "user") return Effect.succeed({ type: "user", id: p.actor.id, name: p.actor.name })
        if (p.actor.type === "agent") return Effect.succeed({ type: "agent", id: (p.actor.name ?? p.actor.id).toLowerCase(), name: actorName(p.actor) })
        return fail("Guests can't take issues")
      }
      const agent = knownAgents.find((a) => a.id === lower || a.name.toLowerCase() === lower)
      if (agent) return Effect.succeed({ type: "agent", ...agent })
      const people = new Map<string, IssuePerson>()
      if (p.actor.type === "user") people.set(p.actor.id, { id: p.actor.id, name: p.actor.name })
      for (const i of issuesOf(state)) {
        if (i.owner) people.set(i.owner.id, i.owner)
        if (i.delegate?.type === "user") people.set(i.delegate.id, { id: i.delegate.id, name: i.delegate.name })
      }
      const person = [...people.values()].find((x) => x.id === ref || x.name.toLowerCase() === lower)
      if (person) return Effect.succeed({ type: "user", ...person })
      return fail(`No one called "${ref}". Use "me", an agent (${knownAgents.map((a) => a.id).join(", ")}), or someone already on an issue: ${[...people.values()].map((x) => x.name).join(", ") || "nobody yet"}`)
    }

    const issue = (state: TrackerState, ref: string): Effect.Effect<Issue, StandardArtifactsError> => {
      const i = findIssue(state, ref)
      return i ? Effect.succeed(i) : fail(`No issue "${ref}" (use its number, like 12 or #12, or its id)`)
    }

    const time = () => new Date().toISOString()

    /** "#12" (or "12") is an issue in this tracker; anything else is an artifact id or title. */
    const linkRefs = Effect.fn("StandardArtifactsClient.tracker.linkRefs")(function* (trackerId: string, state: TrackerState, refs: ReadonlyArray<string>) {
      const out: Array<ArtifactRef> = []
      for (const ref of refs) {
        const r = ref.trim()
        if (!r) continue
        if (/^#?\d+$/.test(r)) {
          const i = yield* issue(state, r)
          out.push({ artifactId: trackerId, item: i.id })
        } else {
          const a = yield* resolve(r)
          out.push({ artifactId: a.id })
        }
      }
      return out
    })

    const tracker = {
      issues: Effect.fn("StandardArtifactsClient.tracker.issues")(function* (ref: string) {
        const c = yield* content(ref, "tracker")
        return { artifact: c.artifact, issues: issuesOf(c.state), state: c.state }
      }),
      /** Create an issue. `owner` defaults to you when you're a person; `source` says where it came from. */
      create: Effect.fn("StandardArtifactsClient.tracker.create")(function* (
        ref: string,
        input: {
          readonly title: string
          readonly description?: string | undefined
          readonly status?: IssueStatus | undefined
          readonly priority?: IssuePriority | undefined
          readonly labels?: ReadonlyArray<string> | undefined
          readonly owner?: string | null | undefined
          readonly delegate?: string | null | undefined
          readonly due?: string | null | undefined
          readonly source: IssueSource
          /** Display name of who's creating it, when it isn't the account's (e.g. "ChatGPT" over MCP). */
          readonly by?: string | undefined
          /** What it's about: artifact ids or titles, or "#12" for another issue here. */
          readonly links?: ReadonlyArray<string> | undefined
        },
      ) {
        const c = yield* content(ref, "tracker")
        const links = input.links?.length ? yield* linkRefs(c.artifact.id, c.state, input.links) : []
        const p = yield* whoami()
        const owner = input.owner === null ? null : input.owner !== undefined ? yield* assignee(c.state, p, input.owner) : p.actor.type === "user" ? yield* assignee(c.state, p, "me") : null
        if (owner && owner.type === "agent") return yield* fail("An owner is a person; agents can be delegates")
        const delegate = input.delegate ? yield* assignee(c.state, p, input.delegate) : null
        const item: Issue = {
          type: "issue",
          id: newId("is_"),
          number: 0,
          title: input.title,
          ...(input.description && { description: input.description }),
          status: input.status ?? "todo",
          priority: input.priority ?? "none",
          ...(input.labels?.length && { labels: [...input.labels] }),
          owner: owner ? { id: owner.id, name: owner.name } : null,
          delegate,
          ...(input.due !== undefined && { due: input.due }),
          ...(links.length && { links }),
          source: input.source,
          createdByName: input.by ?? actorName(p.actor),
          createdAt: time(),
        }
        yield* apply(c.artifact.id, [{ type: "insert", item }])
        const after = yield* content(c.artifact.id, "tracker")
        const created = issuesOf(after.state).find((i) => i.id === item.id)
        if (!created) return yield* fail("The issue wasn't created")
        return { artifact: c.artifact, issue: created }
      }),
      /** Change an issue's fields. `owner`/`delegate` take the same names as `create`; null clears. */
      update: Effect.fn("StandardArtifactsClient.tracker.update")(function* (
        ref: string,
        issueRef: string,
        input: Omit<TrackerPatch, "owner" | "delegate" | "state" | "summary" | "endedAt" | "text" | "links"> & {
          readonly owner?: string | null
          readonly delegate?: string | null
          /** Add links: artifact ids or titles, or "#12" for another issue here. */
          readonly link?: ReadonlyArray<string>
          /** Remove links, named the same way. */
          readonly unlink?: ReadonlyArray<string>
        },
      ) {
        const c = yield* content(ref, "tracker")
        const i = yield* issue(c.state, issueRef)
        const p = yield* whoami()
        const { owner: ownerRef, delegate: delegateRef, link, unlink, ...rest } = input
        const patch: { -readonly [K in keyof TrackerPatch]: TrackerPatch[K] } = { ...rest }
        if (link?.length || unlink?.length) {
          const add = link?.length ? yield* linkRefs(c.artifact.id, c.state, link) : []
          const drop = unlink?.length ? yield* linkRefs(c.artifact.id, c.state, unlink) : []
          const kept = (i.links ?? []).filter((l) => !drop.some((d) => sameRef(d, l)))
          patch.links = [...kept, ...add.filter((a) => !kept.some((l) => sameRef(l, a)))]
        }
        if (ownerRef !== undefined) {
          const o = ownerRef === null ? null : yield* assignee(c.state, p, ownerRef)
          if (o?.type === "agent") return yield* fail("An owner is a person; agents can be delegates")
          patch.owner = o ? { id: o.id, name: o.name } : null
        }
        if (delegateRef !== undefined) patch.delegate = delegateRef === null ? null : yield* assignee(c.state, p, delegateRef)
        yield* apply(c.artifact.id, [{ type: "update", id: i.id, patch }])
        return { artifact: c.artifact, issue: i }
      }),
      comment: Effect.fn("StandardArtifactsClient.tracker.comment")(function* (ref: string, issueRef: string, text: string, by?: string) {
        const c = yield* content(ref, "tracker")
        const i = yield* issue(c.state, issueRef)
        const p = yield* whoami()
        const id = newId("c_")
        yield* apply(c.artifact.id, [{ type: "insert", item: { type: "comment", id, issueId: i.id, text, name: by ?? actorName(p.actor), at: time() } }])
        return { artifact: c.artifact, issue: i, commentId: id }
      }),
      /** Start a run: you (an agent) are working this issue now. Steps and the outcome are recorded on it. */
      startRun: Effect.fn("StandardArtifactsClient.tracker.startRun")(function* (ref: string, issueRef: string, info: { readonly client?: string | undefined; readonly model?: string | undefined; readonly agentName?: string | undefined } = {}) {
        const c = yield* content(ref, "tracker")
        const i = yield* issue(c.state, issueRef)
        const p = yield* whoami()
        const run: Run = {
          type: "run",
          id: newId("r_"),
          issueId: i.id,
          agent: { id: actorKey(p.actor), name: info.agentName ?? actorName(p.actor) },
          ...(info.client && { client: info.client }),
          ...(info.model && { model: info.model }),
          state: "running",
          startedAt: time(),
          steps: [],
        }
        yield* apply(c.artifact.id, [{ type: "insert", item: run }])
        return { artifact: c.artifact, issue: i, run }
      }),
      logStep: Effect.fn("StandardArtifactsClient.tracker.logStep")(function* (trackerId: string, runId: string, step: Omit<RunStep, "at">) {
        return yield* apply(trackerId, [{ type: "runStep", run: runId, step: { at: time(), ...step } }])
      }),
      /** Finish a run: `needs_review` when a person should check the work, `done`, or `failed`. */
      completeRun: Effect.fn("StandardArtifactsClient.tracker.completeRun")(function* (trackerId: string, runId: string, outcome: { readonly state: Exclude<RunState, "running">; readonly summary?: string | undefined }) {
        return yield* apply(trackerId, [{ type: "update", id: runId, patch: { state: outcome.state, endedAt: time(), ...(outcome.summary && { summary: outcome.summary }) } }])
      }),
    }

    const doc = {
      /**
       * Append markdown as blocks, at the end or after a block id. With `suggest`,
       * the blocks arrive as a pending suggestion that a person accepts or discards.
       */
      appendMarkdown: Effect.fn("StandardArtifactsClient.doc.appendMarkdown")(function* (ref: string, markdown: string, after?: string, suggest?: SuggestAs) {
        const c = yield* content(ref, "doc")
        const parsed = markdownToBlocks(markdown, () => newId("k_"))
        const blocks = suggest ? parsed.map((b) => ({ ...b, suggestion: { kind: "insert" as const, by: suggest.by, ...(suggest.mentionId && { mentionId: suggest.mentionId }) } })) : parsed
        if (!blocks.length) return yield* fail("Nothing to append")
        // Replace a lone empty starter paragraph instead of leaving it above the new content.
        // The reserved "page" record (icon, cover) isn't a block, so it doesn't count.
        const blocksNow = c.state.items.filter((i) => i.id !== "page")
        const only = blocksNow.length === 1 ? blocksNow[0] : undefined
        const ops: Array<unknown> = only && only.type === "paragraph" && only.text === "" && !after ? [{ type: "remove", ids: [only.id] }] : []
        let anchor: string | undefined = after
        for (const item of blocks) {
          ops.push(anchor === undefined ? { type: "insert", item } : { type: "insert", item, after: anchor })
          anchor = item.id
        }
        yield* apply(c.artifact.id, ops)
        return { artifact: c.artifact, blockIds: blocks.map((b) => b.id) }
      }),
      /**
       * With `suggest`, a text change becomes a pending "replace" that remembers the
       * original, so discarding restores it. A block that is already the agent's own
       * pending insert stays an insert; a block already pending a replace keeps its
       * first original.
       */
      updateBlock: Effect.fn("StandardArtifactsClient.doc.updateBlock")(function* (ref: string, blockId: string, patch: BlockPatch, suggest?: SuggestAs) {
        const c = yield* content(ref, "doc")
        if (!suggest || patch.text === undefined) return yield* apply(c.artifact.id, [{ type: "update", id: blockId, patch }])
        const block = c.state.items.find((b) => b.id === blockId)
        if (!block) return yield* fail(`No block "${blockId}"`)
        const pending = block.suggestion
        const suggestion =
          pending?.kind === "insert"
            ? pending
            : { kind: "replace" as const, by: suggest.by, original: pending?.kind === "replace" ? (pending.original ?? block.text) : block.text, ...(suggest.mentionId && { mentionId: suggest.mentionId }) }
        return yield* apply(c.artifact.id, [{ type: "update", id: blockId, patch: { ...patch, suggestion } }])
      }),
    }

    // --- Folders -------------------------------------------------------------------

    const isRoot = (ref: string) => parseFolderPath(ref).length === 0

    const listFolders = () => call(api.workspace.snapshot()).pipe(Effect.map((snap) => snap.folders))

    /** A folder by id or path ("Marketing/Launch"). */
    const resolveFolder = Effect.fn("StandardArtifactsClient.folder.resolve")(function* (ref: string) {
      const folders = yield* listFolders()
      const hit = folders.find((f) => f.id === ref) ?? findFolderByPath(folders, parseFolderPath(ref))
      if (!hit) return yield* fail(`No folder matches "${ref}"`)
      return hit
    })

    /** The folder at a path, creating whatever's missing along the way (like mkdir -p). An id must exist. */
    const ensureFolder = Effect.fn("StandardArtifactsClient.folder.ensure")(function* (ref: string) {
      let folders = yield* listFolders()
      const byId = folders.find((f) => f.id === ref)
      if (byId) return byId
      const segments = parseFolderPath(ref)
      const [first] = segments
      if (first === undefined) return yield* fail("A folder needs a name")
      let current: Folder | undefined
      for (const name of segments) {
        const parentId: string | null = current?.id ?? null
        let next: Folder | undefined = folders.find((f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase())
        if (!next) {
          next = yield* call(api.workspace.createFolder({ payload: { name, parentId } }))
          folders = [...folders, next]
        }
        current = next
      }
      return current!
    })

    const folder = {
      list: listFolders,
      resolve: resolveFolder,
      ensure: ensureFolder,
      /** Rename it, move it under `parent` ("/" is the root), or both. */
      update: Effect.fn("StandardArtifactsClient.folder.update")(function* (ref: string, change: { readonly name?: string | undefined; readonly parent?: string | undefined }) {
        const target = yield* resolveFolder(ref)
        const parentId = change.parent === undefined ? undefined : isRoot(change.parent) ? null : (yield* resolveFolder(change.parent)).id
        return yield* call(
          api.workspace.updateFolder({
            params: { id: target.id },
            payload: { ...(change.name !== undefined && { name: change.name }), ...(parentId !== undefined && { parentId }) },
          }),
        )
      }),
      /** Delete only the folder: what's inside moves up to its parent. */
      remove: Effect.fn("StandardArtifactsClient.folder.remove")(function* (ref: string) {
        const target = yield* resolveFolder(ref)
        return yield* call(api.workspace.deleteFolder({ params: { id: target.id } }))
      }),
      /** Put an artifact in a folder (created if the path is new), or at the root with "/". */
      move: Effect.fn("StandardArtifactsClient.folder.move")(function* (artifactRef: string, to: string) {
        const artifact = yield* resolve(artifactRef)
        const folderId = isRoot(to) ? null : (yield* ensureFolder(to)).id
        return yield* call(api.workspace.moveArtifact({ params: { id: artifact.id }, payload: { folderId } }))
      }),
    }

    // --- Sharing -------------------------------------------------------------------

    const share = {
      /** Who can open an artifact: the org's people and agents, plus its share link. */
      access: Effect.fn("StandardArtifactsClient.share.access")(function* (ref: string) {
        const artifact = yield* resolve(ref)
        return yield* call(api.sharing.access({ params: { id: artifact.id } }))
      }),
      /** Turn on the read-only link (or return the one that's on). `url` is ready to send. */
      link: Effect.fn("StandardArtifactsClient.share.link")(function* (ref: string) {
        const artifact = yield* resolve(ref)
        const link = yield* call(api.sharing.createLink({ params: { id: artifact.id } }))
        return { ...link, url: new URL(link.path, connection.url).toString() }
      }),
      /** Turn the link off for everyone who has it. */
      unlink: Effect.fn("StandardArtifactsClient.share.unlink")(function* (ref: string) {
        const artifact = yield* resolve(ref)
        yield* call(api.sharing.deleteLink({ params: { id: artifact.id } }))
      }),
    }

    return {
      api,
      list,
      resolve,
      read,
      apply,
      presence,
      /** `client` is the app creating it ("Claude Code"), shown as the creator's mark. */
      create: (kind: ArtifactKind, title?: string, client?: string, folderId?: string) =>
        call(api.workspace.createArtifact({ payload: { kind, ...(title && { title }), ...(client && { client }), ...(folderId && { folderId }) } })),
      rename: (id: string, title: string) => call(api.workspace.updateArtifact({ params: { id }, payload: { title } })),
      remove: (id: string) => call(api.workspace.deleteArtifact({ params: { id } })),
      /** Hide an artifact everywhere and keep its content, until `restore`. */
      archive: (id: string) => call(api.workspace.archiveArtifact({ params: { id } })),
      archived: () => call(api.workspace.archivedArtifacts()),
      search: (q: string, options: { readonly kind?: ArtifactKind | undefined; readonly limit?: number | undefined } = {}) =>
        call(api.search.query({ query: { q, ...(options.kind && { kind: options.kind }), ...(options.limit !== undefined && { limit: options.limit }) } })),
      reindex: () => call(api.search.reindex()),
      /** Bring back an archived artifact, by id or title. */
      restore: Effect.fn("StandardArtifactsClient.restore")(function* (ref: string) {
        const all = yield* call(api.workspace.archivedArtifacts())
        const hit = match(all, ref)
        if (!hit) return yield* fail(`No archived artifact matches "${ref}"`)
        return yield* call(api.workspace.restoreArtifact({ params: { id: hit.id } }))
      }),
      /** Remove items from any surface: table rows, board shapes, or doc blocks. */
      removeItems: Effect.fn("StandardArtifactsClient.removeItems")(function* (ref: string, ids: ReadonlyArray<string>) {
        const artifact = yield* resolve(ref)
        return yield* apply(artifact.id, [artifact.kind === "table" ? { type: "removeRows", rowIds: ids } : { type: "remove", ids }])
      }),
      table,
      board,
      doc,
      tracker,
      folder,
      whoami,
      share,
      uploadImage,
      downloadImage,
    }
  }).pipe(Effect.provide(FetchHttpClient.layer))

/** Free slots for new board items: a column to the right of everything already there. */
function nextSlots(state: BoardState, n: number) {
  const boxes = state.items.filter((s) => s.kind !== "arrow")
  const x = boxes.length ? Math.max(...boxes.map((s) => s.x + s.w)) + 60 : 0
  const y = boxes.length ? Math.min(...boxes.map((s) => s.y)) : 0
  return Array.from({ length: n }, (_, i) => ({ x, y: y + i * 170 }))
}

export class StandardArtifactsClient extends Context.Service<StandardArtifactsClient, Effect.Success<ReturnType<typeof make>>>()("@standard-artifacts/StandardArtifactsClient") {
  static readonly layer = (connection: Connection) => Layer.effect(StandardArtifactsClient, make(connection))

  /**
   * STDARTIFACTS_URL (default http://localhost:5173), STDARTIFACTS_TOKEN, STDARTIFACTS_AS. `defaultAs` applies
   * when STDARTIFACTS_AS is unset (the MCP server defaults to "agent" so its edits are
   * attributed to an agent).
   */
  static readonly layerConfig = (options: { readonly defaultAs?: string } = {}) =>
    Layer.effect(
      StandardArtifactsClient,
      Effect.gen(function* () {
        const url = yield* Config.String("STDARTIFACTS_URL").pipe(Config.withDefault("http://localhost:5173"))
        const token = yield* Config.option(Config.Redacted("STDARTIFACTS_TOKEN"))
        const as = yield* Config.option(Config.String("STDARTIFACTS_AS"))
        return yield* make({ url, token: Option.getOrUndefined(token), as: Option.getOrUndefined(as) ?? options.defaultAs })
      }).pipe(Effect.orDie),
    )
}

export type Client = StandardArtifactsClient["Service"]

/** Width and height from a PNG header (bytes 16–23), or undefined if it isn't a PNG. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { w: v.getUint32(16), h: v.getUint32(20) }
}
export type { Artifact, RoomContent }
export { assetPath, cellKey }
