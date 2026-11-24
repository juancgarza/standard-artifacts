/**
 * Selecting across blocks. Each block is its own contentEditable, and browsers
 * keep a drag that starts inside an editable clamped to that editable. So when a
 * drag leaves the block it started in, we release the editable's focus and
 * draw a real document selection from the drag's start to the pointer: copy,
 * the "Ask Claude" toolbar and ⌘J then work on it like any selection.
 *
 * Editing that selection (Backspace, Delete, typing, Enter, ⌘X) isn't something
 * browsers do across editables either, so `spliceSelection` computes the merge
 * the way Google Docs and Notion do: keep the first block's text before the
 * selection, join the last block's text after it, drop the blocks in between.
 */

/** A caret position under a screen point (Chrome/Safari `caretRangeFromPoint`, Firefox `caretPositionFromPoint`). */
export function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (pos) return { node: pos.offsetNode, offset: pos.offset }
  const range = doc.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** The block id under a point, or null outside blocks. */
export const blockAtPoint = (x: number, y: number): string | null =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ?? null

/** Offset of (node, offset) within `el`'s text, clamped to [0, length] when it lies outside `el`. */
function offsetIn(el: HTMLElement, node: Node, offset: number, outside: "start" | "end"): number {
  if (!el.contains(node)) return outside === "start" ? 0 : (el.innerText ?? "").replace(/\n$/, "").length
  const r = document.createRange()
  r.selectNodeContents(el)
  r.setEnd(node, offset)
  return r.toString().length
}

export type Splice = {
  /** The block that keeps the merged text. */
  readonly keep: string
  readonly text: string
  /** Where the caret goes afterwards (after anything typed). */
  readonly caret: number
  /** Blocks removed by the merge. */
  readonly remove: ReadonlyArray<string>
}

/**
 * The edit that replaces a cross-block selection with `insert`.
 * `ids` are the blocks the selection covers, in order; `els` maps ids to editables.
 */
export function spliceSelection(
  range: Range,
  ids: ReadonlyArray<string>,
  els: ReadonlyMap<string, HTMLElement>,
  textOf: (id: string) => string,
  insert: string,
): Splice | null {
  const first = ids[0]
  const last = ids.at(-1)
  if (!first || !last || first === last) return null
  const firstEl = els.get(first)
  const lastEl = els.get(last)
  if (!firstEl || !lastEl) return null
  const start = offsetIn(firstEl, range.startContainer, range.startOffset, "start")
  const end = offsetIn(lastEl, range.endContainer, range.endOffset, "end")
  const head = textOf(first).slice(0, start)
  const tail = textOf(last).slice(end)
  return { keep: first, text: head + insert + tail, caret: head.length + insert.length, remove: ids.slice(1) }
}
