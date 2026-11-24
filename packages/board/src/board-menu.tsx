import {
  AlignBottomIcon,
  AlignCenterHorizontalIcon,
  AlignCenterVerticalIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  ArrowDownIcon,
  ArrowLineDownIcon,
  ArrowLineUpIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  ArrowsLeftRightIcon,
  BoundingBoxIcon,
  CheckIcon,
  CircleIcon,
  ClipboardIcon,
  ClipboardTextIcon,
  CodeIcon,
  ColumnsIcon,
  CopyIcon,
  CopySimpleIcon,
  CornersOutIcon,
  CursorClickIcon,
  DownloadSimpleIcon,
  FlowArrowIcon,
  FrameCornersIcon,
  ImageIcon,
  ImageSquareIcon,
  LayoutIcon,
  LinkSimpleIcon,
  MagnifyingGlassPlusIcon,
  NoteIcon,
  PaletteIcon,
  PencilSimpleIcon,
  PlusIcon,
  RectangleIcon,
  RowsIcon,
  ScissorsIcon,
  SelectionAllIcon,
  SelectionIcon,
  ShapesIcon,
  SparkleIcon,
  SquareIcon,
  StackIcon,
  SwapIcon,
  TextAaIcon,
  TextTIcon,
  TrashIcon,
  type Icon,
} from "@phosphor-icons/react"
import { isVoidTag, type DesignNode, type DesignTree, type Shape, type ShapeColor, type ShapeKind, type TextSize } from "@standard-artifacts/protocol"
import type { AlignEdge, Axis } from "./arrange"
import { coloredKinds, sizedKinds, textSizes } from "./canvas-ui"
import { isMac, tidy, type MenuEntry } from "./context-menu"
import type { LayerKind } from "./design-edit"
import { palette } from "./geometry"

/*
 * What's in the board's right-click menu. Three menus: the canvas (make things),
 * shapes (act on the selection), and a layer inside an entered design frame.
 * Rows that don't apply are left out rather than greyed; greyed means it applies
 * to this kind of thing but not right now.
 */

const icon = (I: Icon) => <I size={15} />
const mod = isMac ? "⌘" : "Ctrl+"
const shift = isMac ? "⇧" : "Shift+"
const alt = isMac ? "⌥" : "Alt+"

/** Shapes whose kind can be swapped: they all just draw text in a box. */
const textKinds: ReadonlyArray<{ kind: ShapeKind; label: string; icon: Icon }> = [
  { kind: "note", label: "Sticky note", icon: NoteIcon },
  { kind: "rect", label: "Rectangle", icon: RectangleIcon },
  { kind: "ellipse", label: "Ellipse", icon: CircleIcon },
  { kind: "text", label: "Text", icon: TextTIcon },
]
const kindIcons: Record<ShapeKind, Icon> = {
  note: NoteIcon,
  rect: RectangleIcon,
  ellipse: CircleIcon,
  text: TextTIcon,
  frame: FrameCornersIcon,
  arrow: ArrowUpRightIcon,
  image: ImageIcon,
  html: CodeIcon,
  design: LayoutIcon,
  artifact: LinkSimpleIcon,
}
const kindNames: Record<ShapeKind, string> = {
  note: "Note",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  frame: "Frame",
  arrow: "Arrow",
  image: "Image",
  html: "Embed",
  design: "Design",
  artifact: "Link",
}
const shapeName = (s: Shape) => {
  const words = s.text?.trim().slice(0, 28)
  return words ? `${kindNames[s.kind]} · ${words}` : kindNames[s.kind]
}
const layerName = (n: DesignNode) => n.text?.trim().slice(0, 28) || `<${n.tag}>`

export type BoardMenuActions = {
  readonly readOnly: boolean
  /** Makes a new shape where the menu was opened. */
  readonly create: (kind: Exclude<ShapeKind, "arrow" | "image" | "html" | "design" | "artifact">) => void
  readonly drawArrow: () => void
  readonly addHtml: () => void
  readonly addDesign: () => void
  readonly addImage?: (() => void) | undefined
  readonly addLink?: (() => void) | undefined
  readonly ask?: (() => void) | undefined
  readonly paste: (asDesign?: boolean) => void
  readonly select: (ids: ReadonlyArray<string>) => void
  readonly selectAll: () => void
  readonly zoomToFit: () => void
  readonly zoomTo100: () => void
  readonly zoomToSelection: () => void
  readonly hasShapes: boolean
}

export function canvasMenu(a: BoardMenuActions): ReadonlyArray<MenuEntry> {
  return tidy([
    ...(a.readOnly
      ? []
      : ([
          { label: "Paste here", icon: icon(ClipboardIcon), hint: `${mod}V`, run: () => a.paste() },
          { label: "Paste as design", icon: icon(LayoutIcon), hint: `${shift}${mod}V`, run: () => a.paste(true) },
          "-",
          addSubmenu(a),
          ...(a.ask ? [{ label: "Ask Claude here", icon: <SparkleIcon size={15} weight="fill" />, hint: `${mod}J`, run: a.ask }] : []),
          "-",
        ] satisfies ReadonlyArray<MenuEntry>)),
    { label: "Select all", icon: icon(SelectionAllIcon), hint: `${mod}A`, disabled: !a.hasShapes, run: a.selectAll },
    "-",
    { label: "Zoom to fit", icon: icon(CornersOutIcon), hint: `${shift}1`, run: a.zoomToFit },
    { label: "Zoom to 100%", icon: icon(MagnifyingGlassPlusIcon), hint: `${mod}0`, run: a.zoomTo100 },
  ])
}

const addSubmenu = (a: BoardMenuActions): MenuEntry => ({
  label: "Add",
  icon: icon(PlusIcon),
  items: tidy([
    { label: "Sticky note", icon: icon(NoteIcon), hint: "N", run: () => a.create("note") },
    { label: "Rectangle", icon: icon(RectangleIcon), hint: "R", run: () => a.create("rect") },
    { label: "Ellipse", icon: icon(CircleIcon), hint: "O", run: () => a.create("ellipse") },
    { label: "Text", icon: icon(TextTIcon), hint: "T", run: () => a.create("text") },
    { label: "Frame", icon: icon(FrameCornersIcon), hint: "F", run: () => a.create("frame") },
    { label: "Arrow connector", icon: icon(ArrowUpRightIcon), hint: "A", run: a.drawArrow },
    "-",
    ...(a.addImage ? [{ label: "Image…", icon: icon(ImageIcon), run: a.addImage }] : []),
    { label: "HTML embed", icon: icon(CodeIcon), run: a.addHtml },
    { label: "Design frame", icon: icon(LayoutIcon), run: a.addDesign },
    ...(a.addLink ? [{ label: "Link to artifact…", icon: icon(LinkSimpleIcon), run: a.addLink }] : []),
  ]),
})

export type ShapeMenuActions = BoardMenuActions & {
  /** The selection, in selection order. */
  readonly selected: ReadonlyArray<Shape>
  /** Everything under the pointer, top first, for reaching what's buried. */
  readonly under: ReadonlyArray<Shape>
  readonly edit: (id: string) => void
  readonly interacting: string | null
  readonly setInteracting: (id: string | null) => void
  readonly editHtml: (id: string) => void
  readonly convertToDesign: (id: string) => void
  readonly enterDesign: (s: Shape) => void
  readonly openLink: (id: string, newTab: boolean) => void
  readonly reverseArrow: (s: Shape) => void
  readonly cut: () => void
  readonly copy: () => void
  readonly duplicate: () => void
  readonly copyText: () => void
  readonly copyHtml: (s: Shape) => void
  readonly copyLink?: ((id: string) => void) | undefined
  readonly recolor: (c: ShapeColor) => void
  readonly resizeText: (s: TextSize) => void
  readonly turnInto: (kind: ShapeKind) => void
  readonly align: (edge: AlignEdge) => void
  readonly distribute: (axis: Axis) => void
  readonly front: () => void
  readonly forward: () => void
  readonly backward: () => void
  readonly back: () => void
  readonly canForward: boolean
  readonly canBackward: boolean
  readonly frameSelection: () => void
  readonly connect: (from: string, to: string) => void
  /** What a frame carries when it moves. */
  readonly contents: (id: string) => ReadonlyArray<Shape>
  readonly fitFrame: (id: string) => void
  readonly remove: () => void
  readonly removeWithContents: (id: string) => void
}

/** What this kind of shape is for: its own actions, at the top. */
function kindActions(a: ShapeMenuActions, s: Shape): ReadonlyArray<MenuEntry> {
  const edit = (label: string) => (a.readOnly ? [] : [{ label, icon: icon(PencilSimpleIcon), hint: "↩", run: () => a.edit(s.id) }])
  switch (s.kind) {
    case "note":
    case "rect":
    case "ellipse":
    case "text":
      return edit("Edit text")
    case "frame":
      return [
        ...edit("Rename"),
        { label: "Select contents", icon: icon(SelectionIcon), disabled: !a.contents(s.id).length, run: () => a.select(a.contents(s.id).map((c) => c.id)) },
        ...(a.readOnly ? [] : [{ label: "Fit to contents", icon: icon(BoundingBoxIcon), disabled: !a.contents(s.id).some((c) => c.kind !== "arrow"), run: () => a.fitFrame(s.id) }]),
      ]
    case "arrow":
      return [...edit("Edit label"), ...(a.readOnly ? [] : [{ label: "Reverse direction", icon: icon(ArrowsLeftRightIcon), run: () => a.reverseArrow(s) }])]
    case "image":
      return [
        ...edit("Edit caption"),
        ...(s.src
          ? [
              { label: "Open image", icon: icon(ArrowSquareOutIcon), run: () => window.open(s.src, "_blank", "noopener") },
              {
                label: "Download image",
                icon: icon(DownloadSimpleIcon),
                run: () => {
                  const link = document.createElement("a")
                  link.href = s.src!
                  link.download = s.text ?? "image"
                  link.click()
                },
              },
            ]
          : []),
      ]
    case "html":
      return [
        { label: a.interacting === s.id ? "Stop interacting" : "Interact", icon: icon(CursorClickIcon), run: () => a.setInteracting(a.interacting === s.id ? null : s.id) },
        ...(a.readOnly
          ? []
          : [
              { label: "Edit HTML", icon: icon(CodeIcon), hint: "↩", run: () => a.editHtml(s.id) },
              { label: "Convert to design frame", icon: icon(LayoutIcon), run: () => a.convertToDesign(s.id) },
            ]),
      ]
    case "design":
      return [{ label: a.readOnly ? "View layers" : "Edit design", icon: icon(StackIcon), hint: "↩", run: () => a.enterDesign(s) }]
    case "artifact":
      return [
        { label: "Open", icon: icon(ArrowSquareOutIcon), hint: "↩", run: () => a.openLink(s.id, false) },
        { label: "Open in new tab", icon: icon(ArrowSquareOutIcon), run: () => a.openLink(s.id, true) },
      ]
  }
}

export function shapeMenu(a: ShapeMenuActions): ReadonlyArray<MenuEntry> {
  const { selected } = a
  const single = selected.length === 1 ? selected[0]! : undefined
  const boxes = selected.filter((s) => s.kind !== "arrow")
  const colored = selected.filter((s) => coloredKinds.has(s.kind))
  const sized = selected.filter((s) => sizedKinds.has(s.kind))
  const swappable = selected.length > 0 && selected.every((s) => textKinds.some((k) => k.kind === s.kind))
  const hasText = selected.some((s) => s.text?.trim())
  const htmlSource = single?.kind === "html" || single?.kind === "design" ? single : undefined
  const pair = selected.length === 2 && boxes.length === 2 && boxes.every((s) => s.kind !== "frame") ? boxes : null
  const frameContents = single?.kind === "frame" ? a.contents(single.id) : []

  const copyAs: ReadonlyArray<MenuEntry> = [
    ...(hasText ? [{ label: "Text", icon: icon(TextAaIcon), run: a.copyText }] : []),
    ...(htmlSource ? [{ label: "HTML", icon: icon(CodeIcon), run: () => a.copyHtml(htmlSource) }] : []),
    ...(single && single.kind !== "arrow" && a.copyLink ? [{ label: "Link to this item", icon: icon(LinkSimpleIcon), run: () => a.copyLink!(single.id) }] : []),
  ]

  return tidy([
    ...(single ? kindActions(a, single) : []),
    ...(a.ask && boxes.length ? [{ label: "Ask Claude", icon: <SparkleIcon size={15} weight="fill" />, hint: `${mod}J`, run: a.ask }] : []),
    "-",
    ...(a.readOnly ? [] : [{ label: "Cut", icon: icon(ScissorsIcon), hint: `${mod}X`, run: a.cut }]),
    { label: "Copy", icon: icon(CopyIcon), hint: `${mod}C`, run: a.copy },
    ...(a.readOnly
      ? []
      : [
          { label: "Paste here", icon: icon(ClipboardIcon), hint: `${mod}V`, run: () => a.paste() },
          { label: "Duplicate", icon: icon(CopySimpleIcon), hint: `${mod}D`, run: a.duplicate },
        ]),
    ...(copyAs.length ? [{ label: "Copy as", icon: icon(ClipboardTextIcon), items: copyAs }] : []),
    ...(single?.kind === "frame" && !a.readOnly ? ["-" as const, addSubmenu(a)] : []),
    "-",
    ...(a.readOnly
      ? []
      : ([
          ...(colored.length
            ? [
                {
                  label: "Color",
                  icon: icon(PaletteIcon),
                  items: (Object.keys(palette) as Array<ShapeColor>).map((c) => ({
                    label: c[0]!.toUpperCase() + c.slice(1),
                    icon: <span className="size-3.5 rounded-full border-[1.5px]" style={{ background: palette[c].fill, borderColor: palette[c].stroke }} />,
                    checked: colored.every((s) => (s.color ?? "gray") === c),
                    run: () => a.recolor(c),
                  })),
                },
              ]
            : []),
          ...(sized.length
            ? [
                {
                  label: "Text size",
                  icon: icon(TextAaIcon),
                  items: textSizes.map((t) => ({ label: t.label, checked: sized.every((s) => (s.textSize ?? "m") === t.id), run: () => a.resizeText(t.id) })),
                },
              ]
            : []),
          ...(swappable
            ? [
                {
                  label: "Turn into",
                  icon: icon(SwapIcon),
                  items: textKinds.map((k) => ({ label: k.label, icon: icon(k.icon), checked: selected.every((s) => s.kind === k.kind), run: () => a.turnInto(k.kind) })),
                },
              ]
            : []),
          "-",
          ...(boxes.length >= 2
            ? [
                {
                  label: "Align",
                  icon: icon(AlignLeftIcon),
                  items: [
                    { label: "Left", icon: icon(AlignLeftIcon), run: () => a.align("left") },
                    { label: "Horizontal centers", icon: icon(AlignCenterHorizontalIcon), run: () => a.align("center") },
                    { label: "Right", icon: icon(AlignRightIcon), run: () => a.align("right") },
                    "-" as const,
                    { label: "Top", icon: icon(AlignTopIcon), run: () => a.align("top") },
                    { label: "Vertical centers", icon: icon(AlignCenterVerticalIcon), run: () => a.align("middle") },
                    { label: "Bottom", icon: icon(AlignBottomIcon), run: () => a.align("bottom") },
                  ],
                },
              ]
            : []),
          ...(boxes.length >= 3
            ? [
                {
                  label: "Distribute",
                  icon: icon(ColumnsIcon),
                  items: [
                    { label: "Horizontally", icon: icon(ColumnsIcon), run: () => a.distribute("horizontal") },
                    { label: "Vertically", icon: icon(RowsIcon), run: () => a.distribute("vertical") },
                  ],
                },
              ]
            : []),
          ...(boxes.length
            ? [
                {
                  label: "Order",
                  icon: icon(StackIcon),
                  items: [
                    { label: "Bring to front", icon: icon(ArrowLineUpIcon), hint: `${shift}${mod}]`, run: a.front },
                    { label: "Bring forward", icon: icon(ArrowUpIcon), hint: `${mod}]`, disabled: !a.canForward, run: a.forward },
                    { label: "Send backward", icon: icon(ArrowDownIcon), hint: `${mod}[`, disabled: !a.canBackward, run: a.backward },
                    { label: "Send to back", icon: icon(ArrowLineDownIcon), hint: `${shift}${mod}[`, run: a.back },
                  ],
                },
                { label: "Frame selection", icon: icon(FrameCornersIcon), hint: `${alt}${mod}G`, run: a.frameSelection },
              ]
            : []),
          ...(pair ? [{ label: "Connect with arrow", icon: icon(FlowArrowIcon), run: () => a.connect(pair[0]!.id, pair[1]!.id) }] : []),
        ] satisfies ReadonlyArray<MenuEntry>)),
    "-",
    ...(a.under.length > 1
      ? [
          {
            label: "Select",
            icon: icon(ShapesIcon),
            items: a.under.map((s) => ({ label: shapeName(s), icon: icon(kindIcons[s.kind]), checked: selected.some((x) => x.id === s.id), run: () => a.select([s.id]) })),
          },
        ]
      : []),
    { label: "Select all", icon: icon(SelectionAllIcon), hint: `${mod}A`, run: a.selectAll },
    { label: "Zoom to selection", icon: icon(CornersOutIcon), hint: `${shift}2`, run: a.zoomToSelection },
    ...(a.readOnly
      ? []
      : ([
          "-",
          // A frame's contents stay when it goes, which is worth saying when there are any.
          { label: frameContents.length ? "Delete frame, keep contents" : "Delete", icon: icon(TrashIcon), hint: isMac ? "⌫" : "Del", danger: true, run: a.remove },
          ...(frameContents.length && single ? [{ label: "Delete frame and contents", icon: icon(TrashIcon), danger: true, run: () => a.removeWithContents(single.id) }] : []),
        ] satisfies ReadonlyArray<MenuEntry>)),
  ])
}

export type LayerMenuActions = {
  readonly readOnly: boolean
  readonly tree: DesignTree
  readonly layer: string
  /** From the layer under the pointer up to the frame's root. */
  readonly chain: ReadonlyArray<string>
  readonly frameTitle: string
  readonly editText: () => void
  readonly addLayer: (kind: LayerKind) => void
  readonly duplicate: () => void
  readonly wrap: () => void
  readonly nudge: (by: -1 | 1) => void
  readonly canNudge: (by: -1 | 1) => boolean
  readonly selectLayer: (id: string) => void
  readonly copyHtml: () => void
  readonly remove: () => void
  readonly done: () => void
}

export function layerMenu(a: LayerMenuActions): ReadonlyArray<MenuEntry> {
  const node = a.tree.nodes[a.layer]
  const isRoot = a.layer === a.tree.root
  const editable = !!node && !a.readOnly && !isVoidTag(node.tag) && !node.children.length
  return tidy([
    ...(editable ? [{ label: "Edit text", icon: icon(PencilSimpleIcon), hint: "↩", run: a.editText }] : []),
    ...(a.readOnly
      ? []
      : ([
          {
            label: "Add layer",
            icon: icon(PlusIcon),
            items: [
              { label: "Frame", icon: icon(SquareIcon), run: () => a.addLayer("frame") },
              { label: "Text", icon: icon(TextTIcon), run: () => a.addLayer("text") },
              { label: "Image", icon: icon(ImageSquareIcon), run: () => a.addLayer("image") },
              { label: "Button", icon: icon(CursorClickIcon), run: () => a.addLayer("button") },
            ],
          },
          "-",
          { label: "Duplicate layer", icon: icon(CopyIcon), hint: `${mod}D`, disabled: isRoot, run: a.duplicate },
          { label: "Wrap in frame", icon: icon(BoundingBoxIcon), disabled: isRoot, run: a.wrap },
          { label: "Move up", icon: icon(ArrowUpIcon), hint: "↑", disabled: !a.canNudge(-1), run: () => a.nudge(-1) },
          { label: "Move down", icon: icon(ArrowDownIcon), hint: "↓", disabled: !a.canNudge(1), run: () => a.nudge(1) },
        ] satisfies ReadonlyArray<MenuEntry>)),
    "-",
    ...(a.chain.length > 1
      ? [
          {
            label: "Select",
            icon: icon(ShapesIcon),
            items: a.chain.flatMap((id) => {
              const n = a.tree.nodes[id]
              return n ? [{ label: id === a.tree.root ? a.frameTitle : layerName(n), checked: id === a.layer, run: () => a.selectLayer(id) }] : []
            }),
          },
        ]
      : []),
    { label: isRoot ? "Copy HTML" : "Copy layer HTML", icon: icon(ClipboardTextIcon), hint: `${mod}C`, run: a.copyHtml },
    ...(a.readOnly ? [] : (["-", { label: "Delete layer", icon: icon(TrashIcon), hint: isMac ? "⌫" : "Del", danger: true, disabled: isRoot, run: a.remove }] satisfies ReadonlyArray<MenuEntry>)),
    "-",
    { label: "Done", icon: icon(CheckIcon), hint: "Esc", run: a.done },
  ])
}
