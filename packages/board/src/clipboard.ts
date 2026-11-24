import { Result, Schema } from "effect"
import { newId, Shape } from "@standard-artifacts/protocol"
import { boundsOf, type Delta } from "./arrange"
import type { Point } from "./geometry"

/*
 * Shapes on the system clipboard, so they paste into any board, in any window.
 * The async clipboard API only carries standard types, so they travel base64'd
 * in a data attribute of text/html (which browsers keep when sanitizing), with
 * the shapes' words as the text anywhere else they get pasted.
 */

const attribute = "data-standard-artifacts-board-shapes"
const decode = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Array(Shape)))

const toBase64 = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""))
const fromBase64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)))
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export const shapesText = (shapes: ReadonlyArray<Shape>) =>
  shapes
    .flatMap((s) => s.text?.trim() || [])
    .join("\n")

export const shapesToHtml = (shapes: ReadonlyArray<Shape>) => `<span ${attribute}="${toBase64(JSON.stringify(shapes))}">${escapeHtml(shapesText(shapes))}</span>`

export function shapesFromHtml(html: string): ReadonlyArray<Shape> | null {
  const encoded = html.match(new RegExp(`${attribute}="([^"]+)"`))?.[1]
  if (!encoded) return null
  try {
    const decoded = decode(fromBase64(encoded))
    return Result.isSuccess(decoded) ? decoded.success : null
  } catch {
    return null
  }
}

/** What was last copied here: for pasting when the browser won't let the page read the clipboard. */
let lastCopied: ReadonlyArray<Shape> | null = null
export const rememberCopied = (shapes: ReadonlyArray<Shape>) => {
  lastCopied = shapes
}
export const recallCopied = () => lastCopied

export async function writeShapes(shapes: ReadonlyArray<Shape>) {
  rememberCopied(shapes)
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([shapesToHtml(shapes)], { type: "text/html" }),
      "text/plain": new Blob([shapesText(shapes)], { type: "text/plain" }),
    }),
  ])
}

export type ClipboardContents = { readonly files: ReadonlyArray<File>; readonly html: string; readonly text: string }

export async function readClipboard(): Promise<ClipboardContents> {
  const files: Array<File> = []
  let html = ""
  let text = ""
  for (const item of await navigator.clipboard.read()) {
    for (const type of item.types) {
      if (type.startsWith("image/")) files.push(new File([await item.getType(type)], "image.png", { type }))
      else if (type === "text/html") html = await (await item.getType(type)).text()
      else if (type === "text/plain") text = await (await item.getType(type)).text()
    }
  }
  return { files, html, text }
}

/**
 * Stand-alone copies of shapes: an arrow end attached to something that isn't
 * coming along becomes a free point where it's drawn now, so the copy means the
 * same on any board. Arrows with a missing end aren't drawn, so they don't come.
 */
export function selfContained(shapes: ReadonlyArray<Shape>, lineOf: (id: string) => { p1: Point; p2: Point } | undefined): ReadonlyArray<Shape> {
  const ids = new Set(shapes.map((s) => s.id))
  return shapes.flatMap((s): Array<Shape> => {
    if (s.kind !== "arrow") return [s]
    const line = lineOf(s.id)
    if (!line) return []
    const { from, to, x2: _x2, y2: _y2, ...rest } = s
    return [
      {
        ...rest,
        ...(from && ids.has(from) ? { from } : { x: line.p1.x, y: line.p1.y }),
        ...(to && ids.has(to) ? { to } : { x2: line.p2.x, y2: line.p2.y }),
      },
    ]
  })
}

/** Everything a set of shapes covers, counting arrows' free ends. */
function extent(shapes: ReadonlyArray<Shape>) {
  const boxes = shapes.flatMap((s) => {
    if (s.kind !== "arrow") return [s]
    return [...(s.from ? [] : [{ x: s.x, y: s.y, w: 0, h: 0 }]), ...(s.to || s.x2 === undefined || s.y2 === undefined ? [] : [{ x: s.x2, y: s.y2, w: 0, h: 0 }])]
  })
  return boxes.length ? boundsOf(boxes) : { x: 0, y: 0, w: 0, h: 0 }
}

/**
 * New shapes with new ids, moved by what `place` says given their bounds. Arrows
 * come last: an arrow has to be inserted after the shapes it attaches to.
 */
export function cloneShapes(shapes: ReadonlyArray<Shape>, place: (bounds: { x: number; y: number; w: number; h: number }) => Delta): ReadonlyArray<Shape> {
  const { dx, dy } = place(extent(shapes))
  const ids = new Map(shapes.map((s) => [s.id, newId("s_")]))
  const copies = shapes.flatMap((s): Array<Shape> => {
    const id = ids.get(s.id)!
    const { by: _by, ...rest } = s
    if (s.kind !== "arrow") return [{ ...rest, id, x: s.x + dx, y: s.y + dy }]
    const from = s.from ? ids.get(s.from) : undefined
    const to = s.to ? ids.get(s.to) : undefined
    // A self-contained arrow's ends are all here; anything else is a clipboard from outside, and the reducer would turn it down.
    if ((s.from && !from) || (s.to && !to)) return []
    return [
      {
        ...rest,
        id,
        ...(from ? { from } : { x: s.x + dx, y: s.y + dy }),
        ...(to ? { to } : s.x2 !== undefined && s.y2 !== undefined ? { x2: s.x2 + dx, y2: s.y2 + dy } : {}),
      },
    ]
  })
  return [...copies.filter((s) => s.kind !== "arrow"), ...copies.filter((s) => s.kind === "arrow")]
}
