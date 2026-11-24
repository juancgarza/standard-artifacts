import type { AlignEdge, Shape } from "@standard-artifacts/protocol"

export type { AlignEdge }

export type Box = { readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export type Delta = { readonly dx: number; readonly dy: number }
export type Axis = "horizontal" | "vertical"
export type Move = { readonly id: string; readonly after: string | null }

export function boundsOf(boxes: ReadonlyArray<Omit<Box, "id">>) {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}

/** How far each box moves to line up with the edge or centre of the boxes' combined bounds. */
export function alignDeltas(boxes: ReadonlyArray<Box>, edge: AlignEdge): ReadonlyMap<string, Delta> {
  const b = boundsOf(boxes)
  const delta = (s: Box): Delta => {
    switch (edge) {
      case "left":
        return { dx: b.x - s.x, dy: 0 }
      case "center":
        return { dx: b.x + b.w / 2 - (s.x + s.w / 2), dy: 0 }
      case "right":
        return { dx: b.x + b.w - (s.x + s.w), dy: 0 }
      case "top":
        return { dx: 0, dy: b.y - s.y }
      case "middle":
        return { dx: 0, dy: b.y + b.h / 2 - (s.y + s.h / 2) }
      case "bottom":
        return { dx: 0, dy: b.y + b.h - (s.y + s.h) }
    }
  }
  return new Map(boxes.map((s) => [s.id, delta(s)]))
}

/** Equal gaps along an axis; the two outermost boxes stay where they are. */
export function distributeDeltas(boxes: ReadonlyArray<Box>, axis: Axis): ReadonlyMap<string, Delta> {
  const start = (s: Box) => (axis === "horizontal" ? s.x : s.y)
  const size = (s: Box) => (axis === "horizontal" ? s.w : s.h)
  const sorted = [...boxes].sort((a, b) => start(a) + size(a) / 2 - (start(b) + size(b) / 2))
  const first = sorted[0]
  const last = sorted.at(-1)
  if (!first || !last || sorted.length < 3) return new Map()
  const lo = Math.min(...sorted.map(start))
  const hi = Math.max(...sorted.map((s) => start(s) + size(s)))
  const gap = (hi - lo - sorted.reduce((sum, s) => sum + size(s), 0)) / (sorted.length - 1)
  const out = new Map<string, Delta>()
  let at = start(first)
  for (const s of sorted) {
    const by = s === first || s === last ? 0 : Math.round(at - start(s))
    out.set(s.id, axis === "horizontal" ? { dx: by, dy: 0 } : { dx: 0, dy: by })
    at += size(s) + gap
  }
  return out
}

const overlaps = (a: Shape, b: Shape) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/**
 * One step up: past the nearest shape above that it overlaps, since passing a
 * shape it doesn't touch would change nothing you can see. Arrows always draw
 * above shapes, so they don't count. A picked shape above stops the step, so
 * picked shapes keep their order.
 */
export function stepForward(items: ReadonlyArray<Shape>, picked: ReadonlySet<string>): ReadonlyArray<Move> {
  const order = [...items]
  const moves: Array<Move> = []
  for (let i = order.length - 1; i >= 0; i--) {
    const s = order[i]!
    if (!picked.has(s.id) || s.kind === "arrow") continue
    let j = i + 1
    while (j < order.length && !picked.has(order[j]!.id) && (order[j]!.kind === "arrow" || !overlaps(s, order[j]!))) j++
    if (j >= order.length || picked.has(order[j]!.id)) continue
    const target = order[j]!
    order.splice(i, 1)
    order.splice(j, 0, s)
    moves.push({ id: s.id, after: target.id })
  }
  return moves
}

/** One step down, the mirror of `stepForward`. Like Send to back, it stops above frames, so a shape never goes behind the frame it sits on. */
export function stepBackward(items: ReadonlyArray<Shape>, picked: ReadonlySet<string>): ReadonlyArray<Move> {
  const order = [...items]
  const moves: Array<Move> = []
  for (let i = 0; i < order.length; i++) {
    const s = order[i]!
    if (!picked.has(s.id) || s.kind === "arrow") continue
    let j = i - 1
    while (j >= 0 && !picked.has(order[j]!.id) && (order[j]!.kind === "arrow" || !overlaps(s, order[j]!))) j--
    if (j < 0 || picked.has(order[j]!.id)) continue
    if (order[j]!.kind === "frame" && s.kind !== "frame") continue
    order.splice(i, 1)
    order.splice(j, 0, s)
    moves.push({ id: s.id, after: order[j - 1]?.id ?? null })
  }
  return moves
}
