/** Caret helpers for plain-text contentEditable blocks. */

export function caretOffset(el: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.focusNode)) return null
  const range = document.createRange()
  range.selectNodeContents(el)
  range.setEnd(sel.focusNode!, sel.focusOffset)
  return range.toString().length
}

export function hasSelection(el: HTMLElement): boolean {
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && el.contains(sel.anchorNode)
}

export function setCaret(el: HTMLElement, offset: number) {
  el.focus()
  const sel = window.getSelection()
  if (!sel) return
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let node = walker.nextNode()
  while (node) {
    const len = node.textContent?.length ?? 0
    if (remaining <= len) {
      sel.collapse(node, remaining)
      return
    }
    remaining -= len
    node = walker.nextNode()
  }
  // Past the end (or no text nodes): put the caret at the end.
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Text of a plain-text editable, without the trailing newline browsers add. */
export const editableText = (el: HTMLElement) => (el.innerText ?? "").replace(/\n$/, "")

/** Start and end offsets of the selection inside `el` (equal when it's a caret). */
export function selectionOffsets(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null
  const measure = (node: Node, offset: number) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    r.setEnd(node, offset)
    return r.toString().length
  }
  return { start: measure(range.startContainer, range.startOffset), end: measure(range.endContainer, range.endOffset) }
}

/** Screen rect of the caret, falling back to the element's first line (an empty block has no text to measure). */
export function caretRect(el: HTMLElement): { left: number; top: number; bottom: number } {
  const sel = window.getSelection()
  const rect = sel && sel.rangeCount > 0 && el.contains(sel.focusNode) ? sel.getRangeAt(0).getClientRects()[0] : undefined
  if (rect && rect.height > 0) return { left: rect.left, top: rect.top, bottom: rect.bottom }
  const box = el.getBoundingClientRect()
  const line = parseFloat(getComputedStyle(el).lineHeight) || 24
  return { left: box.left, top: box.top, bottom: box.top + line }
}
