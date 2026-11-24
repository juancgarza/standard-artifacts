import type { Shape, ShapeColor, ShapeKind } from "@standard-artifacts/protocol"

export type Point = { x: number; y: number }
export type Camera = { x: number; y: number; zoom: number }

export const toWorld = (cam: Camera, sx: number, sy: number): Point => ({ x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y })
export const toScreen = (cam: Camera, p: Point): Point => ({ x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom })

/** Zoom around a screen point so the world point under the cursor stays put. */
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const zoom = Math.min(4, Math.max(0.1, cam.zoom * factor))
  const before = toWorld(cam, sx, sy)
  return { zoom, x: before.x - sx / zoom, y: before.y - sy / zoom }
}

export const center = (s: Shape): Point => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 })

export const contains = (s: Shape, p: Point) => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h

/** Where the segment from the box centre towards `toward` leaves the box (so arrows touch edges, not centres). */
export function edgePoint(s: Shape, toward: Point): Point {
  const c = center(s)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (dx === 0 && dy === 0) return c
  if (s.kind === "ellipse") {
    const a = s.w / 2
    const b = s.h / 2
    const t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b))
    return { x: c.x + dx * t, y: c.y + dy * t }
  }
  const tx = dx === 0 ? Infinity : s.w / 2 / Math.abs(dx)
  const ty = dy === 0 ? Infinity : s.h / 2 / Math.abs(dy)
  const t = Math.min(tx, ty)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

/** One end of an arrow: a shape it's attached to, or a free point. */
export type Anchor = Shape | Point
export const isShape = (a: Anchor): a is Shape => "kind" in a
const anchorCenter = (a: Anchor): Point => (isShape(a) ? center(a) : a)

/** The drawn segment between two anchors: attached ends sit on their shape's edge, aimed at the other end. */
export function arrowLine(a: Anchor, b: Anchor): { p1: Point; p2: Point } {
  return { p1: isShape(a) ? edgePoint(a, anchorCenter(b)) : a, p2: isShape(b) ? edgePoint(b, anchorCenter(a)) : b }
}

/** A filled arrowhead (SVG polygon points) at `tip`, pointing away from `tail`. */
export function arrowHead(tail: Point, tip: Point, size: number): string {
  const len = Math.hypot(tip.x - tail.x, tip.y - tail.y) || 1
  const ux = (tip.x - tail.x) / len
  const uy = (tip.y - tail.y) / len
  const bx = tip.x - ux * size
  const by = tip.y - uy * size
  const half = size * 0.5
  return `${tip.x},${tip.y} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export const palette: Record<ShapeColor, { fill: string; stroke: string }> = {
  yellow: { fill: "#fff3c4", stroke: "#e5a400" },
  blue: { fill: "#dbe8ff", stroke: "#2f6fed" },
  green: { fill: "#d6f5e3", stroke: "#1e9e6a" },
  pink: { fill: "#ffdcec", stroke: "#d6409f" },
  purple: { fill: "#eadcff", stroke: "#8e4ec6" },
  gray: { fill: "#eeeeec", stroke: "#8f8f8a" },
}

export const defaults: Record<Exclude<ShapeKind, "arrow" | "image" | "html" | "design" | "artifact">, { w: number; h: number; color: ShapeColor; text?: string }> = {
  note: { w: 200, h: 140, color: "yellow" },
  rect: { w: 160, h: 100, color: "blue" },
  ellipse: { w: 140, h: 140, color: "green" },
  text: { w: 220, h: 44, color: "gray" },
  frame: { w: 520, h: 340, color: "gray", text: "Frame" },
}
