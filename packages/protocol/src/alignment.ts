import type { BoardState } from "./board.ts"

/**
 * Alignment on a board, defined once for both readers of it: the canvas, which
 * snaps a dragged shape to its neighbours and draws the line they share, and
 * agents, who can't see that line and get it as a report instead.
 *
 * A box has three lines per axis: left, centre and right; top, middle and
 * bottom. Two boxes are aligned on a line when they put it at the same
 * coordinate. Arrows have no box, so they never count.
 *
 * This file imports nothing at runtime, so tests can load it directly.
 */

export const alignEdges = ["left", "center", "right", "top", "middle", "bottom"] as const
export type AlignEdge = (typeof alignEdges)[number]
const xEdges = ["left", "center", "right"] as const satisfies ReadonlyArray<AlignEdge>
const yEdges = ["top", "middle", "bottom"] as const satisfies ReadonlyArray<AlignEdge>

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
type Box = Rect & { readonly id: string }

/** Lines closer than this (board units) are the same line: half a pixel can't be seen. */
export const ALIGN_EPSILON = 0.5
/** How far off (board units) still reads as "meant to be aligned" in a report. */
export const DEFAULT_ALIGN_TOLERANCE = 8

export function edgeAt(r: Rect, edge: AlignEdge): number {
  switch (edge) {
    case "left":
      return r.x
    case "center":
      return r.x + r.w / 2
    case "right":
      return r.x + r.w
    case "top":
      return r.y
    case "middle":
      return r.y + r.h / 2
    case "bottom":
      return r.y + r.h
  }
}

// --- The canvas: snapping and guides ---------------------------------------------------

/**
 * A line two or more boxes share, in board coordinates. `axis: "x"` is a
 * vertical line at x = `at` running from y = `from` to y = `to`, the far ends
 * of the boxes on it; `axis: "y"` is the same, turned.
 */
export type Guide = { readonly axis: "x" | "y"; readonly at: number; readonly from: number; readonly to: number }

/** The smallest shift that puts one of `mine` on one of `theirs`, or 0 if none is within `threshold`. */
function snapDelta(mine: ReadonlyArray<number>, theirs: ReadonlyArray<number>, threshold: number): number {
  let best = 0
  let dist = Infinity
  for (const m of mine)
    for (const t of theirs) {
      const d = Math.abs(t - m)
      if (d <= threshold && d < dist) {
        dist = d
        best = t - m
      }
    }
  return best
}

/** The lines `box` shares with `targets`, looking only at these edges of the box (any edge of a target counts). */
export function guidesFor(box: Rect, targets: ReadonlyArray<Rect>, edges: ReadonlyArray<AlignEdge> = alignEdges): ReadonlyArray<Guide> {
  const out: Array<Guide> = []
  for (const edge of edges) {
    const vertical = edge === "left" || edge === "center" || edge === "right"
    const at = edgeAt(box, edge)
    if (out.some((g) => g.axis === (vertical ? "x" : "y") && Math.abs(g.at - at) <= ALIGN_EPSILON)) continue
    const on = targets.filter((t) => (vertical ? xEdges : yEdges).some((e) => Math.abs(edgeAt(t, e) - at) <= ALIGN_EPSILON))
    if (!on.length) continue
    const all = [box, ...on]
    out.push({
      axis: vertical ? "x" : "y",
      at,
      from: Math.min(...all.map((r) => (vertical ? r.y : r.x))),
      to: Math.max(...all.map((r) => (vertical ? r.y + r.h : r.x + r.w))),
    })
  }
  return out
}

/** Moving `box`: the nudge that lines it up with the nearest target line on each axis (within `threshold`), and the lines it then shares. */
export function snapMove(box: Rect, targets: ReadonlyArray<Rect>, threshold: number): { readonly dx: number; readonly dy: number; readonly guides: ReadonlyArray<Guide> } {
  const lines = (edges: ReadonlyArray<AlignEdge>, of: Rect) => edges.map((e) => edgeAt(of, e))
  const dx = snapDelta(lines(xEdges, box), targets.flatMap((t) => lines(xEdges, t)), threshold)
  const dy = snapDelta(lines(yEdges, box), targets.flatMap((t) => lines(yEdges, t)), threshold)
  return { dx, dy, guides: guidesFor({ ...box, x: box.x + dx, y: box.y + dy }, targets) }
}

/** Resizing `box` from its bottom-right corner: the size that lines its right and bottom edges up, never below `min`. */
export function snapResize(
  box: Rect,
  targets: ReadonlyArray<Rect>,
  threshold: number,
  min: { readonly w: number; readonly h: number },
): { readonly w: number; readonly h: number; readonly guides: ReadonlyArray<Guide> } {
  const dw = snapDelta([box.x + box.w], targets.flatMap((t) => xEdges.map((e) => edgeAt(t, e))), threshold)
  const dh = snapDelta([box.y + box.h], targets.flatMap((t) => yEdges.map((e) => edgeAt(t, e))), threshold)
  const w = box.w + dw >= min.w ? box.w + dw : box.w
  const h = box.h + dh >= min.h ? box.h + dh : box.h
  return { w, h, guides: guidesFor({ ...box, w, h }, targets, ["right", "bottom"]) }
}

// --- Agents: the report ----------------------------------------------------------------

/** A change that settles a finding, in the shape `board_update` takes. */
export type ShapeFix = { readonly id: string; readonly x?: number; readonly y?: number; readonly w?: number; readonly h?: number }

/** Shapes that share one or more lines on one axis. */
export type AlignedGroup = {
  readonly edges: ReadonlyArray<AlignEdge>
  /** Where each of `edges` sits, in the same order. */
  readonly at: ReadonlyArray<number>
  /** Along the line: top to bottom for a column (shared left, centre or right), left to right for a row. */
  readonly ids: ReadonlyArray<string>
  /** Three or more that don't overlap: the gap between each pair of neighbours. */
  readonly gaps?: ReadonlyArray<number>
  /** `almost`: the gaps differ, but by no more than the tolerance. */
  readonly spacing?: "even" | "almost" | "uneven"
  /** `almost` only: moves that even the gaps out; the first and last stay where they are. */
  readonly fixes?: ReadonlyArray<ShapeFix>
}

/** A shape that just misses a line others share. */
export type NearMiss = {
  readonly id: string
  /** `size`: its opposite edge is on their line, so no move fixes it; it's a little bigger or smaller. */
  readonly kind: "position" | "size"
  readonly edges: ReadonlyArray<AlignEdge>
  /** The shapes on the line it misses. */
  readonly with: ReadonlyArray<string>
  /** `position`: how far past their line it is (positive is right or down). `size`: how much bigger it is than them. */
  readonly off: number
  readonly fix: ShapeFix
}

export type AlignmentReport = {
  /** Shapes compared (everything on the board but arrows). */
  readonly checked: number
  readonly tolerance: number
  readonly aligned: ReadonlyArray<AlignedGroup>
  readonly near: ReadonlyArray<NearMiss>
}

type Cluster = { readonly at: number; readonly ids: Array<string> }

/** Boxes grouped by where they put an edge, in order along the axis. Each group's `at` is its first member's. */
function clusters(boxes: ReadonlyArray<Box>, edge: AlignEdge): ReadonlyArray<Cluster> {
  const out: Array<Cluster> = []
  for (const { id, v } of boxes.map((b) => ({ id: b.id, v: edgeAt(b, edge) })).sort((a, b) => a.v - b.v)) {
    const open = out.at(-1)
    if (open && v - open.at <= ALIGN_EPSILON) open.ids.push(id)
    else out.push({ at: v, ids: [id] })
  }
  return out
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * What lines up on a board and what nearly does. With `ids`, only findings that
 * involve one of those shapes are kept (they're still compared with everything).
 */
export function alignmentOf(state: BoardState, options: { readonly ids?: ReadonlyArray<string> | undefined; readonly tolerance?: number | undefined } = {}): AlignmentReport {
  const boxes: ReadonlyArray<Box> = state.items.filter((s) => s.kind !== "arrow")
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const wanted = options.ids?.length ? new Set(options.ids) : undefined
  const tolerance = Math.min(200, Math.max(1, options.tolerance ?? DEFAULT_ALIGN_TOLERANCE))
  const byEdge = new Map(alignEdges.map((e) => [e, clusters(boxes, e)]))
  /** edge → shape id → the group it's in on that edge. */
  const groupOf = new Map(alignEdges.map((e) => [e, new Map(byEdge.get(e)!.flatMap((c) => c.ids.map((id) => [id, c] as const)))]))
  const sameLine = (edge: AlignEdge, a: string, b: string) => groupOf.get(edge)!.get(a) === groupOf.get(edge)!.get(b)

  const aligned: Array<AlignedGroup> = []
  const near: Array<NearMiss & { readonly strength: number }> = []

  for (const edges of [xEdges, yEdges]) {
    const column = edges === xEdges
    /** Along the shared line: a column runs down, a row runs across. */
    const start = (b: Rect) => (column ? b.y : b.x)
    const size = (b: Rect) => (column ? b.h : b.w)

    // Groups with the same members on several edges (same-width boxes in a column share left, centre and right) are one finding.
    const groups = new Map<string, { edges: Array<AlignEdge>; at: Array<number>; ids: ReadonlyArray<string> }>()
    for (const edge of edges)
      for (const c of byEdge.get(edge)!) {
        if (c.ids.length < 2) continue
        const key = [...c.ids].sort().join(" ")
        const g = groups.get(key) ?? { edges: [], at: [], ids: c.ids }
        g.edges.push(edge)
        g.at.push(round(c.at))
        groups.set(key, g)
      }
    for (const g of groups.values()) {
      if (wanted && !g.ids.some((id) => wanted.has(id))) continue
      const sorted = g.ids.map((id) => byId.get(id)!).sort((a, b) => start(a) - start(b))
      const gaps = sorted.slice(1).map((b, i) => start(b) - (start(sorted[i]!) + size(sorted[i]!)))
      const group = { edges: g.edges, at: g.at, ids: sorted.map((b) => b.id) }
      if (sorted.length < 3 || gaps.some((gap) => gap < -ALIGN_EPSILON)) {
        aligned.push(group)
        continue
      }
      const spread = Math.max(...gaps) - Math.min(...gaps)
      const spacing = spread <= ALIGN_EPSILON ? "even" : spread <= tolerance ? "almost" : "uneven"
      const fixes: Array<ShapeFix> = []
      if (spacing === "almost") {
        const gap = gaps.reduce((sum, v) => sum + v, 0) / gaps.length
        let at = start(sorted[0]!) + size(sorted[0]!) + gap
        for (const b of sorted.slice(1, -1)) {
          if (Math.abs(at - start(b)) > 0.005) fixes.push(column ? { id: b.id, y: round(at) } : { id: b.id, x: round(at) })
          at += size(b) + gap
        }
      }
      aligned.push({ ...group, gaps: gaps.map(round), spacing, ...(fixes.length && { fixes }) })
    }

    // Near misses: a group that sits within the tolerance of a bigger one (or, between equals, the one further along).
    const found = new Map<string, { id: string; kind: "position" | "size"; edges: Array<AlignEdge>; with: ReadonlyArray<string>; off: number; fix: ShapeFix; strength: number }>()
    const [lo, , hi] = edges
    for (const edge of edges) {
      const list = byEdge.get(edge)!
      list.forEach((c, i) => {
        let anchor: Cluster | undefined
        const consider = (o: Cluster) => {
          const better = !anchor || o.ids.length > anchor.ids.length || (o.ids.length === anchor.ids.length && Math.abs(o.at - c.at) < Math.abs(anchor.at - c.at))
          if (better) anchor = o
        }
        for (let j = i - 1; j >= 0 && c.at - list[j]!.at <= tolerance; j--) consider(list[j]!)
        for (let j = i + 1; j < list.length && list[j]!.at - c.at <= tolerance; j++) consider(list[j]!)
        if (!anchor) return
        const a: Cluster = anchor
        if (a.ids.length < c.ids.length || (a.ids.length === c.ids.length && a.at > c.at)) return
        for (const id of c.ids) {
          if (wanted && !wanted.has(id) && !a.ids.some((x) => wanted.has(x))) continue
          const s = byId.get(id)!
          const off = edgeAt(s, edge) - a.at
          // Already on a line with them along this axis: moving it would break that, so only a resize can fix it.
          const pinned = edges.filter((e) => e !== edge && a.ids.some((x) => sameLine(e, id, x)))
          let kind: "position" | "size" = "position"
          let fix: ShapeFix
          let amount = off
          if (!pinned.length) fix = column ? { id, x: round(s.x - off) } : { id, y: round(s.y - off) }
          else if (edge === hi && pinned.includes(lo)) {
            kind = "size"
            fix = column ? { id, w: round(s.w - off) } : { id, h: round(s.h - off) }
          } else if (edge === lo && pinned.includes(hi)) {
            kind = "size"
            amount = -off
            fix = column ? { id, x: round(s.x - off), w: round(s.w + off) } : { id, y: round(s.y - off), h: round(s.h + off) }
          } else continue
          if ((fix.w ?? 1) <= 0 || (fix.h ?? 1) <= 0) continue
          // One finding per fix: the same move often settles several edges, and the line with the most shapes on it says why.
          const key = `${kind} ${id} ${JSON.stringify(fix)}`
          const seen = found.get(key)
          const same = seen && seen.with.length === a.ids.length && a.ids.every((x) => seen.with.includes(x))
          if (seen && same) seen.edges.push(edge)
          else if (!seen || a.ids.length > seen.with.length) found.set(key, { id, kind, edges: [edge], with: a.ids, off: round(amount), fix, strength: a.ids.length })
        }
      })
    }
    near.push(...found.values())
  }

  aligned.sort((a, b) => b.ids.length - a.ids.length)
  near.sort((a, b) => b.strength - a.strength || Math.abs(a.off) - Math.abs(b.off))
  return { checked: boxes.length, tolerance, aligned, near: near.map(({ strength: _, ...miss }) => miss) }
}

const isColumn = (edges: ReadonlyArray<AlignEdge>) => edges[0] === "left" || edges[0] === "center" || edges[0] === "right"

function labeller(state: BoardState) {
  const byId = new Map(state.items.map((s) => [s.id, s]))
  return (id: string) => {
    const text = byId.get(id)?.text
    return text ? `${id}("${text.slice(0, 24)}")` : id
  }
}

const listed = (ids: ReadonlyArray<string>, max = 4) => (ids.length > max ? `${ids.slice(0, max).join(", ")} and ${ids.length - max} more` : ids.join(", "))

/** One near miss as a line an agent can act on: what's off, by how much, and the `board_update` patch that fixes it. */
export function nearMissText(state: BoardState, miss: NearMiss): string {
  const label = labeller(state)
  const column = isColumn(miss.edges)
  const by = round(Math.abs(miss.off))
  if (miss.kind === "size") {
    const word = column ? (miss.off > 0 ? "wider" : "narrower") : miss.off > 0 ? "taller" : "shorter"
    const [pinned, loose] = miss.edges[0] === "right" || miss.edges[0] === "bottom" ? [column ? "left" : "top", miss.edges[0]] : [column ? "right" : "bottom", miss.edges[0]]
    return `${label(miss.id)} is ${by} ${word} than ${listed(miss.with)}: ${pinned} edges line up, ${loose} edges don't. Fix: ${JSON.stringify(miss.fix)}`
  }
  const where = column ? (miss.off > 0 ? "right of" : "left of") : miss.off > 0 ? "below" : "above"
  return `${label(miss.id)}: ${miss.edges.join("+")} is ${by} ${where} ${listed(miss.with)}. Fix: ${JSON.stringify(miss.fix)}`
}

/** The report as compact text for agents, in the style of `boardToText`. */
export function alignmentText(state: BoardState, report: AlignmentReport, limit = 40): string {
  if (!report.checked) return "No shapes to check."
  const label = labeller(state)
  const capped = <A>(items: ReadonlyArray<A>, line: (item: A) => string) => [
    ...items.slice(0, limit).map((item) => `- ${line(item)}`),
    ...(items.length > limit ? [`- …and ${items.length - limit} more; pass \`shapes\` to narrow it down`] : []),
  ]
  const uneven = report.aligned.filter((g) => g.spacing === "almost")
  const out = [`Checked ${report.checked} shape${report.checked === 1 ? "" : "s"}, tolerance ${report.tolerance}: ${report.aligned.length} aligned group${report.aligned.length === 1 ? "" : "s"}, ${report.near.length} almost aligned, ${uneven.length} almost evenly spaced.`]

  if (report.near.length) out.push("", "Almost aligned (off by the tolerance or less):", ...capped(report.near, (m) => nearMissText(state, m)))
  if (uneven.length)
    out.push(
      "",
      "Almost evenly spaced:",
      ...capped(uneven, (g) => `${g.ids.map(label).join(", ")} ${isColumn(g.edges) ? "top to bottom" : "left to right"}: gaps ${g.gaps!.join(", ")}. Fix: ${JSON.stringify(g.fixes ?? [])}`),
    )
  if (report.aligned.length)
    out.push(
      "",
      "Aligned:",
      ...capped(report.aligned, (g) => {
        const gaps = g.gaps ? ` · gaps ${isColumn(g.edges) ? "top to bottom" : "left to right"} ${g.gaps.join(", ")}${g.spacing === "even" ? " (even)" : g.spacing === "almost" ? " (almost even)" : ""}` : ""
        return `${g.edges.join("+")} at ${isColumn(g.edges) ? "x" : "y"}=${g.at.join("/")}: ${g.ids.map(label).join(", ")}${gaps}`
      }),
    )
  if (!report.near.length && !uneven.length) out.push("", `Nothing is nearly aligned: every edge and centre either matches another or is more than ${report.tolerance} away.`)
  else out.push("", "Each Fix is a `shapes` entry for board_update.")
  return out.join("\n")
}
