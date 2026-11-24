/**
 * Dragging a layer inside an entered design frame, the way Figma treats auto
 * layout: a layer in a flow (flex, grid, block) is reordered among its siblings,
 * with a line showing where it lands; an absolutely positioned layer moves.
 *
 * Layout belongs to the browser, so everything here reads the rendered DOM.
 * During the drag the layer follows the pointer with an inline `translate`
 * (React never sees it); `end` puts the layer's own inline styles back.
 */

export type Rect = { x: number; y: number; w: number; h: number }

export type LayerDrag = {
  readonly el: HTMLElement
  /** Absolutely positioned layers move; the rest reorder (or, with ⌘ held, leave the flow and move). */
  readonly absolute: boolean
  /** Where the layer sat when the drag started, measured before anything moved it. */
  readonly free: FreePlace
  /** The layer's `left`/`top` in CSS px when the drag started (absolute layers). */
  readonly origin: { left: number; top: number }
  /** Inline styles to restore. */
  readonly saved: { translate: string; opacity: string; zIndex: string; position: string; pointerEvents: string }
}

/** The rendered element of layer `node` in design frame `shape`. */
export const layerElement = (shape: string, node: string) =>
  document.querySelector<HTMLElement>(`[data-shape-id="${CSS.escape(shape)}"] [data-node-id="${CSS.escape(node)}"]`)

export function isAbsolute(el: HTMLElement) {
  const p = getComputedStyle(el).position
  return p === "absolute" || p === "fixed"
}

export function beginLayerDrag(el: HTMLElement, zoom: number): LayerDrag {
  const cs = getComputedStyle(el)
  const s = el.style
  return {
    el,
    absolute: isAbsolute(el),
    origin: { left: parseFloat(cs.left) || 0, top: parseFloat(cs.top) || 0 },
    free: measureFree(el, zoom),
    saved: { translate: s.translate, opacity: s.opacity, zIndex: s.zIndex, position: s.position, pointerEvents: s.pointerEvents },
  }
}

/** Follow the pointer: `dx`/`dy` in the layer's own CSS px (screen px divided by zoom). `free`: it'll be placed, not reordered. */
export function moveLayerDrag(d: LayerDrag, dx: number, dy: number, free = false) {
  const s = d.el.style
  s.translate = `${dx}px ${dy}px`
  // Let hit-testing see what's under the dragged layer.
  s.pointerEvents = "none"
  if (!d.absolute) {
    s.opacity = free ? "1" : "0.6"
    if (getComputedStyle(d.el).position === "static") s.position = "relative"
    s.zIndex = "1"
  }
}

export function endLayerDrag(d: LayerDrag) {
  Object.assign(d.el.style, d.saved)
}

type Axis = "x" | "y" | "both"

function axisOf(parent: HTMLElement): Axis {
  const cs = getComputedStyle(parent)
  if (cs.display.includes("grid")) return "both"
  if (cs.display.includes("flex")) {
    if (cs.flexWrap !== "nowrap" && cs.flexWrap !== "") return "both"
    return cs.flexDirection.startsWith("row") ? "x" : "y"
  }
  // Block flow: inline children wrap like a row; anything else stacks.
  return "y"
}

/**
 * Where a dragged flow layer would land: its new index among its siblings
 * (counted without it, as `designMove` expects) and the insertion line in
 * client coordinates. Null when it has no siblings to move between.
 */
export function flowDrop(el: HTMLElement, x: number, y: number): { index: number; line: Rect } | null {
  const parent = el.parentElement
  if (!parent) return null
  const siblings = [...parent.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c !== el && !!c.dataset.nodeId)
  if (!siblings.length) return null
  const axis = axisOf(parent)
  const before = (c: HTMLElement) => {
    const r = c.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (axis === "x") return cx < x
    if (axis === "y") return cy < y
    return r.bottom < y || (r.top <= y && y <= r.bottom && cx < x)
  }
  let index = 0
  while (index < siblings.length && before(siblings[index]!)) index++
  const at = siblings[Math.min(index, siblings.length - 1)]!.getBoundingClientRect()
  const after = index >= siblings.length
  const vertical = axis !== "y"
  const t = 2
  const line: Rect = vertical
    ? { x: (after ? at.right : at.left) - t / 2, y: at.top, w: t, h: at.height }
    : { x: at.left, y: (after ? at.bottom : at.top) - t / 2, w: at.width, h: t }
  return { index, line }
}

/**
 * Free positioning, as in a Figma frame without auto layout: a layer taken out
 * of the flow keeps its exact place and size, as `position: absolute` with
 * left/top/width/height in its parent's coordinates.
 */
export type FreePlace = { left: number; top: number; width: number; height: number; parentStatic: boolean; text: boolean }

export function measureFree(el: HTMLElement, zoom: number): FreePlace {
  const parent = el.parentElement
  const r = el.getBoundingClientRect()
  const p = parent?.getBoundingClientRect() ?? r
  // Offsets are from the parent's padding box (inside its border); screen px back to CSS px.
  return {
    left: (r.left - p.left) / zoom - (parent?.clientLeft ?? 0),
    top: (r.top - p.top) / zoom - (parent?.clientTop ?? 0),
    width: r.width / zoom,
    height: r.height / zoom,
    parentStatic: !!parent && getComputedStyle(parent).position === "static",
    text: el.children.length === 0 && !!el.textContent?.trim(),
  }
}

const px = (v: number) => `${Math.round(v)}px`

/** The layer's style once placed freely at `place` moved by (dx, dy). Margins would offset it, so they go. */
export function freeStyle(place: FreePlace, dx = 0, dy = 0): Record<string, string | null> {
  return {
    position: "absolute",
    left: px(place.left + dx),
    top: px(place.top + dy),
    // Rounded up: a box a fraction too narrow wraps its last word.
    width: `${Math.ceil(place.width)}px`,
    // Text keeps its width (so it wraps the same) but not its height, so edits to it don't overflow.
    height: place.text ? null : `${Math.ceil(place.height)}px`,
    right: null,
    bottom: null,
    inset: null,
    margin: "0",
    "margin-top": null,
    "margin-right": null,
    "margin-bottom": null,
    "margin-left": null,
  }
}

/** Back into the flow: drop the placement (sizes stay, as set). */
export const autoStyle: Record<string, string | null> = { position: null, left: null, top: null, right: null, bottom: null, inset: null }

/** Whether every child layer of `el` is placed freely: the container's layout is "Free". */
export function childrenFree(el: HTMLElement): boolean {
  const kids = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.nodeId)
  return kids.length > 0 && kids.every(isAbsolute)
}
