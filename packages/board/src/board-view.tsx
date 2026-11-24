import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleIcon,
  ClipboardTextIcon,
  CodeIcon,
  CopyIcon,
  CursorClickIcon,
  CursorIcon,
  FrameCornersIcon,
  SelectionIcon,
  SparkleIcon,
  HandIcon,
  ImageIcon,
  ImageSquareIcon,
  LinkSimpleIcon,
  LayoutIcon,
  MinusIcon,
  NoteIcon,
  PlusIcon,
  RectangleIcon,
  RobotIcon,
  SquareIcon,
  StackIcon,
  TextTIcon,
  TrashIcon,
  BoundingBoxIcon,
  type Icon,
} from "@phosphor-icons/react"
import {
  actorKey,
  targetKey,
  type Mention,
  type MentionTarget,
  applyBoardOp,
  designToHtml,
  htmlToDesign,
  isVoidTag,
  linkSize,
  maxDesignSize,
  maxHtmlLength,
  newId,
  parentOf,
  parseArtifactUrl,
  type ArtifactRef,
  type BoardOp,
  type BoardPresence,
  type BoardState,
  type DesignNodePatch,
  type DesignOp,
  type DesignTree,
  type Member,
  type Shape,
  type ShapeColor,
  type ShapeKind,
  type ShapePatch,
  type TextSize,
  snapMove,
  snapResize,
  type Guide,
} from "@standard-artifacts/protocol"
import type { RoomClient, RoomSnapshot } from "@standard-artifacts/room"
import { useMentions, useRoom, type AgentRequests } from "@standard-artifacts/room/react"
import {
  arrowHead,
  arrowLine,
  contains,
  defaults,
  distToSegment,
  palette,
  toScreen,
  toWorld,
  zoomAt,
  type Anchor,
  type Camera,
  type Point,
} from "./geometry"
import { exitMessage, htmlDefaults, looksLikeHtml, starterHtml, titleOf } from "./html"
import { HtmlEditorPanel, HtmlFrame, HtmlPlaceholder } from "./html-embed"
import { DesignContent, DesignOutlines, type LayerMark, type TextEdit } from "./design-frame"
import { addLayer, designDefaults, duplicateLayer, layerId, nudgeLayer, pastedDesignSize, starterDesign, wrapLayer, type LayerKind } from "./design-edit"
import { DesignInspector, LayersPanel } from "./design-panels"
import { AskComposer, ThreadCard, ThreadPin, threadStatus, type AskContextChip, type Thread } from "./ask"
import { autoStyle, beginLayerDrag, endLayerDrag, flowDrop, freeStyle, isAbsolute, layerElement, measureFree, moveLayerDrag, type FreePlace, type LayerDrag, type Rect as DropLine } from "./design-drag"
import { AuthorChip, FormatBar, FrameHeader, IconButton, TextEditor, ZoomMenu, coloredKinds, fontPx, sizedKinds, type Author } from "./canvas-ui"
import { alignDeltas, boundsOf, distributeDeltas, stepBackward, stepForward, type AlignEdge, type Axis, type Delta, type Move } from "./arrange"
import { canvasMenu, layerMenu, shapeMenu, type BoardMenuActions } from "./board-menu"
import { ContextMenu, isMac, type MenuEntry } from "./context-menu"
import { cloneShapes, readClipboard, recallCopied, rememberCopied, selfContained, shapesFromHtml, shapesText, shapesToHtml, writeShapes } from "./clipboard"

export type BoardRoom = RoomClient<BoardState, BoardOp>
export type BoardSnapshot = RoomSnapshot<BoardState>

export function useBoardRoom(url: string, actorKey: string) {
  return useRoom<BoardState, BoardOp>({ url, actorKey, apply: applyBoardOp })
}

type Tool = "select" | "hand" | ShapeKind
type End = "from" | "to"
/** A position change: boxes move x/y; arrows move only their free ends (x/y start, x2/y2 end). */
type Pos = { x?: number; y?: number; x2?: number; y2?: number }
/** A local, not-yet-confirmed geometry change shown while dragging. */
type Preview = Pos & { w?: number; h?: number }
type Drag =
  | { mode: "pan"; start: Point; cam: Camera }
  | { mode: "marquee"; start: Point; base: ReadonlyArray<string> }
  /** `snapping` once the pointer has travelled far enough that lining up with a neighbour is a drag's doing, not a click's. */
  | { mode: "move"; start: Point; origin: ReadonlyArray<Shape>; lastSent: number; moved: ReadonlyMap<string, Pos>; snapping?: boolean }
  | { mode: "resize"; id: string; start: Point; origin: { w: number; h: number }; lastSent: number; size?: { w: number; h: number } }
  | { mode: "arrow"; from?: string; start: Point; down: Point }
  | { mode: "arrowEnd"; id: string; end: End; down: Point }
  /** A layer inside an entered design frame; `live` once the pointer has travelled far enough to count as a drag. */
  | { mode: "layer"; shape: string; id: string; down: Point; live?: LayerDrag; index?: number; click?: string }
/** An arrow being drawn, or an arrow end being dragged: `to` / `target` is the shape it would snap to. */
type Draft = { from?: string; start: Point; end: Point; to?: string }
type EndEdit = { id: string; end: End; point: Point; target?: string }
/** The open right-click menu: where it is on screen, the board point it was opened at, and what it's about. */
type OpenMenu = {
  x: number
  y: number
  at: Point
  /** Opened from the keyboard: the first row takes focus. */
  keyboard?: boolean
  kind: "canvas" | "shapes" | "layer"
  /** Everything under the pointer, top first. */
  under: ReadonlyArray<string>
  /** Inside a design frame: from the layer under the pointer up to the root. */
  chain: ReadonlyArray<string>
}

/** How far ⌘D puts a copy from what it copies. */
const DUPLICATE_OFFSET = 24
/** Room a new or refitted frame leaves around what it holds. */
const FRAME_PADDING = 32
/** The most ids one remove op takes (the protocol's limit). */
const REMOVE_BATCH = 500
const isTypingIn = (target: EventTarget) => target instanceof Element && !!target.closest("input,textarea,[contenteditable]")
/** A layer and everything that holds it, innermost first. */
const layerChain = (tree: DesignTree, id: string) => {
  const chain = [id]
  for (let at = parentOf(tree, id); at; at = parentOf(tree, at)) chain.push(at)
  return chain
}

const tools: Array<{ id: Tool; label: string; key: string; icon: Icon; hint?: string }> = [
  { id: "select", label: "Select", key: "v", icon: CursorIcon },
  { id: "hand", label: "Hand", key: "h", icon: HandIcon },
  { id: "note", label: "Sticky note", key: "n", icon: NoteIcon, hint: "Click to place a sticky note" },
  { id: "rect", label: "Rectangle", key: "r", icon: RectangleIcon, hint: "Click to place a rectangle" },
  { id: "ellipse", label: "Ellipse", key: "o", icon: CircleIcon, hint: "Click to place an ellipse" },
  { id: "text", label: "Text", key: "t", icon: TextTIcon, hint: "Click to place text" },
  { id: "frame", label: "Frame", key: "f", icon: FrameCornersIcon, hint: "Click to place a frame; moving it moves what's inside" },
  // "Arrow" is what people call it; "connector" keeps the FigJam name findable.
  { id: "arrow", label: "Arrow connector", key: "a", icon: ArrowUpRightIcon, hint: "Drag to draw an arrow. Start or end on a shape to connect it" },
]
const SEND_EVERY_MS = 50
/** Screen pixels a press must travel before it counts as drawing an arrow (so a stray click draws nothing). */
const ARROW_MIN_DRAG = 6
type ScreenRect = { left: number; top: number; right: number; bottom: number }
const kindLabels: Record<string, string> = { note: "Note", rect: "Rectangle", ellipse: "Ellipse", text: "Text", frame: "Frame", image: "Image", html: "Embed", design: "Design", artifact: "Link" }
const kindLabel = (s: Shape) => (s.kind === "design" || s.kind === "frame" || s.kind === "html") && s.text ? `${kindLabels[s.kind]} · ${s.text.slice(0, 24)}` : (kindLabels[s.kind] ?? "Shape")
/** Whether `node` sits somewhere inside `ancestor` in a design tree. */
function isAncestor(tree: DesignTree, ancestor: string, node: string): boolean {
  for (let at = parentOf(tree, node); at; at = parentOf(tree, at)) if (at === ancestor) return true
  return false
}
/** Screen px a press inside a design frame travels before it drags the layer. */
const LAYER_DRAG_MIN = 4
/** Screen pixels within which a dragged edge or centre jumps onto a neighbour's. Hold ⌘/Ctrl to place freely. */
const SNAP_DISTANCE = 6
/** Screen pixels a press travels before a move starts snapping, so a click with a shaky hand doesn't shift a shape onto a line. */
const SNAP_MIN_DRAG = 4
/** The line shapes share while one is dragged into place. Red, as in Figma, so it reads against any shape color. */
const GUIDE_COLOR = "#f24822"
/** Screen-pixel tolerance for picking an arrow or one of its end handles. */
const ARROW_HIT = 7
/**
 * Live iframes are the costly part of a board. Only embeds near the viewport and
 * at least this wide on screen get one; the rest show a placeholder. Past the
 * budget, the ones nearest the centre of the view win.
 */
const HTML_MIN_SCREEN_WIDTH = 90
const MAX_LIVE_HTML = 12
const nudges: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }

/**
 * A live board: an infinite canvas of shapes and connectors. Moves stream to
 * everyone at ~20 ops/s while dragging (local preview stays at full frame rate);
 * cursors and selections travel as presence.
 */
/** What the host gives a board so it can show the rest of the workspace. Without it, links show a placeholder and can't be added. */
export type BoardLinks = {
  /** The preview on the canvas. It fills its shape, and contains the link that opens it (if there's anything to open). */
  readonly embed: (ref: ArtifactRef) => ReactNode
  /** What's linked, as a link, for the selected shape's toolbar. */
  readonly chip: (ref: ArtifactRef) => ReactNode
  readonly picker: (props: { readonly onPick: (ref: ArtifactRef) => void; readonly onClose: (refocus: boolean) => void }) => ReactNode
}

export function BoardView({
  room,
  snapshot,
  uploadImage,
  ai,
  focus,
  itemLink,
  links,
}: {
  room: BoardRoom
  snapshot: BoardSnapshot
  /** Store an image and return its URL. Enables paste, drag-and-drop and the image button. */
  uploadImage?: (file: Blob) => Promise<string>
  /** The line to the agent runner. Enables Ask Claude and the threads pinned on the canvas. */
  ai?: AgentRequests
  /** A shape to open on: selected, with the camera on it (a link to one shape). */
  focus?: string | undefined
  /** The address of one shape. Enables Copy link on a selected shape. */
  itemLink?: (shapeId: string) => string
  /** Shows links to other artifacts. Enables adding them. */
  links?: BoardLinks
}) {
  const { state, self, others, status } = snapshot
  const readOnly = self?.readOnly ?? true
  const ref = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  /** Where the image picker's and link picker's result goes, when the menu opened them; otherwise the middle of the view. */
  const placeImageAt = useRef<Point | null>(null)
  const placeLinkAt = useRef<Point | null>(null)
  const [cam, setCam] = useState<Camera>({ x: -120, y: -120, zoom: 1 })
  const [tool, setTool] = useState<Tool>("select")
  const [selection, setSelection] = useState<ReadonlyArray<string>>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [preview, setPreview] = useState<ReadonlyMap<string, Preview>>(new Map())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [endEdit, setEndEdit] = useState<EndEdit | null>(null)
  /** The shape an arrow end would attach to right now (highlighted). */
  const [snap, setSnap] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null)
  /** The lines a shape being moved or resized shares with its neighbours right now. */
  const [guides, setGuides] = useState<ReadonlyArray<Guide>>([])
  /** Where a dragged design layer would land, in canvas px. */
  const [dropLine, setDropLine] = useState<DropLine | null>(null)
  /** While dragging a layer in a flow: reordering, or (⌘ held) placing freely. */
  const [layerHint, setLayerHint] = useState<"reorder" | "free" | null>(null)
  const [space, setSpace] = useState(false)
  const drag = useRef<Drag | null>(null)
  const fitted = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(0)
  /** The toolbar's picker for adding a link is open. */
  const [linking, setLinking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** The html embed that receives pointer events (one at a time); every other embed lets the canvas handle them. */
  const [interacting, setInteracting] = useState<string | null>(null)
  /** The html embed whose source is open in the side panel. */
  const [htmlEditor, setHtmlEditor] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  /**
   * Design frames, Figma-style: a click selects the frame; a double-click enters
   * it, and then clicks select the deepest layer under the pointer. Esc goes up
   * a level, and out of the frame from its root.
   */
  const [entered, setEntered] = useState<string | null>(null)
  const [layer, setLayer] = useState<string | null>(null)
  const [hoverLayer, setHoverLayer] = useState<string | null>(null)
  const [editingLayer, setEditingLayer] = useState<string | null>(null)
  const [panels, setPanels] = useState({ layers: true, inspector: true })
  /** A short, non-error message; `convert` offers to turn that html embed into a design frame. */
  const [toast, setToast] = useState<{ text: string; convert?: string } | null>(null)
  /** Set by ⌘⇧V / Ctrl+Shift+V just before the paste event: paste HTML as a design frame. */
  const pasteAsDesign = useRef(false)
  const lastPresence = useRef(0)
  const cursor = useRef<Point | null>(null)
  /** The open Ask Claude composer: what it's about and where the request will be pinned. */
  const [asking, setAsking] = useState<{ target: MentionTarget; blocks: ReadonlyArray<string>; rect: ScreenRect; context: AskContextChip } | null>(null)
  const [askBusy, setAskBusy] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  /** The thread whose card is open, by target key. */
  const [openThread, setOpenThread] = useState<string | null>(null)
  /** Names of everyone seen on this board this session, by actorKey: shapes outlive their authors' connections. */
  const names = useRef(new Map<string, string>())

  const shapes = useMemo(() => {
    const items = state?.items ?? []
    return preview.size ? items.map((s) => (preview.has(s.id) ? { ...s, ...preview.get(s.id) } : s)) : items
  }, [state, preview])
  const byId = useMemo(() => new Map(shapes.map((s) => [s.id, s])), [shapes])

  // Requests to Claude on this board, as threads pinned where they were asked.
  // An agent starting or finishing work (its presence status) refreshes them.
  const agentWake = others.filter((m) => m.actor.type === "agent").map((m) => `${actorKey(m.actor)}:${(m.presence as BoardPresence).status ?? ""}`).join("|")
  const { mentions, track } = useMentions(ai, agentWake)
  const threads = useMemo(() => {
    const byKey = new Map<string, Array<Mention>>()
    for (const m of mentions) {
      if (m.resolved || (m.target.type !== "shape" && m.target.type !== "point")) continue
      const key = targetKey(m.target)
      byKey.set(key, [...(byKey.get(key) ?? []), m])
    }
    return [...byKey].map(([key, ms]): Thread => {
      const sorted = ms.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return { key, target: sorted[0]!.target, mentions: sorted }
    })
  }, [mentions])
  /** Where a thread's pin sits on the board: its shape's top-right corner, or its spot. Null when the shape is gone. */
  const pinAt = (t: Thread): Point | null => {
    if (t.target.type === "point") return { x: t.target.x, y: t.target.y }
    if (t.target.type !== "shape") return null
    const s = byId.get(t.target.id)
    return s ? { x: s.x + s.w, y: s.y } : null
  }

  for (const m of self ? [self, ...others] : others) if (m.actor.type !== "agent") names.current.set(actorKey(m.actor), m.name)
  /** Who added a shape. Agents' keys are "agentId:userId"; they all answer to @claude. */
  const authorOf = (key: string | undefined): Author | undefined => {
    if (!key) return undefined
    if (key.includes(":")) return { key, name: "Claude", agent: true }
    return { key, name: names.current.get(key) ?? (key.startsWith("guest") ? "Guest" : "Someone"), agent: false }
  }

  const send = useCallback((op: BoardOp) => room.send(op), [room])
  const update = (id: string, patch: ShapePatch) => send({ type: "update", id, patch })

  const enteredShape = entered ? byId.get(entered) : undefined
  const tree: DesignTree | undefined = enteredShape?.kind === "design" ? enteredShape.design : undefined
  const exitDesign = () => {
    setEntered(null)
    setLayer(null)
    setHoverLayer(null)
    setEditingLayer(null)
  }
  /**
   * Entering a frame opens the Layers panel on the left and the Inspector on
   * the right; if they'd cover the frame, pan it into the space between them
   * (zooming out only when it can't fit there).
   */
  const revealBetweenPanels = (s: Shape) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const gap = { left: 264, right: r.width - 300, top: 64, bottom: r.height - 84 }
    if (gap.right - gap.left < 240) return
    const box = { left: (s.x - cam.x) * cam.zoom, top: (s.y - cam.y) * cam.zoom, right: (s.x + s.w - cam.x) * cam.zoom, bottom: (s.y + s.h - cam.y) * cam.zoom }
    if (box.left >= gap.left && box.right <= gap.right && box.top >= gap.top && box.bottom <= gap.bottom) return
    const zoom = Math.max(0.1, Math.min(cam.zoom, (gap.right - gap.left - 32) / s.w, (gap.bottom - gap.top - 32) / s.h))
    setCam({ zoom, x: s.x + s.w / 2 - (gap.left + gap.right) / 2 / zoom, y: s.y + s.h / 2 - (gap.top + gap.bottom) / 2 / zoom })
  }
  /** `reveal` pans the frame clear of the panels; never from a pointer, so what was clicked stays under it. */
  const enterDesign = (id: string, node: string | null, reveal = true) => {
    const s = byId.get(id)
    if (s && entered !== id && reveal) revealBetweenPanels(s)
    setSelection([id])
    setEntered(id)
    setLayer(node)
    setEditingLayer(null)
    setHtmlEditor(null)
    setInteracting(null)
    setPanels({ layers: true, inspector: true })
  }
  const sendDesign = (ops: ReadonlyArray<DesignOp>) => ops.forEach((op) => send(op))
  const patchLayer = (node: string, patch: DesignNodePatch) => entered && send({ type: "designNode", shape: entered, node, patch })
  /** The deepest layer of design frame `shape` under a screen point (the canvas has the pointer captured, so ask the DOM). */
  const layerAt = (shape: string, clientX: number, clientY: number) =>
    document
      .elementsFromPoint(clientX, clientY)
      .find((el) => el instanceof HTMLElement && el.dataset.nodeId && el.closest<HTMLElement>("[data-shape-id]")?.dataset.shapeId === shape)
      ?.getAttribute("data-node-id") ?? null

  // Keep selection valid when shapes disappear (someone else deleted them).
  useEffect(() => {
    if (selection.some((id) => !byId.has(id))) setSelection((sel) => sel.filter((id) => byId.has(id)))
    if (editing && !byId.has(editing)) setEditing(null)
    if (interacting && !byId.has(interacting)) setInteracting(null)
    if (htmlEditor && !byId.has(htmlEditor)) setHtmlEditor(null)
    if (entered && !tree) exitDesign()
    // Someone else deleted the selected layer: select what held it, if that's still there.
    if (tree && layer && !tree.nodes[layer]) setLayer(null)
    if (tree && editingLayer && !tree.nodes[editingLayer]) setEditingLayer(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, selection, editing, interacting, htmlEditor, tree, layer, editingLayer])

  // Track the canvas size, to know which html embeds are near the view.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Escape inside an interactive embed never reaches the canvas (it's another document), so the frame posts it.
  useEffect(() => {
    if (!interacting) return
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current?.querySelector<HTMLIFrameElement>(`[data-shape-id="${interacting}"] iframe`)
      if (!frame || e.source !== frame.contentWindow) return
      if (typeof e.data === "object" && e.data !== null && "type" in e.data && e.data.type === exitMessage) {
        setInteracting(null)
        ref.current?.focus()
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [interacting])

  // Fit the content on first load.
  useEffect(() => {
    if (fitted.current || !state || !ref.current) return
    fitted.current = true
    setCam(fit(state.items, ref.current.getBoundingClientRect()))
  }, [state])

  // After the first fit, so this camera wins. Once per link: panning away afterwards stays put.
  const focused = useRef<string | null>(null)
  useEffect(() => {
    if (!focus || focused.current === focus || !state || !ref.current) return
    const shape = state.items.find((s) => s.id === focus)
    if (!shape || shape.kind === "arrow") return
    focused.current = focus
    setSelection([focus])
    setCam(fitBoxes([shape], ref.current.getBoundingClientRect(), 1.25))
  }, [focus, state])

  // Wheel: pan, or zoom with ctrl/cmd (trackpad pinch arrives as ctrl+wheel). Must be non-passive.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Side panels scroll themselves.
      if (e.target instanceof Element && e.target.closest("[data-board-panel]")) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) setCam((c) => zoomAt(c, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01)))
      else setCam((c) => ({ ...c, x: c.x + e.deltaX / c.zoom, y: c.y + e.deltaY / c.zoom }))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const worldAt = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current!.getBoundingClientRect()
    return toWorld(cam, e.clientX - r.left, e.clientY - r.top)
  }

  // Presence replaces the whole value, so every update carries the last cursor and selections too.
  const designPresence = entered && layer ? { shape: entered, node: layer } : null
  const presence = () => room.setPresence({ cursor: cursor.current, selection, design: designPresence } satisfies BoardPresence)
  useEffect(() => {
    presence()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, entered, layer])

  const create = (kind: ShapeKind, at: Point) => {
    if (kind === "arrow" || kind === "image" || kind === "html" || kind === "design" || kind === "artifact") return
    const d = defaults[kind]
    const shape: Shape = { id: newId("s_"), kind, x: at.x - d.w / 2, y: at.y - d.h / 2, w: d.w, h: d.h, color: d.color, ...(d.text && { text: d.text }) }
    // Frames sit behind everything else.
    send({ type: "insert", item: shape, ...(kind === "frame" ? { after: null } : {}) })
    setSelection([shape.id])
    setTool("select")
    if (kind === "note" || kind === "text") setEditing(shape.id)
  }

  /** Show an artifact or item, centered on `at` (or the viewport), and select it. */
  const addLink = (target: ArtifactRef, at?: Point) => {
    if (readOnly) return
    const r = ref.current?.getBoundingClientRect()
    const point = at ?? (r ? toWorld(cam, r.width / 2, r.height / 2) : { x: 0, y: 0 })
    const { w, h } = linkSize(target)
    const id = newId("s_")
    send({ type: "insert", item: { id, kind: "artifact", x: point.x - w / 2, y: point.y - h / 2, w, h, ref: target } })
    setSelection([id])
    setTool("select")
  }

  /** Open a link shape through its preview's own link: that knows the address, or that there's nothing to open. ⌘ opens a tab, as on any link. */
  const openLink = (id: string, e: { readonly metaKey: boolean; readonly ctrlKey: boolean }) => {
    ref.current
      ?.querySelector(`[data-shape-id="${id}"] a`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: e.metaKey, ctrlKey: e.ctrlKey }))
  }

  /** Add an html embed centered on `at` (or the viewport) and select it; `edit` opens its source. */
  const addHtml = (html: string, at?: Point, edit = false) => {
    if (readOnly) return
    if (html.length > maxHtmlLength) return setNotice(`That HTML is ${html.length.toLocaleString()} characters; the limit is ${maxHtmlLength.toLocaleString()}`)
    const r = ref.current?.getBoundingClientRect()
    const point = at ?? (r ? toWorld(cam, r.width / 2, r.height / 2) : { x: 0, y: 0 })
    const { w, h } = htmlDefaults
    const id = newId("s_")
    send({ type: "insert", item: { id, kind: "html", x: point.x - w / 2, y: point.y - h / 2, w, h, html, text: titleOf(html) ?? "HTML" } })
    setSelection([id])
    setTool("select")
    if (edit) setHtmlEditor(id)
    return id
  }

  /** Add a design frame centered on `at` (or the viewport), select it, and enter it so its layers and inspector open. */
  const addDesign = (design: DesignTree, size: { w: number; h: number }, title: string, at?: Point) => {
    if (readOnly) return
    if (JSON.stringify(design).length > maxDesignSize) return setNotice("That design is too big for one frame")
    const r = ref.current?.getBoundingClientRect()
    const point = at ?? (r ? toWorld(cam, r.width / 2, r.height / 2) : { x: 0, y: 0 })
    const id = newId("s_")
    send({ type: "insert", item: { id, kind: "design", x: point.x - size.w / 2, y: point.y - size.h / 2, w: size.w, h: size.h, design, text: title } })
    setTool("select")
    enterDesign(id, design.root)
    return id
  }

  /** Replace an html embed with a design frame of the same HTML, in the same place and z-order, keeping its arrows. */
  const convertToDesign = (embedId: string) => {
    const s = byId.get(embedId)
    if (readOnly || !s || s.kind !== "html") return
    const design = htmlToDesign(s.html ?? "", { newId: layerId })
    if (JSON.stringify(design).length > maxDesignSize) return setNotice("That HTML is too big for one design frame")
    const id = newId("s_")
    send({ type: "insert", item: { id, kind: "design", x: s.x, y: s.y, w: s.w, h: s.h, design, text: s.text ?? "Design" }, after: s.id })
    for (const a of shapes) {
      if (a.kind !== "arrow") continue
      if (a.from === s.id) update(a.id, { from: id })
      if (a.to === s.id) update(a.id, { to: id })
    }
    send({ type: "remove", ids: [s.id] })
    setInteracting(null)
    enterDesign(id, design.root)
    setToast({ text: "Converted to a design frame: scripts and unsupported CSS were dropped" })
  }

  const copyHtml = (html: string, what: string) => {
    navigator.clipboard.writeText(html).then(
      () => setToast({ text: `Copied ${what} as HTML` }),
      () => setNotice("Couldn't write to the clipboard"),
    )
  }

  /** Upload images and place them (centered on `at`, or the viewport), scaled to at most 560px wide. */
  const addImages = async (files: ReadonlyArray<File>, at?: Point) => {
    if (!uploadImage || readOnly) return
    const images = files.filter((f) => f.type.startsWith("image/"))
    if (!images.length) return
    const r = ref.current?.getBoundingClientRect()
    let point = at ?? (r ? toWorld(cam, r.width / 2, r.height / 2) : { x: 0, y: 0 })
    setUploading((n) => n + images.length)
    for (const file of images) {
      try {
        const size = await createImageBitmap(file).then((b) => ({ w: b.width, h: b.height }), () => ({ w: 800, h: 500 }))
        const scale = Math.min(1, 560 / size.w)
        const w = Math.round(size.w * scale)
        const h = Math.round(size.h * scale)
        const src = await uploadImage(file)
        const id = newId("s_")
        send({ type: "insert", item: { id, kind: "image", x: point.x - w / 2, y: point.y - h / 2, w, h, src, ...(file.name && file.name !== "image.png" ? { text: file.name } : {}) } })
        setSelection([id])
        point = { x: point.x + 30, y: point.y + 30 }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Upload failed")
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.convert ? 8000 : 3000)
    return () => clearTimeout(t)
  }, [toast])

  /** Topmost non-arrow shape under a world point. */
  const shapeAt = (p: Point) => [...shapes].reverse().find((s) => s.kind !== "arrow" && contains(s, p))

  /**
   * The shape an arrow end dropped at `p` attaches to. Frames are containers, so
   * drawing inside one starts or ends a free arrow rather than binding to the frame.
   */
  const snapTarget = (p: Point, except?: string) => [...shapes].reverse().find((s) => s.kind !== "arrow" && s.kind !== "frame" && s.id !== except && contains(s, p))

  /** Both ends of an arrow (with any end being dragged swapped in), or null if an end is missing. */
  const anchors = (s: Shape): [Anchor, Anchor] | null => {
    const at = (end: End): Anchor | undefined => {
      if (endEdit?.id === s.id && endEdit.end === end) return endEdit.target ? byId.get(endEdit.target) : endEdit.point
      const id = end === "from" ? s.from : s.to
      if (id) return byId.get(id)
      if (end === "from") return { x: s.x, y: s.y }
      return s.x2 !== undefined && s.y2 !== undefined ? { x: s.x2, y: s.y2 } : undefined
    }
    const a = at("from")
    const b = at("to")
    return a && b ? [a, b] : null
  }
  const arrowLines = useMemo(() => {
    const lines = new Map<string, { p1: Point; p2: Point }>()
    for (const s of shapes) {
      if (s.kind !== "arrow") continue
      const ends = anchors(s)
      if (ends) lines.set(s.id, arrowLine(...ends))
    }
    return lines
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, byId, endEdit])

  /** Topmost arrow within a few screen pixels of a world point. */
  const arrowAt = (p: Point) =>
    [...shapes].reverse().find((s) => {
      const line = s.kind === "arrow" ? arrowLines.get(s.id) : undefined
      return line && distToSegment(p, line.p1, line.p2) <= ARROW_HIT / cam.zoom
    })

  /**
   * What a press at `p` picks. Arrows draw on top, but a shape's body wins over an
   * arrow crossing it (overlapping shapes give short arrows that would otherwise
   * steal every click); arrows win over frames and empty canvas.
   */
  const pick = (p: Point, box: Shape | undefined) => (box && box.kind !== "frame" ? box : (arrowAt(p) ?? box))

  /** Moving a frame carries what sits inside it (boxes fully inside, and arrows whose free ends are). */
  const withContents = (ids: ReadonlyArray<string>): ReadonlyArray<Shape> => {
    const out = new Map<string, Shape>()
    for (const id of ids) {
      const s = byId.get(id)
      if (!s) continue
      out.set(id, s)
      if (s.kind !== "frame") continue
      const inside = (p: Point) => contains(s, p)
      for (const c of shapes) {
        if (c.id === s.id) continue
        if (c.kind === "arrow") {
          const free = [...(c.from ? [] : [{ x: c.x, y: c.y }]), ...(c.to || c.x2 === undefined || c.y2 === undefined ? [] : [{ x: c.x2, y: c.y2 }])]
          if (free.length && free.every(inside)) out.set(c.id, c)
        } else if (inside({ x: c.x, y: c.y }) && inside({ x: c.x + c.w, y: c.y + c.h })) out.set(c.id, c)
      }
    }
    return [...out.values()]
  }

  /** Where `s` lands when moved by (dx, dy); null for an arrow whose ends are all attached (they follow their shapes). */
  const moveBy = (s: Shape, dx: number, dy: number): Pos | null => {
    if (s.kind !== "arrow") return { x: s.x + dx, y: s.y + dy }
    const pos: Pos = {
      ...(s.from ? {} : { x: s.x + dx, y: s.y + dy }),
      ...(s.to || s.x2 === undefined || s.y2 === undefined ? {} : { x2: s.x2 + dx, y2: s.y2 + dy }),
    }
    return Object.keys(pos).length ? pos : null
  }

  /** What a dragged shape can line up with: every box in view except the ones moving with it. */
  const snapTargets = (moving: ReadonlySet<string>) => {
    const right = cam.x + viewport.w / cam.zoom
    const bottom = cam.y + viewport.h / cam.zoom
    return shapes.filter((s) => s.kind !== "arrow" && !moving.has(s.id) && s.x <= right && s.x + s.w >= cam.x && s.y <= bottom && s.y + s.h >= cam.y)
  }

  const cancelArrow = () => {
    setDraft(null)
    setEndEdit(null)
    setSnap(null)
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    // On a Mac, control-click is a right-click: it arrives here as a left press, then as a contextmenu.
    if (isMac && e.button === 0 && e.ctrlKey) return
    // Presses inside an interactive embed go to its iframe, so any press the canvas sees is outside it.
    if (interacting) setInteracting(null)
    // Like a popover, an open thread closes on any press on the canvas.
    if (openThread) setOpenThread(null)
    ref.current?.focus()
    const el = (e.target as Element).closest<HTMLElement>("[data-shape-id],[data-handle],[data-frame-header]")
    const world = worldAt(e)
    const panning = e.button === 1 || space || tool === "hand" || (readOnly && tool !== "select")
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

    // Arrow end handles of the selected arrow come first: they sit on top of the shapes they attach to.
    const single = selection.length === 1 ? byId.get(selection[0]!) : undefined
    const line = single?.kind === "arrow" ? arrowLines.get(single.id) : undefined
    if (!panning && !readOnly && tool === "select" && single && line) {
      const near = (p: Point) => Math.hypot(p.x - world.x, p.y - world.y) <= (ARROW_HIT + 3) / cam.zoom
      // An end handle sits on its own shape's edge, so it wins there; over a different shape's body
      // (overlapping shapes put ends inside each other) the body wins, so that shape stays clickable.
      const under = el?.dataset.shapeId ? byId.get(el.dataset.shapeId) : undefined
      const free = (end: End) => !under || under.kind === "frame" || under.id === (end === "from" ? single.from : single.to)
      const end: End | undefined = near(line.p2) && free("to") ? "to" : near(line.p1) && free("from") ? "from" : undefined
      if (end) {
        drag.current = { mode: "arrowEnd", id: single.id, end, down: { x: e.clientX, y: e.clientY } }
        return
      }
    }
    // A frame's header tab sits above the arrows, so a press there is always the frame.
    const hitId = el?.dataset.handle ?? el?.dataset.frameHeader ?? pick(world, el?.dataset.shapeId ? byId.get(el.dataset.shapeId) : undefined)?.id

    // Inside an entered design frame, a press selects the deepest layer under it (people and guests alike).
    if (entered && !panning && tool === "select") {
      if (el?.dataset.shapeId === entered && tree) {
        const node = (e.target as Element).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId
        const deepest = node && tree.nodes[node] ? node : tree.root
        // A press inside the selected layer drags that layer (as in Figma); a click without dragging still selects the deepest one.
        const holds = !!layer && layer !== tree.root && layer !== deepest && isAncestor(tree, layer, deepest)
        const picked = holds ? layer : deepest
        if (!holds) setLayer(picked)
        if (node !== editingLayer) setEditingLayer(null)
        if (!readOnly && picked !== tree.root) drag.current = { mode: "layer", shape: entered, id: picked, down: { x: e.clientX, y: e.clientY }, ...(holds && { click: deepest }) }
        else if (holds) setLayer(deepest)
        return
      }
      if (el?.dataset.handle !== entered) exitDesign()
    }
    // ⌘/Ctrl-click reaches straight into a design frame and picks the deepest layer, as in Figma.
    if (!panning && tool === "select" && (e.metaKey || e.ctrlKey) && hitId && !el?.dataset.handle) {
      const s = byId.get(hitId)
      if (s?.kind === "design" && s.design) {
        const node = layerAt(s.id, e.clientX, e.clientY) ?? s.design.root
        enterDesign(s.id, node, false)
        if (!readOnly && node !== s.design.root) drag.current = { mode: "layer", shape: s.id, id: node, down: { x: e.clientX, y: e.clientY } }
        return
      }
    }

    if (panning || (!hitId && readOnly)) {
      drag.current = { mode: "pan", start: { x: e.clientX, y: e.clientY }, cam }
      return
    }
    if (!hitId && tool === "select") {
      // Empty canvas: drag a selection box (Shift adds to the selection). Pan with Space, the Hand tool, or scroll.
      const base = e.shiftKey ? selection : []
      setSelection(base)
      drag.current = { mode: "marquee", start: world, base }
      return
    }
    if (readOnly) {
      if (hitId) setSelection([hitId])
      return
    }
    if (tool === "arrow") {
      // Start on a shape to attach this end; anywhere else starts a free arrow.
      const from = snapTarget(world)?.id
      drag.current = { mode: "arrow", ...(from ? { from } : {}), start: world, down: { x: e.clientX, y: e.clientY } }
      setDraft({ ...(from ? { from } : {}), start: world, end: world })
      setSnap(from ?? null)
      return
    }
    if (tool !== "select") return create(tool, world)
    if (!hitId) return

    if (el?.dataset.handle) {
      const s = byId.get(hitId)
      if (s) drag.current = { mode: "resize", id: hitId, start: world, origin: { w: s.w, h: s.h }, lastSent: 0 }
      return
    }
    const next = e.shiftKey ? (selection.includes(hitId) ? selection.filter((i) => i !== hitId) : [...selection, hitId]) : selection.includes(hitId) ? selection : [hitId]
    setSelection(next)
    drag.current = { mode: "move", start: world, origin: withContents(next), lastSent: 0, moved: new Map() }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const world = worldAt(e)
    cursor.current = world
    const now = performance.now()
    if (now - lastPresence.current > SEND_EVERY_MS) {
      lastPresence.current = now
      presence()
    }
    const d = drag.current
    if (!d) {
      // Show what an arrow would attach to before the press, too.
      if (tool === "arrow" && !readOnly) setSnap(snapTarget(world)?.id ?? null)
      if (entered) {
        const node = (e.target as Element).closest<HTMLElement>("[data-node-id]")
        setHoverLayer(node?.closest<HTMLElement>("[data-shape-id]")?.dataset.shapeId === entered ? (node?.dataset.nodeId ?? null) : null)
      }
      return
    }
    if (d.mode === "layer") {
      if (!d.live) {
        if (Math.hypot(e.clientX - d.down.x, e.clientY - d.down.y) < LAYER_DRAG_MIN) return
        const el = layerElement(d.shape, d.id)
        if (!el) return
        d.live = beginLayerDrag(el, cam.zoom)
        setHoverLayer(null)
      }
      // ⌘/Ctrl held: leave auto layout and place it freely, like a Figma frame without auto layout.
      const free = !d.live.absolute && (e.metaKey || e.ctrlKey)
      moveLayerDrag(d.live, (e.clientX - d.down.x) / cam.zoom, (e.clientY - d.down.y) / cam.zoom, free)
      setLayerHint(d.live.absolute ? null : free ? "free" : "reorder")
      if (free) {
        d.index = undefined
        setDropLine(null)
      } else if (!d.live.absolute) {
        const drop = flowDrop(d.live.el, e.clientX, e.clientY)
        d.index = drop?.index
        const r = ref.current?.getBoundingClientRect()
        setDropLine(drop && r ? { ...drop.line, x: drop.line.x - r.left, y: drop.line.y - r.top } : null)
      }
      return
    }
    if (d.mode === "marquee") {
      const box = { x: Math.min(d.start.x, world.x), y: Math.min(d.start.y, world.y), w: Math.abs(world.x - d.start.x), h: Math.abs(world.y - d.start.y) }
      setMarquee({ a: d.start, b: world })
      const inBox = (p: Point) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h
      // Boxes are picked when the selection box touches them; frames and arrows only when fully inside, so a box drawn within a frame doesn't grab the frame.
      const hits = shapes.filter((s) => {
        if (s.kind === "arrow") {
          const line = arrowLines.get(s.id)
          return !!line && inBox(line.p1) && inBox(line.p2)
        }
        if (s.kind === "frame") return inBox({ x: s.x, y: s.y }) && inBox({ x: s.x + s.w, y: s.y + s.h })
        return s.x <= box.x + box.w && s.x + s.w >= box.x && s.y <= box.y + box.h && s.y + s.h >= box.y
      })
      setSelection([...new Set([...d.base, ...hits.map((s) => s.id)])])
    } else if (d.mode === "pan") {
      setCam({ ...d.cam, x: d.cam.x - (e.clientX - d.start.x) / d.cam.zoom, y: d.cam.y - (e.clientY - d.start.y) / d.cam.zoom })
    } else if (d.mode === "arrow") {
      const to = snapTarget(world, d.from)?.id
      setDraft({ ...(d.from ? { from: d.from } : {}), start: d.start, end: world, ...(to ? { to } : {}) })
      setSnap(to ?? null)
    } else if (d.mode === "arrowEnd") {
      const s = byId.get(d.id)
      const target = snapTarget(world, d.end === "from" ? s?.to : s?.from)?.id
      setEndEdit({ id: d.id, end: d.end, point: world, ...(target ? { target } : {}) })
      setSnap(target ?? null)
    } else if (d.mode === "move") {
      let dx = world.x - d.start.x
      let dy = world.y - d.start.y
      d.snapping ||= Math.hypot(dx, dy) * cam.zoom >= SNAP_MIN_DRAG
      const boxes = d.origin.filter((s) => s.kind !== "arrow")
      let lines: ReadonlyArray<Guide> = []
      if (d.snapping && boxes.length && !e.metaKey && !e.ctrlKey) {
        // Several shapes snap as one: by the edges and centre of what they cover together.
        const b = boundsOf(boxes)
        const snapped = snapMove({ ...b, x: b.x + dx, y: b.y + dy }, snapTargets(new Set(d.origin.map((s) => s.id))), SNAP_DISTANCE / cam.zoom)
        dx += snapped.dx
        dy += snapped.dy
        lines = snapped.guides
      }
      setGuides(lines)
      const next = new Map(d.origin.flatMap((s) => {
        const p = moveBy(s, dx, dy)
        return p ? [[s.id, p] as const] : []
      }))
      d.moved = next
      setPreview(next)
      if (now - d.lastSent > SEND_EVERY_MS) {
        d.lastSent = now
        for (const [id, p] of next) update(id, p)
      }
    } else if (d.mode === "resize") {
      let w = Math.max(40, d.origin.w + world.x - d.start.x)
      let h = Math.max(30, d.origin.h + world.y - d.start.y)
      const s = byId.get(d.id)
      let lines: ReadonlyArray<Guide> = []
      if (s && !e.metaKey && !e.ctrlKey) {
        const snapped = snapResize({ x: s.x, y: s.y, w, h }, snapTargets(new Set([d.id])), SNAP_DISTANCE / cam.zoom, { w: 40, h: 30 })
        w = snapped.w
        h = snapped.h
        lines = snapped.guides
      }
      setGuides(lines)
      d.size = { w, h }
      setPreview(new Map([[d.id, { w, h }]]))
      if (now - d.lastSent > SEND_EVERY_MS) {
        d.lastSent = now
        update(d.id, { w, h })
      }
    }
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const world = worldAt(e)
    const travelled = (down: Point) => Math.hypot(e.clientX - down.x, e.clientY - down.y) >= ARROW_MIN_DRAG
    // Flush the final position from the drag itself: the last move may not have rendered yet.
    if (d.mode === "layer") {
      setDropLine(null)
      setLayerHint(null)
      if (!d.live) {
        if (d.click) setLayer(d.click)
        return
      }
      endLayerDrag(d.live)
      const t = byId.get(d.shape)?.design
      const parent = t ? parentOf(t, d.id) : undefined
      if (!t || !parent) return
      if (d.live.absolute) {
        const dx = (e.clientX - d.down.x) / cam.zoom
        const dy = (e.clientY - d.down.y) / cam.zoom
        const px = (v: number) => `${Math.round(v)}px`
        send({ type: "designNode", shape: d.shape, node: d.id, patch: { style: { left: px(d.live.origin.left + dx), top: px(d.live.origin.top + dy), right: null, bottom: null } } })
      } else if (e.metaKey || e.ctrlKey) {
        placeFreely(d.shape, t, d.id, d.live.free, (e.clientX - d.down.x) / cam.zoom, (e.clientY - d.down.y) / cam.zoom)
      } else if (d.index !== undefined && t.nodes[parent]!.children.indexOf(d.id) !== d.index) {
        send({ type: "designMove", shape: d.shape, id: d.id, parent, index: d.index })
      }
      return
    }
    if (d.mode === "marquee") {
      setMarquee(null)
    } else if (d.mode === "move") {
      for (const [id, p] of d.moved) update(id, p)
      setPreview(new Map())
      setGuides([])
    } else if (d.mode === "resize") {
      if (d.size) update(d.id, d.size)
      setPreview(new Map())
      setGuides([])
    } else if (d.mode === "arrow") {
      cancelArrow()
      if (!travelled(d.down)) return
      // Every drawn arrow is kept: each end attaches to the shape it was pressed/released on, or stays a free point.
      const to = snapTarget(world, d.from)?.id
      const item: Shape = {
        id: newId("s_"),
        kind: "arrow",
        x: d.from ? 0 : d.start.x,
        y: d.from ? 0 : d.start.y,
        w: 0,
        h: 0,
        ...(d.from ? { from: d.from } : {}),
        ...(to ? { to } : { x2: world.x, y2: world.y }),
      }
      send({ type: "insert", item })
      // Like every other creation tool, the arrow tool is one-shot: back to Select with the new arrow selected.
      setSelection([item.id])
      setTool("select")
    } else if (d.mode === "arrowEnd") {
      cancelArrow()
      const s = byId.get(d.id)
      if (!s || !travelled(d.down)) return
      const target = snapTarget(world, d.end === "from" ? s.to : s.from)?.id
      update(
        d.id,
        d.end === "to"
          ? target ? { to: target } : { to: null, x2: world.x, y2: world.y }
          : target ? { from: target } : { from: null, x: world.x, y: world.y },
      )
    }
  }

  const onPointerCancel = () => {
    const d = drag.current
    if (d?.mode === "layer" && d.live) endLayerDrag(d.live)
    setDropLine(null)
    setLayerHint(null)
    drag.current = null
    cancelArrow()
    setMarquee(null)
    setPreview(new Map())
    setGuides([])
  }

  // Hit-test in world space: with pointer capture on the canvas, click/dblclick target the canvas itself.
  const onDoubleClick = (e: React.MouseEvent) => {
    const world = worldAt(e)
    const header = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((el) => el.closest<HTMLElement>("[data-frame-header]"))
      .find(Boolean)?.dataset.frameHeader
    const hit = header ? byId.get(header) : pick(world, shapeAt(world))
    // Anyone can use an embed, read-only guests included: double-click hands it the pointer.
    if (hit?.kind === "html") {
      setSelection([hit.id])
      return setInteracting(hit.id)
    }
    // Links open, for everyone: their text isn't theirs to edit.
    if (hit?.kind === "artifact") {
      setSelection([hit.id])
      return openLink(hit.id, e)
    }
    // Design frames: the first double-click enters and picks the layer under the pointer; another on a text layer edits it in place.
    if (hit?.kind === "design" && hit.design) {
      const node = layerAt(hit.id, e.clientX, e.clientY) ?? hit.design.root
      const n = hit.design.nodes[node]
      if (entered === hit.id && node === layer && n && !readOnly && !isVoidTag(n.tag) && !n.children.length) return setEditingLayer(node)
      return enterDesign(hit.id, node, false)
    }
    // Empty canvas does nothing, as in Figma: notes come from the toolbar (N) or the note tool.
    if (readOnly || !hit) return
    setSelection([hit.id])
    setEditing(hit.id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (e.key.toLowerCase() === "v" && mod) pasteAsDesign.current = e.shiftKey
    if (mod && e.key.toLowerCase() === "j" && ai && !readOnly && !editing) {
      e.preventDefault()
      return openAsk()
    }
    if (editing) return
    // The keyboard's way to the right-click menu: at the selection, or the middle of the view.
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault()
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      const box = selection.length ? selectionRect() : null
      const x = r.left + (box ? (box.left + box.right) / 2 : r.width / 2)
      const y = r.top + (box ? box.bottom : r.height / 2)
      return showMenu({ clientX: x, clientY: y }, entered && tree ? (layer ?? tree.root) : null, true)
    }
    if (entered && tree && onDesignKey(e, tree)) return
    if (e.key === "Escape" && interacting) {
      e.preventDefault()
      return setInteracting(null)
    }
    if (e.key === " ") {
      e.preventDefault()
      return setSpace(true)
    }
    // Zoom shortcuts work for everyone, and stop the browser zooming the whole page.
    if (mod && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
      e.preventDefault()
      if (e.key === "0") return zoomBy(1 / cam.zoom)
      return zoomBy(e.key === "-" ? 1 / 1.2 : 1.2)
    }
    if (e.shiftKey && e.code === "Digit1") {
      e.preventDefault()
      return fitAll()
    }
    if (e.shiftKey && e.code === "Digit2") {
      e.preventDefault()
      return fitSelection()
    }
    if (e.key === "Enter" && selection.length === 1 && byId.get(selection[0]!)?.kind === "artifact") {
      e.preventDefault()
      return openLink(selection[0]!, e)
    }
    if (mod && e.key === "a") {
      e.preventDefault()
      return setSelection(shapes.map((s) => s.id))
    }
    if (readOnly) return
    if ((e.key === "Backspace" || e.key === "Delete") && selection.length) {
      e.preventDefault()
      removeIds(selection)
      return setSelection([])
    }
    if (e.key === "Escape") {
      drag.current = null
      cancelArrow()
      return setSelection([]), setTool("select")
    }
    if (mod && selection.length && !entered) {
      if (e.key.toLowerCase() === "d") {
        e.preventDefault()
        return duplicateSelection()
      }
      // By the key's place: Shift and Option change what these type.
      if (e.code === "BracketRight") {
        e.preventDefault()
        return e.shiftKey ? bringToFront() : sendMoves(stepForward(shapes, new Set(selection)))
      }
      if (e.code === "BracketLeft") {
        e.preventDefault()
        return e.shiftKey ? sendToBack() : sendMoves(stepBackward(shapes, new Set(selection)))
      }
      if (e.altKey && e.code === "KeyG") {
        e.preventDefault()
        return frameSelection()
      }
    }
    const nudge = nudges[e.key]
    if (nudge) {
      e.preventDefault()
      if (!selection.length || drag.current) return
      // One update per moved shape per key press; Shift moves 10x.
      const step = e.shiftKey ? 10 : 1
      for (const s of withContents(selection)) {
        const p = moveBy(s, nudge.x * step, nudge.y * step)
        if (p) update(s.id, p)
      }
      return
    }
    if (e.key === "Enter" && selection.length === 1) {
      e.preventDefault()
      // An embed's text is its title, edited with its source in the panel; Enter on a design frame enters it.
      const s = byId.get(selection[0]!)
      if (s?.kind === "design" && s.design) return enterDesign(s.id, s.design.root)
      return s?.kind === "html" ? setHtmlEditor(s.id) : setEditing(selection[0]!)
    }
    const t = tools.find((t) => t.key === e.key.toLowerCase())
    if (t && !e.metaKey && !e.ctrlKey && !e.altKey) setTool(t.id)
  }

  /** Keys inside an entered design frame. Returns true when handled (the canvas then does nothing else). */
  const onDesignKey = (e: React.KeyboardEvent, t: DesignTree): boolean => {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === "Escape") {
      e.preventDefault()
      if (layer && layer !== t.root) setLayer(parentOf(t, layer) ?? t.root)
      else exitDesign()
      return true
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      // Never delete the whole frame from inside it.
      e.preventDefault()
      if (!readOnly && layer && layer !== t.root) removeLayer(layer, t)
      return true
    }
    if (e.key === "Enter" && layer) {
      e.preventDefault()
      const n = t.nodes[layer]
      if (n && !readOnly && !isVoidTag(n.tag) && !n.children.length) setEditingLayer(layer)
      else if (n?.children[0]) setLayer(n.children[0])
      return true
    }
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault()
      if (!readOnly && layer) runLayer(duplicateLayer(entered!, t, layer))
      return true
    }
    // Arrows move an absolutely positioned layer (Shift: 10px), and reorder a layer in a flow.
    const nudge = nudges[e.key]
    if (nudge) {
      e.preventDefault()
      if (readOnly || !layer || layer === t.root || !entered) return true
      const el = layerElement(entered, layer)
      if (el && isAbsolute(el)) {
        const step = e.shiftKey ? 10 : 1
        const cs = getComputedStyle(el)
        const px = (v: number) => `${Math.round(v)}px`
        patchLayer(layer, { style: { left: px((parseFloat(cs.left) || 0) + nudge.x * step), top: px((parseFloat(cs.top) || 0) + nudge.y * step), right: null, bottom: null } })
      } else {
        const op = nudgeLayer(entered, t, layer, nudge.x + nudge.y < 0 ? -1 : 1)
        if (op) send(op)
      }
      return true
    }
    return false
  }

  /**
   * Take a layer out of auto layout and pin it at `place` (moved by dx, dy).
   * Its parent becomes the positioning box if it wasn't one.
   */
  const placeFreely = (shape: string, t: DesignTree, id: string, place: FreePlace, dx = 0, dy = 0) => {
    const parent = parentOf(t, id)
    if (place.parentStatic && parent) send({ type: "designNode", shape, node: parent, patch: { style: { position: "relative" } } })
    send({ type: "designNode", shape, node: id, patch: { style: freeStyle(place, dx, dy) } })
  }
  /** A container's layout switch: Free pins every child where it is now (keeping the container's size); Auto puts them back in the flow. */
  const setChildrenFree = (shape: string, t: DesignTree, id: string, free: boolean) => {
    const node = t.nodes[id]
    const el = layerElement(shape, id)
    if (!node || !el) return
    if (!free) return node.children.forEach((c) => send({ type: "designNode", shape, node: c, patch: { style: autoStyle } }))
    // Measure everything first: each child that leaves the flow moves the rest.
    const places = node.children.flatMap((c) => {
      const child = layerElement(shape, c)
      return child && !isAbsolute(child) ? [[c, measureFree(child, cam.zoom)] as const] : []
    })
    const box = el.getBoundingClientRect()
    send({
      type: "designNode",
      shape,
      node: id,
      patch: { style: { ...(getComputedStyle(el).position === "static" && { position: "relative" }), ...(!node.style?.height && { height: `${Math.round(box.height / cam.zoom)}px` }) } },
    })
    for (const [c, place] of places) send({ type: "designNode", shape, node: c, patch: { style: freeStyle(place) } })
  }

  const runLayer = (r: { ops: ReadonlyArray<DesignOp>; id: string } | null) => {
    if (!r) return
    sendDesign(r.ops)
    setLayer(r.id)
  }
  const removeLayer = (id: string, t: DesignTree) => {
    if (!entered || id === t.root) return
    send({ type: "designRemove", shape: entered, ids: [id] })
    setLayer(parentOf(t, id) ?? t.root)
  }

  const zoomBy = (factor: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setCam((c) => zoomAt(c, r.width / 2, r.height / 2, factor))
  }
  const zoomTo = (zoom: number) => zoomBy(zoom / cam.zoom)
  const fitAll = () => ref.current && setCam(fit(shapes, ref.current.getBoundingClientRect()))
  /** Frame the selection (with whatever its frames hold), zooming in at most to 200%. */
  const fitSelection = () => {
    const r = ref.current?.getBoundingClientRect()
    const picked = withContents(selection)
    if (!r || !picked.length) return
    const points = picked.flatMap((s) => {
      const line = s.kind === "arrow" ? arrowLines.get(s.id) : undefined
      return line ? [line.p1, line.p2].map((p) => ({ ...p, w: 0, h: 0 })) : s.kind === "arrow" ? [] : [s]
    })
    setCam(fitBoxes(points, r, 2))
  }

  /** The selection's bounding box in canvas pixels (frames include their header tab), for the format bar. */
  const selectionRect = () => {
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    const add = (x: number, y: number, w = 0, h = 0, above = 0) => {
      const a = toScreen(cam, { x, y })
      left = Math.min(left, a.x)
      top = Math.min(top, a.y - above)
      right = Math.max(right, a.x + w * cam.zoom)
      bottom = Math.max(bottom, a.y + h * cam.zoom)
    }
    for (const id of selection) {
      const s = byId.get(id)
      if (!s) continue
      const line = s.kind === "arrow" ? arrowLines.get(s.id) : undefined
      if (line) (add(line.p1.x, line.p1.y), add(line.p2.x, line.p2.y))
      else if (s.kind !== "arrow") add(s.x, s.y, s.w, s.h, s.kind === "frame" ? 24 : s.kind === "html" || s.kind === "design" ? 24 * cam.zoom : 0)
    }
    return left === Infinity ? null : { left, top, right, bottom }
  }

  const recolor = (color: ShapeColor) => {
    for (const id of selection) if (coloredKinds.has(byId.get(id)?.kind ?? "image")) update(id, { color })
  }
  const resizeText = (textSize: TextSize) => {
    for (const id of selection) {
      const s = byId.get(id)
      if (!s || !sizedKinds.has(s.kind)) continue
      // A text shape is one line tall; grow it so a bigger size isn't clipped.
      const h = s.kind === "text" ? Math.max(s.h, Math.ceil(fontPx({ ...s, textSize }) * 1.4) + 8) : s.h
      update(id, h === s.h ? { textSize } : { textSize, h })
    }
  }
  const bringToFront = () => {
    let last = shapes.at(-1)?.id ?? null
    for (const s of shapes.filter((s) => selection.includes(s.id))) {
      if (s.id !== last) send({ type: "move", id: s.id, after: last })
      last = s.id
    }
  }
  /** Frames go to the very back; everything else goes just above the frames, so it stays visible on them. */
  const sendToBack = () => {
    const picked = new Set(selection)
    let frameAfter: string | null = null
    let after: string | null = shapes.filter((s) => s.kind === "frame" && !picked.has(s.id)).at(-1)?.id ?? null
    for (const s of shapes.filter((s) => picked.has(s.id))) {
      if (s.kind === "frame") {
        send({ type: "move", id: s.id, after: frameAfter })
        frameAfter = s.id
      } else {
        send({ type: "move", id: s.id, after })
        after = s.id
      }
    }
  }
  const sendMoves = (moves: ReadonlyArray<Move>) => {
    for (const m of moves) send({ type: "move", id: m.id, after: m.after })
  }
  const removeIds = (ids: ReadonlyArray<string>) => {
    for (let i = 0; i < ids.length; i += REMOVE_BATCH) send({ type: "remove", ids: ids.slice(i, i + REMOVE_BATCH) })
  }
  const removeSelection = () => {
    removeIds(selection)
    setSelection([])
    ref.current?.focus()
  }

  /**
   * What copying `ids` takes along, in z-order: what frames hold, and the arrows
   * joining the shapes coming along, so a copied diagram stays connected.
   */
  const clipOf = (ids: ReadonlyArray<string>) => {
    const carried = new Set(withContents(ids).map((s) => s.id))
    const joining = shapes.filter((s) => s.kind === "arrow" && s.from && s.to && carried.has(s.from) && carried.has(s.to)).map((s) => s.id)
    const taken = new Set([...carried, ...joining])
    return selfContained(shapes.filter((s) => taken.has(s.id)), (id) => arrowLines.get(id))
  }
  /** Add copies to the board, frames at the back as usual, and select them. */
  const insertCopies = (copies: ReadonlyArray<Shape>) => {
    let frameAfter: string | null = null
    for (const item of copies) {
      if (item.kind === "frame") {
        send({ type: "insert", item, after: frameAfter })
        frameAfter = item.id
      } else send({ type: "insert", item })
    }
    // Selecting a frame covers what it holds, and an arrow attached at both ends follows its shapes.
    const frames = copies.filter((s) => s.kind === "frame")
    const held = (s: Shape) => frames.some((f) => f.id !== s.id && contains(f, { x: s.x, y: s.y }) && contains(f, { x: s.x + s.w, y: s.y + s.h }))
    setSelection(copies.filter((s) => (s.kind === "arrow" ? !(s.from && s.to) : !held(s))).map((s) => s.id))
    setTool("select")
  }
  const duplicateSelection = () => {
    if (readOnly) return
    insertCopies(cloneShapes(clipOf(selection), () => ({ dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET })))
  }
  /** Copies centered on a board point. */
  const pasteShapes = (list: ReadonlyArray<Shape>, at: Point) =>
    insertCopies(cloneShapes(list, (b) => ({ dx: at.x - (b.x + b.w / 2), dy: at.y - (b.y + b.h / 2) })))
  const viewCenter = (): Point => ({ x: cam.x + viewport.w / cam.zoom / 2, y: cam.y + viewport.h / cam.zoom / 2 })

  const copied = (count: number) => setToast({ text: `Copied ${count} shape${count === 1 ? "" : "s"}` })
  const copySelection = () => {
    const clip = clipOf(selection)
    if (!clip.length) return
    writeShapes(clip).then(
      () => copied(selection.length),
      // It's remembered here regardless, so Paste here still works; other windows and apps won't see it.
      () => setNotice("The browser blocked the clipboard, so this can only be pasted on this page"),
    )
  }
  const cutSelection = () => {
    if (readOnly) return
    const clip = clipOf(selection)
    if (!clip.length) return
    copySelection()
    removeIds(clip.map((s) => s.id))
    setSelection([])
  }
  const copyText = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => setToast({ text: `Copied ${what}` }),
      () => setNotice("Couldn't write to the clipboard"),
    )
  }
  const copyItemLink = (id: string) => {
    if (!itemLink) return
    void navigator.clipboard?.writeText(itemLink(id)).then(
      () => setNotice("Link copied. Paste it on an empty line in a doc to preview it"),
      () => setNotice("Couldn’t copy the link"),
    )
  }

  /** A link or HTML, as text: what a paste can make of it. Prose makes nothing, so it can be pasted past without littering the board. */
  const pasteText = (text: string, at: Point | undefined, asDesign: boolean) => {
    const link = links && !readOnly ? parseArtifactUrl(text, window.location.origin) : null
    if (link) {
      addLink(link, at)
      return true
    }
    if (readOnly || !looksLikeHtml(text)) return false
    const html = text.trim()
    // ⌘⇧V pastes straight into a design frame; a plain paste makes a live embed and offers the other.
    if (asDesign) {
      addDesign(htmlToDesign(html, { newId: layerId }), pastedDesignSize, titleOf(html) ?? "Design", at)
      return true
    }
    const id = addHtml(html, at)
    if (id) setToast({ text: "Pasted as a live HTML embed", convert: id })
    return true
  }

  /** The menu's paste. Asking for it at a spot is explicit, so unlike ⌘V, prose becomes a note there. */
  const pasteHere = async (at: Point, asDesign = false) => {
    if (readOnly) return
    const contents = await readClipboard().catch(() => null)
    if (!contents) {
      const remembered = recallCopied()
      if (remembered && !asDesign) return pasteShapes(remembered, at)
      return setNotice(`The browser blocked reading the clipboard. Press ${isMac ? "⌘" : "Ctrl+"}${asDesign ? (isMac ? "⇧" : "Shift+") : ""}V instead`)
    }
    const list = asDesign ? null : shapesFromHtml(contents.html)
    if (list?.length) return pasteShapes(list, at)
    if (!asDesign && contents.files.length) return void addImages(contents.files, at)
    if (pasteText(contents.text, at, asDesign)) return
    if (asDesign) return setNotice("There's no HTML on the clipboard")
    const words = contents.text.trim()
    if (!words) return setNotice("There's nothing to paste")
    const { w, h, color } = defaults.note
    const id = newId("s_")
    send({ type: "insert", item: { id, kind: "note", x: at.x - w / 2, y: at.y - h / 2, w, h, color, text: words.slice(0, 10_000) } })
    setSelection([id])
  }

  /** Move shapes by these amounts; a frame brings what it holds. */
  const applyDeltas = (deltas: ReadonlyMap<string, Delta>) => {
    for (const [id, { dx, dy }] of deltas) {
      if (!dx && !dy) continue
      for (const s of withContents([id])) {
        const p = moveBy(s, dx, dy)
        if (p) update(s.id, p)
      }
    }
  }
  /** The boxes to line up: what's inside a selected frame moves with it, so it isn't lined up separately. */
  const arrangeable = () => {
    const boxes = selection.flatMap((id) => byId.get(id) ?? []).filter((s) => s.kind !== "arrow")
    const frames = boxes.filter((s) => s.kind === "frame")
    return boxes.filter((s) => !frames.some((f) => f.id !== s.id && contains(f, { x: s.x, y: s.y }) && contains(f, { x: s.x + s.w, y: s.y + s.h })))
  }
  const alignSelection = (edge: AlignEdge) => applyDeltas(alignDeltas(arrangeable(), edge))
  const distributeSelection = (axis: Axis) => applyDeltas(distributeDeltas(arrangeable(), axis))

  /** A new frame around the selection, behind everything. */
  const frameSelection = () => {
    const boxes = withContents(selection).filter((s) => s.kind !== "arrow")
    if (!boxes.length) return
    const b = boundsOf(boxes)
    const id = newId("s_")
    send({
      type: "insert",
      item: { id, kind: "frame", x: b.x - FRAME_PADDING, y: b.y - FRAME_PADDING, w: b.w + FRAME_PADDING * 2, h: b.h + FRAME_PADDING * 2, color: defaults.frame.color, text: defaults.frame.text ?? "Frame" },
      after: null,
    })
    setSelection([id])
  }
  const frameContents = (id: string) => withContents([id]).filter((s) => s.id !== id)
  const fitFrame = (id: string) => {
    const boxes = frameContents(id).filter((s) => s.kind !== "arrow")
    if (!boxes.length) return
    const b = boundsOf(boxes)
    update(id, { x: b.x - FRAME_PADDING, y: b.y - FRAME_PADDING, w: b.w + FRAME_PADDING * 2, h: b.h + FRAME_PADDING * 2 })
  }
  /** Swap an arrow's ends: an attached end stays attached, a free one stays free. */
  const reverseArrow = (s: Shape) =>
    update(s.id, {
      from: s.to ?? null,
      to: s.from ?? null,
      ...(s.to ? {} : { x: s.x2 ?? 0, y: s.y2 ?? 0 }),
      ...(s.from ? {} : { x2: s.x, y2: s.y }),
    })
  const connect = (from: string, to: string) => {
    const id = newId("s_")
    send({ type: "insert", item: { id, kind: "arrow", x: 0, y: 0, w: 0, h: 0, from, to } })
    setSelection([id])
  }

  const closeMenu = useCallback(() => {
    setMenu(null)
    ref.current?.focus({ preventScroll: true })
  }, [])

  /**
   * Open the menu for what's at a point, as Figma does: a shape outside the
   * selection replaces it, one inside keeps it (so a group can be acted on), and
   * empty canvas clears it. `hit` of null means leave the selection as it is
   * (the keyboard's menu); in an entered frame, `hit` is the layer.
   */
  const showMenu = (p: { clientX: number; clientY: number }, hit: Shape | string | null | undefined, keyboard = false) => {
    const at = worldAt(p)
    const base = { x: p.clientX, y: p.clientY, at, ...(keyboard && { keyboard }) }
    setInteracting(null)
    setOpenThread(null)
    setTool("select")
    cancelArrow()
    if (typeof hit === "string") {
      if (tree) setMenu({ ...base, kind: "layer", under: [], chain: layerChain(tree, hit) })
      return
    }
    const picked = hit === null ? selection : hit ? (selection.includes(hit.id) ? selection : [hit.id]) : []
    if (hit !== null) setSelection(picked)
    const under = [...shapes].reverse().filter((s) => {
      if (s.kind !== "arrow") return contains(s, at)
      const line = arrowLines.get(s.id)
      return !!line && distToSegment(at, line.p1, line.p2) <= ARROW_HIT / cam.zoom
    })
    setMenu({ ...base, kind: picked.length ? "shapes" : "canvas", under: under.map((s) => s.id), chain: [] })
  }

  const onContextMenu = (e: ReactMouseEvent) => {
    const target = e.target as Element
    // Toolbars, panels and their links keep the browser's menu (and the tabs' own); so does text being edited.
    if ((target !== ref.current && !world.current?.contains(target)) || isTypingIn(target)) return
    e.preventDefault()
    // Mid-drag, a right press is just a slip.
    if (drag.current) return
    // Like any press outside it, this commits a text being edited.
    ref.current?.focus({ preventScroll: true })
    const el = target.closest<HTMLElement>("[data-shape-id],[data-frame-header]")
    if (entered && tree && el?.dataset.shapeId === entered) {
      const node = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId
      const deepest = node && tree.nodes[node] ? node : tree.root
      // As with a press: inside the selected layer keeps that layer selected. Everything is inside the root, so that doesn't count.
      const holds = !!layer && layer !== tree.root && (layer === deepest || isAncestor(tree, layer, deepest))
      if (!holds) setLayer(deepest)
      setEditingLayer(null)
      return showMenu(e, deepest)
    }
    if (entered) exitDesign()
    const point = worldAt(e)
    const header = el?.dataset.frameHeader
    showMenu(e, header ? byId.get(header) : pick(point, el?.dataset.shapeId ? byId.get(el.dataset.shapeId) : shapeAt(point)))
  }

  /** Whether a copy or cut event is the canvas's own: inputs, panels and thread text have their own to copy. */
  const canvasHasFocus = () => document.activeElement === ref.current
  const onCopy = (e: React.ClipboardEvent) => {
    if (editing || !canvasHasFocus()) return
    if (entered && tree) {
      e.preventDefault()
      e.clipboardData.setData("text/plain", designToHtml(tree, { from: layer ?? tree.root }))
      return setToast({ text: "Copied as HTML" })
    }
    const clip = clipOf(selection)
    if (!clip.length) return
    e.preventDefault()
    rememberCopied(clip)
    e.clipboardData.setData("text/html", shapesToHtml(clip))
    e.clipboardData.setData("text/plain", shapesText(clip))
    copied(selection.length)
  }
  const onCut = (e: React.ClipboardEvent) => {
    if (readOnly || editing || entered || !canvasHasFocus()) return
    const clip = clipOf(selection)
    if (!clip.length) return
    e.preventDefault()
    rememberCopied(clip)
    e.clipboardData.setData("text/html", shapesToHtml(clip))
    e.clipboardData.setData("text/plain", shapesText(clip))
    removeIds(clip.map((s) => s.id))
    setSelection([])
  }

  /**
   * Ask Claude, tldraw-style: about the selection, or about what's in view when
   * nothing is selected. Nothing is added to the canvas to ask; the request is
   * pinned on the shape (or the spot) it's about and answered in its thread.
   * `spot` pins an ask about the view there instead of the middle of the view.
   */
  const openAsk = (spot?: Point) => {
    if (!ai || readOnly) return
    const sources = selection.flatMap((id) => byId.get(id) ?? []).filter((s) => s.kind !== "arrow")
    setAskError(null)
    setOpenThread(null)
    if (sources.length) {
      const x = Math.min(...sources.map((s) => s.x))
      const y = Math.min(...sources.map((s) => s.y))
      const box = { x, y, w: Math.max(...sources.map((s) => s.x + s.w)) - x, h: Math.max(...sources.map((s) => s.y + s.h)) - y }
      const rect = selectionRect() ?? { left: viewport.w / 2, right: viewport.w / 2, top: viewport.h / 3, bottom: viewport.h / 3 }
      const one = sources.length === 1 ? sources[0]! : undefined
      const snippet = one?.text?.trim() && !["design", "frame", "html"].includes(one.kind) ? `: “${one.text.trim().slice(0, 24)}${one.text.trim().length > 24 ? "…" : ""}”` : ""
      return setAsking({
        // One shape: the thread follows it. Several: it's pinned at their corner.
        target: one ? { type: "shape", id: one.id } : { type: "point", x: box.x + box.w, y: box.y },
        blocks: sources.map((s) => s.id),
        rect,
        context: { label: one ? `${kindLabel(one)}${snippet}` : `${sources.length} shapes`, icon: SelectionIcon },
      })
    }
    // Nothing selected: the view is the context.
    const vw = viewport.w / cam.zoom
    const vh = viewport.h / cam.zoom
    const view = { x: cam.x, y: cam.y, w: vw, h: vh }
    const visible = shapes.filter((s) => s.kind !== "arrow" && s.x < view.x + view.w && s.x + s.w > view.x && s.y < view.y + view.h && s.y + s.h > view.y)
    const center = spot ?? { x: cam.x + vw / 2, y: cam.y + vh / 2 }
    const screen = spot && toScreen(cam, spot)
    setAsking({
      target: { type: "point", x: Math.round(center.x), y: Math.round(center.y) },
      blocks: visible.slice(0, 60).map((s) => s.id),
      rect: screen
        ? { left: screen.x - 1, right: screen.x + 1, top: screen.y - 1, bottom: screen.y + 1 }
        : { left: viewport.w / 2 - 1, right: viewport.w / 2 + 1, top: viewport.h / 2 - 140, bottom: viewport.h / 2 - 120 },
      context: { label: visible.length ? `This view · ${visible.length} shape${visible.length === 1 ? "" : "s"}` : "This view", icon: FrameCornersIcon },
    })
  }

  const submitAsk = async (text: string) => {
    if (!ai || !asking) return
    setAskBusy(true)
    setAskError(null)
    try {
      const m = await ai.ask({ target: asking.target, text, blocks: [...asking.blocks] })
      track(m)
      setAsking(null)
      setOpenThread(targetKey(asking.target))
      ref.current?.focus()
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e))
    } finally {
      setAskBusy(false)
    }
  }

  /** Embeds that get a live iframe: near the view, readable at this zoom, nearest the centre first (plus the one being used). */
  const liveHtml = useMemo(() => {
    const margin = 0.5
    const vw = viewport.w / cam.zoom
    const vh = viewport.h / cam.zoom
    const view = { x: cam.x - vw * margin, y: cam.y - vh * margin, w: vw * (1 + 2 * margin), h: vh * (1 + 2 * margin) }
    const mid = { x: cam.x + vw / 2, y: cam.y + vh / 2 }
    const near = shapes.filter(
      (s) =>
        s.kind === "html" &&
        s.w * cam.zoom >= HTML_MIN_SCREEN_WIDTH &&
        s.x < view.x + view.w &&
        s.x + s.w > view.x &&
        s.y < view.y + view.h &&
        s.y + s.h > view.y,
    )
    const dist = (s: Shape) => Math.hypot(s.x + s.w / 2 - mid.x, s.y + s.h / 2 - mid.y)
    const live = new Set(near.sort((a, b) => dist(a) - dist(b)).slice(0, MAX_LIVE_HTML).map((s) => s.id))
    if (interacting) live.add(interacting)
    return live
  }, [shapes, cam, viewport, interacting])

  const remoteSelections = useMemo(() => {
    const map = new Map<string, Member>()
    for (const m of others) for (const id of (m.presence as BoardPresence).selection ?? []) map.set(id, m)
    return map
  }, [others])

  // The commit reads the latest tree, so the edit object (and the memoized frame) stays the same while typing.
  const treeRef = useRef(tree)
  treeRef.current = tree
  const textEdit = useMemo((): TextEdit | null => {
    if (!entered || !editingLayer) return null
    return {
      node: editingLayer,
      onCommit: (text) => {
        setEditingLayer(null)
        ref.current?.focus()
        const before = treeRef.current?.nodes[editingLayer]?.text ?? ""
        if (text !== before) send({ type: "designNode", shape: entered, node: editingLayer, patch: { text: text || null } })
      },
      onCancel: () => {
        setEditingLayer(null)
        ref.current?.focus()
      },
    }
  }, [entered, editingLayer, send])

  /** Layers other people (and agents) have selected, by design frame. */
  const remoteLayers = useMemo(() => {
    const map = new Map<string, Array<LayerMark>>()
    for (const m of others) {
      const d = (m.presence as BoardPresence).design
      if (!d || typeof d.shape !== "string" || typeof d.node !== "string") continue
      map.set(d.shape, [...(map.get(d.shape) ?? []), { node: d.node, color: m.color, label: m.name, kind: "remote" }])
    }
    return map
  }, [others])

  const cursorClass = space || tool === "hand" ? "cursor-grab" : tool === "select" ? "cursor-default" : "cursor-crosshair"
  const single = selection.length === 1 ? byId.get(selection[0]!) : undefined
  const selected = selection.flatMap((id) => byId.get(id) ?? [])
  const selRect = selection.length ? selectionRect() : null
  const hint = readOnly ? undefined : tools.find((t) => t.id === tool)?.hint
  const draftLine = draft
    ? arrowLine((draft.from && byId.get(draft.from)) || draft.start, (draft.to && byId.get(draft.to)) || draft.end)
    : null
  const editingArrow = editing ? byId.get(editing) : undefined
  const editingHtml = htmlEditor && !readOnly ? byId.get(htmlEditor) : undefined
  const labelAt = editingArrow?.kind === "arrow" ? arrowLines.get(editingArrow.id) : undefined

  // Someone else deleted what the menu is about.
  useEffect(() => {
    if (menu?.kind === "shapes" && !selection.length) setMenu(null)
    if (menu?.kind === "layer" && !entered) setMenu(null)
  }, [menu, selection, entered])

  /** Built while it's open, from what's on the board now, so a change from someone else shows in it. */
  const menuEntries = (open: OpenMenu): ReadonlyArray<MenuEntry> => {
    if (open.kind === "layer") {
      if (!entered || !tree) return []
      const current = layer ?? tree.root
      return layerMenu({
        readOnly,
        tree,
        layer: current,
        chain: open.chain,
        frameTitle: enteredShape?.text ?? "Design",
        editText: () => setEditingLayer(current),
        addLayer: (kind) => runLayer(addLayer(entered, tree, current, kind)),
        duplicate: () => runLayer(duplicateLayer(entered, tree, current)),
        wrap: () => runLayer(wrapLayer(entered, tree, current)),
        nudge: (by) => {
          const op = nudgeLayer(entered, tree, current, by)
          if (op) send(op)
        },
        canNudge: (by) => nudgeLayer(entered, tree, current, by) !== null,
        selectLayer: setLayer,
        copyHtml: () => copyHtml(designToHtml(tree, { from: current }), current === tree.root ? "the frame" : "the layer"),
        remove: () => removeLayer(current, tree),
        done: exitDesign,
      })
    }
    const base: BoardMenuActions = {
      readOnly,
      create: (kind) => create(kind, open.at),
      drawArrow: () => setTool("arrow"),
      addHtml: () => addHtml(starterHtml, open.at, true),
      addDesign: () => addDesign(starterDesign(), designDefaults, "Design", open.at),
      addImage: uploadImage
        ? () => {
            placeImageAt.current = open.at
            fileInput.current?.click()
          }
        : undefined,
      addLink: links
        ? () => {
            placeLinkAt.current = open.at
            setLinking(true)
          }
        : undefined,
      ask: ai ? () => openAsk(open.kind === "canvas" ? open.at : undefined) : undefined,
      paste: (asDesign) => void pasteHere(open.at, asDesign),
      select: setSelection,
      selectAll: () => setSelection(shapes.map((s) => s.id)),
      zoomToFit: fitAll,
      zoomTo100: () => zoomTo(1),
      zoomToSelection: fitSelection,
      hasShapes: shapes.length > 0,
    }
    if (open.kind === "canvas") return canvasMenu(base)
    const picked = new Set(selection)
    return shapeMenu({
      ...base,
      selected,
      under: open.under.flatMap((id) => byId.get(id) ?? []),
      edit: setEditing,
      interacting,
      setInteracting,
      editHtml: setHtmlEditor,
      convertToDesign,
      enterDesign: (s) => s.design && enterDesign(s.id, s.design.root),
      openLink: (id, newTab) => openLink(id, { metaKey: newTab && isMac, ctrlKey: newTab && !isMac }),
      reverseArrow,
      cut: cutSelection,
      copy: copySelection,
      duplicate: duplicateSelection,
      copyText: () => copyText(selected.flatMap((s) => s.text?.trim() || []).join("\n"), "the text"),
      copyHtml: (s) => copyHtml(s.kind === "design" && s.design ? designToHtml(s.design) : (s.html ?? ""), s.kind === "design" ? "the frame" : "the embed"),
      copyLink: itemLink ? copyItemLink : undefined,
      recolor,
      resizeText,
      turnInto: (kind) => selection.forEach((id) => update(id, { kind })),
      align: alignSelection,
      distribute: distributeSelection,
      front: bringToFront,
      forward: () => sendMoves(stepForward(shapes, picked)),
      backward: () => sendMoves(stepBackward(shapes, picked)),
      back: sendToBack,
      canForward: stepForward(shapes, picked).length > 0,
      canBackward: stepBackward(shapes, picked).length > 0,
      frameSelection,
      connect,
      contents: frameContents,
      fitFrame,
      remove: removeSelection,
      removeWithContents: (id) => {
        removeIds([id, ...frameContents(id).map((s) => s.id)])
        setSelection([])
      },
    })
  }

  return (
    <div
      ref={ref}
      tabIndex={0}
      onContextMenu={onContextMenu}
      onCopy={onCopy}
      onCut={onCut}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => {
        cursor.current = null
        presence()
        if (!drag.current) setSnap(null)
      }}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPaste={(e) => {
        if (editing || isTypingIn(e.target)) return
        // Shapes copied from a board come first: their text/html is the only rich text a paste looks at.
        const list = readOnly ? null : shapesFromHtml(e.clipboardData.getData("text/html"))
        if (list?.length) {
          e.preventDefault()
          return pasteShapes(list, cursor.current ?? viewCenter())
        }
        const files = [...e.clipboardData.files]
        if (files.some((f) => f.type.startsWith("image/"))) {
          e.preventDefault()
          void addImages(files)
          return
        }
        // Only plain text counts: copying from a web page also puts rich text/html on the clipboard, which isn't meant as an embed.
        const asDesign = pasteAsDesign.current
        pasteAsDesign.current = false
        if (pasteText(e.clipboardData.getData("text/plain"), cursor.current ?? undefined, asDesign)) e.preventDefault()
      }}
      onDragOver={(e) => {
        if (uploadImage && !readOnly && e.dataTransfer.types.includes("Files")) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void addImages([...e.dataTransfer.files], worldAt(e))
      }}
      onKeyUp={(e) => e.key === " " && setSpace(false)}
      className={`relative h-full touch-none overflow-hidden bg-bg outline-none select-none ${cursorClass}`}
      style={{
        backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
        backgroundSize: `${24 * cam.zoom}px ${24 * cam.zoom}px`,
        backgroundPosition: `${-cam.x * cam.zoom}px ${-cam.y * cam.zoom}px`,
      }}
      aria-label="Board canvas"
    >
      {/* World layer */}
      <div ref={world} className="absolute top-0 left-0 origin-top-left" style={{ transform: `scale(${cam.zoom}) translate(${-cam.x}px, ${-cam.y}px)` }}>
        {shapes.map((s) =>
          s.kind === "arrow" ? null : (
            <ShapeView
              key={s.id}
              shape={s}
              selected={selection.includes(s.id)}
              snapped={snap === s.id}
              remote={remoteSelections.get(s.id)}
              editing={editing === s.id}
              showHandle={!readOnly && single?.id === s.id && interacting !== s.id}
              interactive={interacting === s.id}
              live={liveHtml.has(s.id)}
              zoom={cam.zoom}
              embed={links?.embed}
              author={s.kind === "note" ? authorOf(s.by) : undefined}
              design={
                s.kind === "design"
                  ? {
                      entered: entered === s.id,
                      edit: entered === s.id ? textEdit : null,
                      marks: [
                        ...(entered === s.id && hoverLayer && hoverLayer !== layer ? [{ node: hoverLayer, color: "var(--accent)", label: "", kind: "hover" as const }] : []),
                        ...(remoteLayers.get(s.id) ?? []),
                        // Hidden while the layer is being dragged: it would mark where the layer was.
                        ...(entered === s.id && layer && !layerHint ? [{ node: layer, color: "var(--accent)", label: "", kind: "selected" as const }] : []),
                      ],
                    }
                  : undefined
              }
              onCommitText={(text) => {
                setEditing(null)
                if (text !== (s.text ?? "")) update(s.id, { text })
              }}
            />
          ),
        )}

        {/* Arrows draw above shapes (as in FigJam and tldraw) so they stay visible inside frames. Picking is done in world space. */}
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden>
          {shapes.map((s) => {
            const line = s.kind === "arrow" ? arrowLines.get(s.id) : undefined
            if (!line) return null
            const selected = selection.includes(s.id)
            const remote = remoteSelections.get(s.id)
            const stroke = s.color ? palette[s.color].stroke : "var(--muted)"
            const halo = selected ? "var(--accent)" : remote?.color
            return (
              <g key={s.id} data-arrow-id={s.id}>
                {halo && <line x1={line.p1.x} y1={line.p1.y} x2={line.p2.x} y2={line.p2.y} stroke={halo} strokeOpacity={0.35} strokeWidth={8 / cam.zoom} strokeLinecap="round" />}
                <ArrowPath p1={line.p1} p2={line.p2} stroke={stroke} />
                {s.text && editing !== s.id && (
                  <text
                    x={(line.p1.x + line.p2.x) / 2}
                    y={(line.p1.y + line.p2.y) / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={13}
                    fill="var(--text)"
                    stroke="var(--bg)"
                    strokeWidth={4}
                    paintOrder="stroke"
                  >
                    {s.text}
                  </text>
                )}
                {selected && !readOnly && single?.id === s.id && (
                  <>
                    <ArrowEndHandle at={line.p1} attached={endEdit?.id === s.id && endEdit.end === "from" ? !!endEdit.target : !!s.from} zoom={cam.zoom} end="from" />
                    <ArrowEndHandle at={line.p2} attached={endEdit?.id === s.id && endEdit.end === "to" ? !!endEdit.target : !!s.to} zoom={cam.zoom} end="to" />
                  </>
                )}
              </g>
            )
          })}
          {draftLine && <ArrowPath p1={draftLine.p1} p2={draftLine.p2} stroke="var(--accent)" dashed />}
        </svg>

        {/* Frame headers draw above the arrows, so a connector never hides a frame's name. */}
        {shapes.map((s) =>
          s.kind === "frame" ? (
            <FrameHeader
              key={s.id}
              shape={s}
              zoom={cam.zoom}
              selected={selection.includes(s.id)}
              editor={
                editing === s.id ? (
                  <TextEditor
                    initial={s.text ?? ""}
                    single
                    className="min-w-0 text-[12px] font-semibold"
                    style={{ height: 24, lineHeight: "24px" }}
                    onCommit={(text) => {
                      setEditing(null)
                      if (text !== (s.text ?? "")) update(s.id, { text })
                    }}
                  />
                ) : undefined
              }
            />
          ) : null,
        )}

        {labelAt && editingArrow && (
          <div className="absolute w-48" style={{ left: (labelAt.p1.x + labelAt.p2.x) / 2 - 96, top: (labelAt.p1.y + labelAt.p2.y) / 2 - 14 }}>
            <TextEditor
              initial={editingArrow.text ?? ""}
              single
              className="rounded border border-accent bg-bg px-1 text-center text-[13px]"
              onCommit={(text) => {
                setEditing(null)
                if (text !== (editingArrow.text ?? "")) update(editingArrow.id, { text })
              }}
            />
          </div>
        )}
      </div>

      {marquee && (
        <div
          className="pointer-events-none absolute top-0 left-0 rounded-sm border border-accent"
          style={{
            background: "color-mix(in srgb, var(--accent) 8%, transparent)",
            ...screenRect(toScreen(cam, marquee.a), toScreen(cam, marquee.b)),
          }}
        />
      )}

      {/* What the dragged shape lines up with. One screen pixel wide at any zoom. */}
      {guides.map((g) => {
        const a = toScreen(cam, g.axis === "x" ? { x: g.at, y: g.from } : { x: g.from, y: g.at })
        const length = (g.to - g.from) * cam.zoom
        return (
          <div
            key={`${g.axis}${g.at}`}
            data-guide={g.axis}
            className="pointer-events-none absolute top-0 left-0 z-10"
            style={{ background: GUIDE_COLOR, transform: `translate(${Math.round(a.x)}px, ${Math.round(a.y)}px)`, width: g.axis === "x" ? 1 : length, height: g.axis === "x" ? length : 1 }}
          />
        )
      })}

      {/* Other people's and agents' cursors */}
      {others.map((m) => {
        const p = m.presence as BoardPresence
        if (!p.cursor) return null
        const at = toScreen(cam, p.cursor)
        return (
          <div key={m.connectionId} className="pointer-events-none absolute top-0 left-0 z-20" style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
            <svg width="18" height="18" viewBox="0 0 18 18" className="drop-shadow">
              <path d="M2 2 L16 8 L9 10 L7 16 Z" fill={m.color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span className="ml-3 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-white" style={{ background: m.color }}>
              {m.actor.type === "agent" && <RobotIcon size={11} weight="bold" />}
              {m.name}
              {p.status && <span className="opacity-80">· {p.status}</span>}
              {p.thinking && <span aria-label="thinking" className="ml-0.5 size-1.5 animate-pulse rounded-full bg-white" />}
            </span>
          </div>
        )
      })}

      {layerHint && (
        <div data-layer-hint={layerHint} className="pointer-events-none absolute bottom-[68px] left-1/2 z-30 -translate-x-1/2 rounded-md bg-text px-2.5 py-1 text-[12px] whitespace-nowrap text-bg shadow-sm">
          {layerHint === "free" ? "Placing freely · release ⌘ to reorder instead" : "Reordering in auto layout · hold ⌘ to place freely"}
        </div>
      )}
      {dropLine && (
        <div
          data-layer-drop
          className="pointer-events-none absolute z-20 rounded-full bg-accent"
          style={{ left: dropLine.x, top: dropLine.y, width: Math.max(2, dropLine.w), height: Math.max(2, dropLine.h) }}
        />
      )}

      {/* Inside a design frame: layer actions */}
      {entered && tree && (
        <div onPointerDown={(e) => e.stopPropagation()} role="toolbar" aria-label="Design" className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-md">
          {!readOnly && (
            <>
              {(
                [
                  ["frame", "Add frame", SquareIcon],
                  ["text", "Add text", TextTIcon],
                  ["image", "Add image layer", ImageSquareIcon],
                  ["button", "Add button", CursorClickIcon],
                ] as const
              ).map(([kind, label, icon]) => (
                <IconButton key={kind} label={label} icon={icon} onClick={() => runLayer(addLayer(entered, tree, layer, kind satisfies LayerKind))} />
              ))}
              <span className="mx-1 h-5 w-px bg-border" />
              <IconButton label="Duplicate layer" icon={CopyIcon} disabled={!layer || layer === tree.root} onClick={() => layer && runLayer(duplicateLayer(entered, tree, layer))} />
              <IconButton label="Wrap in frame" icon={BoundingBoxIcon} disabled={!layer || layer === tree.root} onClick={() => layer && runLayer(wrapLayer(entered, tree, layer))} />
              <IconButton label="Delete layer" icon={TrashIcon} disabled={!layer || layer === tree.root} onClick={() => layer && removeLayer(layer, tree)} />
              <span className="mx-1 h-5 w-px bg-border" />
            </>
          )}
          <IconButton
            label={layer && layer !== tree.root ? "Copy layer HTML" : "Copy HTML"}
            icon={ClipboardTextIcon}
            onClick={() => copyHtml(designToHtml(tree, { from: layer ?? tree.root }), layer && layer !== tree.root ? "the layer" : "the frame")}
          />
          <IconButton label="Layers" icon={StackIcon} pressed={panels.layers} onClick={() => setPanels((p) => ({ ...p, layers: !p.layers }))} />
          <button type="button" onClick={() => (exitDesign(), ref.current?.focus())} title="Done (Esc)" className="flex h-7 items-center gap-1 rounded bg-accent px-2 text-[12px] font-medium text-accent-text">
            <CheckIcon size={13} weight="bold" />
            Done
          </button>
        </div>
      )}

      {/* Selection actions, floating over the selection */}
      {!readOnly && selection.length > 0 && !editing && !entered && !preview.size && !marquee && !draft && !endEdit && !menu && selRect && (
        <FormatBar
          shapes={selected}
          rect={selRect}
          viewport={viewport}
          onColor={recolor}
          onTextSize={resizeText}
          onFront={bringToFront}
          onBack={sendToBack}
          onDelete={removeSelection}
          focusCanvas={() => ref.current?.focus()}
          {...(ai && selected.some((s) => s.kind !== "arrow") ? { onAsk: () => openAsk() } : {})}
        >
          {single && single.kind !== "arrow" && itemLink && <IconButton label="Copy link" icon={LinkSimpleIcon} onClick={() => copyItemLink(single.id)} />}
          {single?.kind === "artifact" && single.ref && links && (
            <>
              <span className="flex max-w-56 min-w-0 px-1">{links.chip(single.ref)}</span>
              <span className="mx-1 h-5 w-px bg-border" />
            </>
          )}
          {single?.kind === "html" && (
            <>
              <IconButton label={interacting === single.id ? "Stop interacting" : "Interact"} icon={CursorClickIcon} pressed={interacting === single.id} onClick={() => setInteracting(interacting === single.id ? null : single.id)} />
              <IconButton label="Edit HTML" icon={CodeIcon} onClick={() => setHtmlEditor(single.id)} />
              <IconButton label="Convert to design" icon={LayoutIcon} onClick={() => convertToDesign(single.id)} />
              <span className="mx-1 h-5 w-px bg-border" />
            </>
          )}
          {single?.kind === "design" && single.design && (
            <>
              <IconButton label="Edit design" icon={StackIcon} onClick={() => enterDesign(single.id, single.design!.root)} />
              <IconButton label="Copy HTML" icon={ClipboardTextIcon} onClick={() => copyHtml(designToHtml(single.design!), "the frame")} />
              <span className="mx-1 h-5 w-px bg-border" />
            </>
          )}
        </FormatBar>
      )}

      {/* Read-only people can open a design's layers and copy its HTML. */}
      {readOnly && !entered && single?.kind === "design" && single.design && (
        <div onPointerDown={(e) => e.stopPropagation()} className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-md">
          <IconButton label="View layers" icon={StackIcon} onClick={() => enterDesign(single.id, single.design!.root)} />
          <IconButton label="Copy HTML" icon={ClipboardTextIcon} onClick={() => copyHtml(designToHtml(single.design!), "the frame")} />
        </div>
      )}

      {entered && tree && enteredShape && panels.layers && (
        <LayersPanel
          title={enteredShape.text ?? "Design"}
          tree={tree}
          selected={layer}
          readOnly={readOnly}
          onSelect={(id) => {
            setLayer(id)
            setEditingLayer(null)
          }}
          onHover={setHoverLayer}
          onMove={(id, parent, index) => send({ type: "designMove", shape: enteredShape.id, id, parent, index })}
          onNudge={(by) => {
            const op = layer ? nudgeLayer(enteredShape.id, tree, layer, by) : null
            if (op) send(op)
          }}
          onRename={(title) => update(enteredShape.id, { text: title })}
          onClose={() => setPanels((p) => ({ ...p, layers: false }))}
        />
      )}
      {entered && tree && layer && tree.nodes[layer] && panels.inspector && (
        <DesignInspector
          node={tree.nodes[layer]!}
          readOnly={readOnly}
          onPatch={(patch) => patchLayer(layer, patch)}
          {...(layer !== tree.root && {
            position: {
              free: tree.nodes[layer]!.style?.position === "absolute",
              onChange: (free: boolean) => {
                const el = entered ? layerElement(entered, layer) : null
                if (!entered || !el) return
                if (free) placeFreely(entered, tree, layer, measureFree(el, cam.zoom))
                else patchLayer(layer, { style: autoStyle })
              },
            },
          })}
          {...(tree.nodes[layer]!.children.length > 0 && {
            layout: {
              free: tree.nodes[layer]!.children.every((c) => tree.nodes[c]?.style?.position === "absolute"),
              onChange: (free: boolean) => entered && setChildrenFree(entered, tree, layer, free),
            },
          })}
          onClose={() => {
            setPanels((p) => ({ ...p, inspector: false }))
            ref.current?.focus()
          }}
        />
      )}

      {/* Read-only people can still use an embed. */}
      {readOnly && single?.kind === "html" && (
        <div onPointerDown={(e) => e.stopPropagation()} className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-md">
          <IconButton label={interacting === single.id ? "Stop interacting" : "Interact"} icon={CursorClickIcon} pressed={interacting === single.id} onClick={() => setInteracting(interacting === single.id ? null : single.id)} />
        </div>
      )}

      {/* Read-only people can see what's linked, and open it. */}
      {readOnly && single?.kind === "artifact" && single.ref && links && (
        <div onPointerDown={(e) => e.stopPropagation()} className="absolute top-3 left-1/2 z-30 flex max-w-64 -translate-x-1/2 items-center rounded-lg border border-border bg-bg p-1.5 shadow-md">
          {links.chip(single.ref)}
        </div>
      )}

      {editingHtml && (
        <HtmlEditorPanel
          key={editingHtml.id}
          shape={editingHtml}
          onSave={(patch) => update(editingHtml.id, patch)}
          onClose={() => {
            setHtmlEditor(null)
            ref.current?.focus()
          }}
        />
      )}

      {/* Claude threads, pinned where they were asked */}
      {threads.map((t) => {
        const at = pinAt(t)
        if (!at) return null
        const p = toScreen(cam, at)
        return <ThreadPin key={t.key} thread={t} left={p.x} top={p.y} open={openThread === t.key} onToggle={() => setOpenThread(openThread === t.key ? null : t.key)} />
      })}
      {(() => {
        const t = openThread ? threads.find((x) => x.key === openThread) : undefined
        const at = t && pinAt(t)
        if (!t || !at || !ai) return null
        const p = toScreen(cam, at)
        const agent = others.find((m) => m.actor.type === "agent" && (m.presence as BoardPresence).status)
        return (
          <ThreadCard
            key={t.key}
            thread={t}
            left={p.x}
            top={p.y}
            viewport={viewport}
            agentStatus={threadStatus(t) === "running" ? (agent?.presence as BoardPresence | undefined)?.status : undefined}
            readOnly={readOnly}
            onReply={async (text) => {
              const last = t.mentions.at(-1)
              track(await ai.ask({ target: t.target, text, blocks: [...(last?.blocks ?? [])] }))
            }}
            onStop={(m) => void ai.cancel(m.id).then((x) => track(x)).catch(() => {})}
            onResolve={() => {
              setOpenThread(null)
              const last = t.mentions.at(-1)
              if (last && ai.resolve) void ai.resolve(last.id).then((xs) => track(...xs)).catch(() => {})
              ref.current?.focus()
            }}
            onClose={() => (setOpenThread(null), ref.current?.focus())}
          />
        )
      })()}
      {asking && (
        <AskComposer
          rect={asking.rect}
          viewport={viewport}
          context={asking.context}
          busy={askBusy}
          error={askError}
          onSubmit={(text) => void submitAsk(text)}
          onClose={() => (setAsking(null), ref.current?.focus())}
        />
      )}

      {linking && links && !readOnly && (
        <div
          data-board-panel
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onPaste={(e) => e.stopPropagation()}
          className="absolute bottom-[68px] left-1/2 z-30 -translate-x-1/2"
        >
          {links.picker({
            onPick: (target) => {
              addLink(target, placeLinkAt.current ?? undefined)
              placeLinkAt.current = null
              setLinking(false)
              ref.current?.focus()
            },
            onClose: (refocus) => {
              setLinking(false)
              if (refocus) ref.current?.focus()
            },
          })}
        </div>
      )}

      {/* Tools */}
      {hint && <div className="pointer-events-none absolute bottom-[68px] left-1/2 z-30 -translate-x-1/2 rounded-md bg-text px-2.5 py-1 text-[12px] whitespace-nowrap text-bg shadow-sm">{hint} · Esc to cancel</div>}
      <div onPointerDown={(e) => e.stopPropagation()} className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 gap-0.5 rounded-xl border border-border bg-bg p-1 shadow-md">
        {tools
          .filter((t) => !readOnly || t.id === "select" || t.id === "hand")
          .map((t) => (
            <button
              key={t.id}
              type="button"
              aria-label={t.label}
              aria-pressed={tool === t.id}
              title={`${t.label} (${t.key.toUpperCase()})`}
              onClick={() => (setTool(t.id), ref.current?.focus())}
              className={`grid size-9 place-items-center rounded-lg ${tool === t.id ? "bg-accent text-accent-text" : "text-muted hover:bg-hover hover:text-text"}`}
            >
              <t.icon size={18} />
            </button>
          ))}
        {!readOnly && (
          <>
            <span className="mx-0.5 my-1.5 w-px bg-border" />
            <button
              type="button"
              aria-label="Add HTML embed"
              title="Add HTML embed (or paste HTML)"
              onClick={() => addHtml(starterHtml, undefined, true)}
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-hover hover:text-text"
            >
              <CodeIcon size={18} />
            </button>
            <button
              type="button"
              aria-label="Add design frame"
              title="Add design frame: editable HTML layers (or paste HTML with ⌘⇧V)"
              onClick={() => addDesign(starterDesign(), designDefaults, "Design")}
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-hover hover:text-text"
            >
              <LayoutIcon size={18} />
            </button>
            {links && (
              <button
                type="button"
                aria-label="Link an artifact"
                aria-pressed={linking}
                title="Show a board, table, doc or tracker here (or paste its link)"
                // Focus stays in an open picker, which would close on losing it, and this would reopen it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  placeLinkAt.current = null
                  setLinking((open) => !open)
                }}
                className={`grid size-9 place-items-center rounded-lg ${linking ? "bg-accent text-accent-text" : "text-muted hover:bg-hover hover:text-text"}`}
              >
                <LinkSimpleIcon size={18} />
              </button>
            )}
          </>
        )}
        {ai && !readOnly && (
          <button
            type="button"
            aria-label="Ask Claude"
            title="Ask Claude about the selection, or what's in view (⌘J)"
            onClick={() => openAsk()}
            className="grid size-9 place-items-center rounded-lg text-accent hover:bg-hover"
          >
            <SparkleIcon size={18} weight="fill" />
          </button>
        )}
        {uploadImage && !readOnly && (
          <>
            <button
              type="button"
              aria-label="Add image"
              title="Add image (or paste / drop one)"
              onClick={() => {
                placeImageAt.current = null
                fileInput.current?.click()
              }}
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-hover hover:text-text"
            >
              <ImageIcon size={18} />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                void addImages([...(e.target.files ?? [])], placeImageAt.current ?? undefined)
                placeImageAt.current = null
                e.target.value = ""
              }}
            />
          </>
        )}
      </div>

      {/* Zoom + status */}
      <div onPointerDown={(e) => e.stopPropagation()} className="absolute right-3 bottom-4 z-30 flex items-center gap-0.5 rounded-lg border border-border bg-bg p-1 text-[12px] shadow-sm">
        <IconButton label="Zoom out" icon={MinusIcon} onClick={() => zoomBy(1 / 1.2)} />
        <ZoomMenu zoom={cam.zoom} hasSelection={selection.length > 0} onFit={fitAll} onFitSelection={fitSelection} onZoom={zoomTo} onZoomBy={zoomBy} focusCanvas={() => ref.current?.focus()} />
        <IconButton label="Zoom in" icon={PlusIcon} onClick={() => zoomBy(1.2)} />
      </div>
      {toast && !notice && uploading === 0 && (
        <div
          role="status"
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-14 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-muted shadow-sm"
        >
          {toast.text}
          {toast.convert && (
            <button
              type="button"
              onClick={() => {
                // Resolved now, not when the toast was made: the embed only exists in state after that render.
                if (toast.convert) convertToDesign(toast.convert)
                setToast(null)
              }}
              className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-hover"
            >
              Make it a design frame
            </button>
          )}
        </div>
      )}
      {(uploading > 0 || notice) && (
        <div className={`absolute top-14 left-1/2 z-30 -translate-x-1/2 rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] shadow-sm ${notice ? "text-danger" : "text-muted"}`}>
          {notice ?? `Uploading ${uploading} image${uploading === 1 ? "" : "s"}…`}
        </div>
      )}
      {status !== "open" && (
        <div className="absolute top-3 right-3 rounded bg-surface px-2 py-1 text-[12px] text-muted">
          {status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : "Disconnected"}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu)} label="Board" onClose={closeMenu} {...(menu.keyboard && { keyboard: true })} />}
    </div>
  )
}

const screenRect = (a: Point, b: Point) => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })

function ArrowPath({ p1, p2, stroke, dashed }: { p1: Point; p2: Point; stroke: string; dashed?: boolean }) {
  // Stop the shaft at the head's base so the line doesn't poke through the tip.
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  const head = Math.min(12, len * 0.5)
  const k = len ? (len - head * 0.8) / len : 0
  const shaftEnd = { x: p1.x + (p2.x - p1.x) * k, y: p1.y + (p2.y - p1.y) * k }
  return (
    <>
      <line x1={p1.x} y1={p1.y} x2={shaftEnd.x} y2={shaftEnd.y} stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeDasharray={dashed ? "6 4" : undefined} />
      {len > 0 && <polygon points={arrowHead(p1, p2, head)} fill={stroke} />}
    </>
  )
}

/** Drag to re-attach or detach an arrow end. Filled = attached to a shape, hollow = a free point. */
function ArrowEndHandle({ at, attached, zoom, end }: { at: Point; attached: boolean; zoom: number; end: End }) {
  return (
    <circle
      data-arrow-end={end}
      cx={at.x}
      cy={at.y}
      r={5 / zoom}
      fill={attached ? "var(--accent)" : "var(--bg)"}
      stroke="var(--accent)"
      strokeWidth={2 / zoom}
    />
  )
}

export function ShapeView({
  shape: s,
  selected,
  snapped,
  remote,
  editing,
  showHandle,
  interactive,
  live,
  zoom,
  design,
  author,
  prefill,
  embed,
  onCommitText,
}: {
  shape: Shape
  selected: boolean
  /** An arrow end being drawn would attach here. */
  snapped: boolean
  remote: Member | undefined
  editing: boolean
  showHandle: boolean
  /** Html embeds: the iframe gets pointer events. */
  interactive: boolean
  /** Html embeds: mount the iframe (otherwise a placeholder). */
  live: boolean
  zoom: number
  /** Design frames: whether it's entered, the layer outlines to draw, and an in-place text edit. */
  design?: { entered: boolean; marks: ReadonlyArray<LayerMark>; edit: TextEdit | null }
  /** Notes: who added it, shown as a chip in the corner. */
  author?: Author | undefined
  /** Text to start editing with (caret at the end) instead of the shape's own. */
  prefill?: string | undefined
  /** Links: the host's preview. Left out in previews of a shape, so a link can't draw itself forever. */
  embed?: BoardLinks["embed"] | undefined
  onCommitText: (text: string) => void
}) {
  const color = palette[s.color ?? "gray"]
  const ring = selected || interactive || design?.entered ? "var(--accent)" : remote?.color
  const base: React.CSSProperties = { left: s.x, top: s.y, width: s.w, height: s.h }
  // Too small a note has no room for the chip; the text matters more.
  const showAuthor = !!author && s.w >= 120 && s.h >= 90
  const body =
    s.kind === "note"
      ? { background: color.fill, boxShadow: "0 1px 3px rgb(0 0 0 / 0.12), 0 4px 12px rgb(0 0 0 / 0.06)", borderRadius: 4 }
      : s.kind === "rect"
        ? { background: color.fill, border: `2px solid ${color.stroke}`, borderRadius: 8 }
        : s.kind === "ellipse"
          ? { background: color.fill, border: `2px solid ${color.stroke}`, borderRadius: "50%" }
          : s.kind === "frame"
            ? {
                // A faint tint of the frame's color over the surface (works in dark mode too), translucent so the grid shows.
                background: `color-mix(in srgb, color-mix(in srgb, ${color.stroke} ${s.color && s.color !== "gray" ? 10 : 0}%, var(--surface)) 72%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color.stroke} 30%, var(--border))`,
                borderRadius: "0 10px 10px 10px",
              }
            : s.kind === "image" || s.kind === "html" || s.kind === "artifact"
              ? { background: "var(--surface)", borderRadius: 6, boxShadow: "0 1px 3px rgb(0 0 0 / 0.12), 0 6px 18px rgb(0 0 0 / 0.08)" }
              : s.kind === "design"
                ? { background: "#fff", boxShadow: "0 1px 3px rgb(0 0 0 / 0.12), 0 6px 18px rgb(0 0 0 / 0.08)" }
                : {}

  return (
    <div data-shape-id={s.id} data-snap={snapped || undefined} data-interacting={interactive || undefined} className="absolute" style={base}>
      {s.kind === "html" && (
        <div className="absolute -top-6 left-0 flex max-w-full items-center gap-1 text-[13px] font-medium whitespace-nowrap text-muted">
          <CodeIcon size={13} className="shrink-0" />
          <span className="truncate">{s.text || "HTML"}</span>
        </div>
      )}
      {interactive && (
        <span
          className="pointer-events-none absolute -top-6 right-0 rounded bg-accent px-1.5 text-[11px] leading-5 font-medium whitespace-nowrap text-accent-text"
          style={{ transform: `scale(${1 / zoom})`, transformOrigin: "bottom right" }}
        >
          Interacting · Esc to exit
        </span>
      )}
      {s.kind === "design" && (
        <div className={`absolute -top-6 left-0 flex max-w-full items-center gap-1 text-[13px] font-medium whitespace-nowrap ${design?.entered ? "text-accent" : "text-muted"}`}>
          <LayoutIcon size={13} className="shrink-0" />
          <span className="truncate">{s.text || "Design"}</span>
        </div>
      )}
      {s.kind === "image" && (s.text || editing) && (
        <div className="absolute top-full left-0 mt-1.5 w-full text-[13px] text-muted">
          {editing ? (
            <TextEditor initial={s.text ?? ""} onCommit={onCommitText} className="rounded border border-accent bg-bg px-1 text-[13px]" single />
          ) : (
            <span className="line-clamp-2">{s.text}</span>
          )}
        </div>
      )}
      <div
        className={`flex h-full w-full overflow-hidden ${s.kind === "image" || s.kind === "html" || s.kind === "design" || s.kind === "artifact" ? "" : s.kind === "note" ? `items-start p-3 ${showAuthor ? "pb-8" : ""}` : s.kind === "text" ? "items-center" : "items-center justify-center p-2 text-center"}`}
        style={{
          ...body,
          outline: snapped ? `${2 / zoom}px solid var(--accent)` : ring ? `${(interactive ? 3 : design?.entered ? 1 : 2) / zoom}px solid ${ring}` : undefined,
          outlineOffset: (snapped ? 4 : 2) / zoom,
          ...(snapped && { boxShadow: `0 0 0 ${8 / zoom}px color-mix(in srgb, var(--accent) 18%, transparent)` }),
        }}
      >
        {s.kind === "artifact" ? (
          // Inert: the canvas handles presses, so a card can be selected and dragged. Double-click or Enter opens it.
          <div inert className="pointer-events-none h-full w-full">
            {embed && s.ref ? (
              embed(s.ref)
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted">
                <LinkSimpleIcon size={16} className="shrink-0" /> Linked artifact
              </div>
            )}
          </div>
        ) : s.kind === "design" ? (
          s.design ? <DesignContent tree={s.design} edit={design?.edit ?? null} /> : null
        ) : s.kind === "html" ? (
          live ? <HtmlFrame html={s.html ?? ""} title={s.text || "HTML embed"} interactive={interactive} /> : <HtmlPlaceholder title={s.text || "HTML"} zoom={zoom} />
        ) : s.kind === "image" ? (
          s.src ? <img src={s.src} alt={s.text ?? "Image"} draggable={false} className="pointer-events-none h-full w-full object-contain" /> : null
        ) : editing && s.kind !== "frame" ? (
          <TextEditor
            initial={prefill ?? s.text ?? ""}
            caretEnd={prefill !== undefined}
            onCommit={onCommitText}
            className={s.kind === "text" ? "font-medium" : ""}
            style={{ fontSize: fontPx(s) }}
          />
        ) : (
          s.kind !== "frame" && (
            <div
              className={`w-full break-words whitespace-pre-wrap ${s.kind === "text" ? "font-medium text-text" : "leading-snug"} ${!s.text ? "opacity-40" : ""}`}
              style={{ fontSize: fontPx(s), ...(s.kind === "note" || s.kind === "rect" || s.kind === "ellipse" ? { color: "#1f1f1d" } : {}) }}
            >
              {s.text || (s.kind === "text" ? "Text" : "")}
            </div>
          )
        )}
      </div>
      {showAuthor && author && !editing && <AuthorChip author={author} />}
      {s.kind === "design" && s.design && design && design.marks.length > 0 && <DesignOutlines shapeId={s.id} tree={s.design} marks={design.marks} zoom={zoom} />}
      {remote && !selected && (
        <span className="pointer-events-none absolute -top-5 right-0 rounded px-1 text-[10px] leading-4 font-medium whitespace-nowrap text-white" style={{ background: remote.color, transform: `scale(${1 / zoom})`, transformOrigin: "bottom right" }}>
          {remote.name}
        </span>
      )}
      {showHandle && (
        <div
          data-handle={s.id}
          className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm border-2 border-accent bg-bg"
          style={{ transform: `scale(${1 / zoom})` }}
        />
      )}
    </div>
  )
}

function fit(items: ReadonlyArray<Shape>, rect: DOMRect): Camera {
  // Boxes, plus the free ends of arrows (attached ends lie on their shapes already).
  const boxes = items.flatMap((s) => {
    if (s.kind !== "arrow") return [s]
    return [...(s.from ? [] : [{ x: s.x, y: s.y, w: 0, h: 0 }]), ...(s.to || s.x2 === undefined || s.y2 === undefined ? [] : [{ x: s.x2, y: s.y2, w: 0, h: 0 }])]
  })
  return fitBoxes(boxes, rect, 1.25)
}

type Box = { x: number; y: number; w: number; h: number }

/** A camera showing every box with some margin, zoomed in at most to `max`. */
function fitBoxes(boxes: ReadonlyArray<Box>, rect: { width: number; height: number }, max: number): Camera {
  if (!boxes.length) return { x: -rect.width / 2, y: -rect.height / 2, zoom: 1 }
  const minX = Math.min(...boxes.map((s) => s.x)) - 80
  const minY = Math.min(...boxes.map((s) => s.y)) - 80
  const maxX = Math.max(...boxes.map((s) => s.x + s.w)) + 80
  const maxY = Math.max(...boxes.map((s) => s.y + s.h)) + 120
  const zoom = Math.min(max, Math.max(0.1, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY))))
  return { zoom, x: (minX + maxX) / 2 - rect.width / 2 / zoom, y: (minY + maxY) / 2 - rect.height / 2 / zoom }
}
