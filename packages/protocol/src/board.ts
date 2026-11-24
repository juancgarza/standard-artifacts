import { Schema } from "effect"
import { ArtifactRef, Id } from "./core.ts"
import {
  designTags,
  designTreeError,
  insertDesignNodes,
  maxDesignNodes,
  moveDesignNode,
  patchDesignNode,
  removeDesignNodes,
  type DesignResult,
} from "./design.ts"
import { applyListOp, listOpSchema, mergePatch, type ListOp, type ListResult, type ListState } from "./list.ts"
import { refText } from "./table.ts"

/**
 * Board surface: shapes on an infinite canvas. List order is z-order (last is on
 * top).
 *
 * Arrows: each end is either attached to a shape (`from` / `to`, so it follows
 * the shape as it moves) or a free point in world coordinates: the start is
 * `x, y` when `from` is absent, the end is `x2, y2` when `to` is absent. `w` and
 * `h` are unused (0). Arrows stored before free ends existed have both `from`
 * and `to` and x = y = w = h = 0, which this reads exactly as before.
 *
 * Removing a shape removes every arrow attached to it, including arrows whose
 * other end is free: an arrow that pointed at something deleted no longer says
 * anything, and keeping a "remove" op a pure removal means storage only ever
 * deletes rows for it.
 *
 * HTML embeds (`kind: "html"`) carry a self-contained snippet in `html` and
 * their title in `text`; the board renders them in a sandboxed iframe. Only
 * html shapes have `html`, and a shape can't change to or from an embed, so a
 * note never silently carries (or loses) source code.
 *
 * Design frames (`kind: "design"`) carry a node tree in `design` (see
 * ./design.ts) rendered as real DOM, and their title in `text`. The same
 * one-way rule applies: only design shapes have `design`. Besides replacing the
 * whole tree (`update` with `design`), the design ops below edit single nodes,
 * so people working on different layers of one frame don't overwrite each other.
 *
 * Links (`kind: "artifact"`) show another artifact, or one item in it, as a
 * read-only preview. `ref` says what; it's fixed when the link is added, and only
 * links have it. Access is checked when it's viewed, as with a doc's embeds.
 */

export const ShapeKind = Schema.Literals(["note", "rect", "ellipse", "text", "frame", "arrow", "image", "html", "design", "artifact"])
export type ShapeKind = typeof ShapeKind.Type

export const ShapeColor = Schema.Literals(["yellow", "blue", "green", "pink", "purple", "gray"])
export type ShapeColor = typeof ShapeColor.Type

/** Text size of notes, boxes and text; absent means the kind's default ("m"). */
export const TextSize = Schema.Literals(["s", "m", "l", "xl"])
export type TextSize = typeof TextSize.Type

const Coord = Schema.Finite.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }))
const Size = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))
const Text = Schema.String.check(Schema.isMaxLength(10_000))
/**
 * HTML embed source cap. A shape is one SQLite row (2 MB max) and every save is
 * also an op in the log; 200k UTF-16 units is at most ~600 KB of UTF-8, which
 * leaves room for the rest of the row and is plenty for a widget or mockup.
 */
export const maxHtmlLength = 200_000
const Html = Schema.String.check(Schema.isMaxLength(maxHtmlLength))

/*
 * Design trees. The schema checks structure and lengths; the allowlists (tags,
 * CSS, attributes) and tree shape are checked by the reducer with the rules in
 * ./design.ts, so content stored under older rules still loads and encodes.
 */
const NodeText = Schema.String.check(Schema.isMaxLength(10_000))
const PropName = Schema.String.check(Schema.isMaxLength(64))
const PropValue = Schema.String.check(Schema.isMaxLength(150_000))
export const DesignTagSchema = Schema.Literals(designTags)
export const DesignNodeSchema = Schema.Struct({
  id: Id,
  tag: DesignTagSchema,
  text: Schema.optionalKey(NodeText),
  attrs: Schema.optionalKey(Schema.Record(PropName, PropValue)),
  style: Schema.optionalKey(Schema.Record(PropName, PropValue)),
  children: Schema.Array(Id).check(Schema.isMaxLength(maxDesignNodes)),
})
export const DesignTreeSchema = Schema.Struct({ root: Id, nodes: Schema.Record(Id, DesignNodeSchema) })
export const DesignNodePatchSchema = Schema.Struct({
  tag: Schema.optionalKey(DesignTagSchema),
  /** `null` removes the text. */
  text: Schema.optionalKey(Schema.NullOr(NodeText)),
  /** Merged per property; `null` removes one. */
  style: Schema.optionalKey(Schema.Record(PropName, Schema.NullOr(PropValue))),
  attrs: Schema.optionalKey(Schema.Record(PropName, Schema.NullOr(PropValue))),
})
const NodeIndex = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: maxDesignNodes }))

export const Shape = Schema.Struct({
  id: Id,
  kind: ShapeKind,
  x: Coord,
  y: Coord,
  w: Size,
  h: Size,
  text: Schema.optionalKey(Text),
  color: Schema.optionalKey(ShapeColor),
  textSize: Schema.optionalKey(TextSize),
  /**
   * actorKey of whoever added the shape (an agent's key is "agentId:userId").
   * Stamped by the reducer on insert, so it can't be forged; shapes stored
   * before this existed have none.
   */
  by: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /** Images only: an asset URL (/api/v1/artifacts/:id/assets/:assetId) or an https URL. `text` is the caption. */
  src: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^(https:\/\/|\/api\/v1\/artifacts\/)/))),
  /** HTML embeds only: the snippet's source (inline scripts and styles; no network except https/data images). `text` is the title. */
  html: Schema.optionalKey(Html),
  /** Design frames only: the node tree. `text` is the title. */
  design: Schema.optionalKey(DesignTreeSchema),
  /** Links only: the artifact, or the item in it, to show. */
  ref: Schema.optionalKey(ArtifactRef),
  /** Arrows only: the shapes they connect. A missing end is a free point (`x, y` for the start, `x2, y2` for the end). */
  from: Schema.optionalKey(Id),
  to: Schema.optionalKey(Id),
  /** Arrows only: the free end point, used when `to` is absent. */
  x2: Schema.optionalKey(Coord),
  y2: Schema.optionalKey(Coord),
})
export interface Shape extends Schema.Schema.Type<typeof Shape> {}

export const ShapePatch = Schema.Struct({
  x: Schema.optionalKey(Coord),
  y: Schema.optionalKey(Coord),
  w: Schema.optionalKey(Size),
  h: Schema.optionalKey(Size),
  text: Schema.optionalKey(Text),
  color: Schema.optionalKey(ShapeColor),
  textSize: Schema.optionalKey(TextSize),
  kind: Schema.optionalKey(ShapeKind),
  /** HTML embeds only: replace the snippet's source. */
  html: Schema.optionalKey(Html),
  /** Design frames only: replace the whole tree (prefer the design ops for small edits). */
  design: Schema.optionalKey(DesignTreeSchema),
  /** Arrows only: attach an end to a shape, or `null` to detach it (then give the free point: `x, y` or `x2, y2`). */
  from: Schema.optionalKey(Schema.NullOr(Id)),
  to: Schema.optionalKey(Schema.NullOr(Id)),
  x2: Schema.optionalKey(Coord),
  y2: Schema.optionalKey(Coord),
})
export interface ShapePatch extends Schema.Schema.Type<typeof ShapePatch> {}

/**
 * Node-level edits inside one design frame (`shape`). Each touches only the
 * nodes it names; indexes count the parent's children (without the moved node
 * for a move) and are clamped, so concurrent inserts and moves still land.
 */
export const DesignOp = Schema.Union([
  Schema.Struct({ type: Schema.tag("designNode"), shape: Id, node: Id, patch: DesignNodePatchSchema }),
  Schema.Struct({
    type: Schema.tag("designInsert"),
    shape: Id,
    parent: Id,
    index: Schema.optionalKey(NodeIndex),
    /** The inserted subtree's top node; `nodes` holds it and everything below it. */
    root: Id,
    nodes: Schema.Array(DesignNodeSchema).check(Schema.isMinLength(1), Schema.isMaxLength(maxDesignNodes)),
  }),
  Schema.Struct({ type: Schema.tag("designRemove"), shape: Id, ids: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(500)) }),
  Schema.Struct({ type: Schema.tag("designMove"), shape: Id, id: Id, parent: Id, index: Schema.optionalKey(NodeIndex) }),
])
export type DesignOp = typeof DesignOp.Type
export const designOpTypes: ReadonlySet<string> = new Set(["designNode", "designInsert", "designRemove", "designMove"])
export const isDesignOp = (op: BoardOp): op is DesignOp => designOpTypes.has(op.type)

export const BoardOp = Schema.Union([listOpSchema(Shape, ShapePatch), DesignOp])
export type BoardOp = ListOp<Shape, ShapePatch> | DesignOp
export const decodeBoardOp = Schema.decodeUnknownResult(BoardOp)

export const BoardState = Schema.Struct({ items: Schema.Array(Shape) })
export interface BoardState extends ListState<Shape> {}

export type BoardPresence = {
  /** Pointer in world coordinates. */
  cursor?: { x: number; y: number } | null
  selection?: ReadonlyArray<string>
  /** The layer selected inside a design frame. */
  design?: { shape: string; node: string } | null
  thinking?: boolean
  status?: string
}

/** Like `mergePatch`, but `from: null` / `to: null` detach an arrow end (drop the key). */
function mergeShape(shape: Shape, patch: ShapePatch): Shape {
  const { from, to, ...rest } = patch
  const next: { -readonly [K in keyof Shape]: Shape[K] } = mergePatch(shape, rest)
  if (from === null) delete next.from
  else if (from !== undefined) next.from = from
  if (to === null) delete next.to
  else if (to !== undefined) next.to = to
  return next
}

/** Why an arrow is invalid on this board, or undefined if it's fine. */
function arrowError(arrow: Shape, items: ReadonlyArray<Shape>): string | undefined {
  const target = (id: string) => items.find((s) => s.id === id && s.id !== arrow.id)
  for (const id of [arrow.from, arrow.to]) {
    if (id === undefined) continue
    const s = target(id)
    if (!s) return `Arrow end ${id} is not a shape on this board`
    if (s.kind === "arrow") return "Arrows can't attach to other arrows"
  }
  if (arrow.from !== undefined && arrow.from === arrow.to) return "An arrow can't connect a shape to itself"
  if (arrow.to === undefined && (arrow.x2 === undefined || arrow.y2 === undefined)) return "An arrow needs a `to` shape or an end point (x2, y2)"
  return undefined
}

/** Apply a node-level edit to the design frame it names. */
function applyDesignOp(state: BoardState, op: DesignOp): ListResult<Shape> {
  const at = state.items.findIndex((s) => s.id === op.shape)
  const shape = state.items[at]
  if (!shape) return { ok: false, error: "Unknown item" }
  if (shape.kind !== "design" || !shape.design) return { ok: false, error: "Not a design frame" }
  const tree = shape.design
  const result: DesignResult =
    op.type === "designNode"
      ? patchDesignNode(tree, op.node, op.patch)
      : op.type === "designInsert"
        ? insertDesignNodes(tree, op.parent, op.index, op.root, op.nodes)
        : op.type === "designRemove"
          ? removeDesignNodes(tree, op.ids)
          : moveDesignNode(tree, op.id, op.parent, op.index)
  if (!result.ok) return result
  const items = [...state.items]
  items[at] = { ...shape, design: result.tree }
  return { ok: true, state: { items } }
}

export function applyBoardOp(state: BoardState, op: BoardOp, by: string): ListResult<Shape> {
  if (isDesignOp(op)) return applyDesignOp(state, op)
  if (op.type === "insert") {
    // Authorship is whoever sent the insert, whatever the item says.
    if (by) op = { ...op, item: { ...op.item, by } }
    if (op.item.kind === "arrow") {
      const error = arrowError(op.item, state.items)
      if (error) return { ok: false, error }
    } else if (op.item.from !== undefined || op.item.to !== undefined) {
      return { ok: false, error: "Only arrows have from/to" }
    }
    if (op.item.kind !== "html" && op.item.html !== undefined) return { ok: false, error: "Only html shapes have html" }
    if (op.item.kind === "design") {
      if (!op.item.design) return { ok: false, error: "A design frame needs a design" }
      const error = designTreeError(op.item.design)
      if (error) return { ok: false, error }
    } else if (op.item.design !== undefined) return { ok: false, error: "Only design frames have a design" }
    if (op.item.kind === "artifact" && !op.item.ref) return { ok: false, error: "A link needs a ref" }
    if (op.item.kind !== "artifact" && op.item.ref !== undefined) return { ok: false, error: "Only links have a ref" }
  }
  if (op.type === "update") {
    const current = state.items.find((s) => s.id === op.id)
    if (current) {
      const next = mergeShape(current, op.patch)
      // Turning a box into an arrow (or back) would leave it without ends or with dangling ones.
      if ((current.kind === "arrow") !== (next.kind === "arrow")) return { ok: false, error: "Can't change a shape to or from an arrow" }
      if ((current.kind === "html") !== (next.kind === "html")) return { ok: false, error: "Can't change a shape to or from an html embed" }
      if (next.kind !== "html" && op.patch.html !== undefined) return { ok: false, error: "Only html shapes have html" }
      if ((current.kind === "design") !== (next.kind === "design")) return { ok: false, error: "Can't change a shape to or from a design frame" }
      if ((current.kind === "artifact") !== (next.kind === "artifact")) return { ok: false, error: "Can't change a shape to or from a link" }
      if (op.patch.design !== undefined) {
        if (next.kind !== "design") return { ok: false, error: "Only design frames have a design" }
        const error = designTreeError(op.patch.design)
        if (error) return { ok: false, error }
      }
      // Only re-validate ends the patch touches, so a recolor never fails on an arrow stored under older rules.
      const movesEnds = op.patch.from !== undefined || op.patch.to !== undefined || op.patch.x2 !== undefined || op.patch.y2 !== undefined
      if (next.kind !== "arrow") {
        if (op.patch.from != null || op.patch.to != null) return { ok: false, error: "Only arrows have from/to" }
      } else if (movesEnds) {
        const error = arrowError(next, state.items)
        if (error) return { ok: false, error }
      }
    }
  }
  if (op.type === "remove") {
    // Removing a shape also removes every arrow attached to it (by either end).
    const drop = new Set(op.ids)
    const cascade = state.items.filter((s) => s.kind === "arrow" && ((s.from && drop.has(s.from)) || (s.to && drop.has(s.to))))
    return applyListOp(state, { ...op, ids: [...new Set([...op.ids, ...cascade.map((a) => a.id)])] }, mergeShape)
  }
  return applyListOp(state, op, mergeShape)
}

/** Compact, model-friendly description of a board for agents. */
export function boardToText(state: BoardState): string {
  const byId = new Map(state.items.map((s) => [s.id, s]))
  const label = (id?: string) => {
    const s = id ? byId.get(id) : undefined
    return s ? `${s.id}${s.text ? `("${s.text.slice(0, 40)}")` : ""}` : "?"
  }
  /** Free arrow ends print as a bare point, e.g. "(120,40)". */
  const point = (x: number, y: number) => `(${Math.round(x)},${Math.round(y)})`
  const lines = [`shapes: ${state.items.length}`]
  for (const s of state.items) {
    if (s.kind === "arrow") {
      const from = s.from ? label(s.from) : point(s.x, s.y)
      const to = s.to ? label(s.to) : s.x2 !== undefined && s.y2 !== undefined ? point(s.x2, s.y2) : "?"
      lines.push(`${s.id}: arrow ${from} -> ${to}${s.color ? ` ${s.color}` : ""}${s.text ? ` "${s.text}"` : ""}`)
    }
    else if (s.kind === "html")
      // The source can be long; agents read the title and size here and get the source only when they ask for it.
      lines.push(`${s.id}: html at (${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.w)}x${Math.round(s.h)}${s.text ? ` "${s.text}"` : ""} (${(s.html ?? "").length} chars of HTML)`)
    else if (s.kind === "design")
      lines.push(`${s.id}: design at (${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.w)}x${Math.round(s.h)}${s.text ? ` "${s.text}"` : ""} (${s.design ? Object.keys(s.design.nodes).length : 0} layers; read it with board_get_design)`)
    else if (s.kind === "artifact")
      lines.push(`${s.id}: link to ${s.ref ? refText(s.ref) : "?"} at (${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.w)}x${Math.round(s.h)}`)
    else if (s.kind === "image")
      lines.push(`${s.id}: image at (${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.w)}x${Math.round(s.h)}${s.text ? ` caption "${s.text}"` : ""} src ${s.src ?? "?"}`)
    else
      lines.push(
        `${s.id}: ${s.kind} at (${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.w)}x${Math.round(s.h)}${s.color ? ` ${s.color}` : ""}${s.text ? ` "${s.text}"` : ""}`,
      )
  }
  return lines.join("\n")
}

/** A new link's size: room for a preview of the whole artifact, or of one item. */
export const linkSize = (ref: ArtifactRef) => (ref.item ? { w: 360, h: 220 } : { w: 400, h: 300 })

export const assetPath = (artifactId: string, assetId: string) => `/api/v1/artifacts/${artifactId}/assets/${assetId}`
