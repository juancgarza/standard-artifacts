import { createElement, memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { attrError, maxDesignDepth, nodeLabel, styleError, type DesignNode, type DesignTree } from "@standard-artifacts/protocol"

/**
 * Design frames render their layers as real DOM in the canvas's world layer, so
 * they scale with the board and can be hit-tested with the DOM. The node tree
 * is already validated by the reducer; rendering filters styles and attributes
 * through the same allowlists again, so a frame stored under older rules can
 * never put anything else into the app's document.
 *
 * The frame box is the containment boundary: `contain: layout paint` makes it
 * the containing block for absolute children and clips painting to it, and
 * `isolation` keeps z-indexes inside, so no layer can cover the app's UI.
 */

/**
 * Browser-like defaults for the tags designs use. The app's CSS reset (Tailwind
 * preflight) zeroes headings, lists and buttons; without these, pasted HTML that
 * relies on defaults would look different on the canvas than when copied out.
 * Unlayered rules win over the reset's layer; inline styles win over both.
 */
const baseCss = `
[data-design-root]{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f1f1d;text-align:left;cursor:default}
[data-design-root] h1{font-size:2em;font-weight:700;margin:.67em 0}
[data-design-root] h2{font-size:1.5em;font-weight:700;margin:.83em 0}
[data-design-root] h3{font-size:1.17em;font-weight:700;margin:1em 0}
[data-design-root] h4{font-size:1em;font-weight:700;margin:1.33em 0}
[data-design-root] p{margin:1em 0}
[data-design-root] ul,[data-design-root] ol{margin:1em 0;padding-left:40px}
[data-design-root] ul{list-style:disc}
[data-design-root] ol{list-style:decimal}
[data-design-root] strong{font-weight:700}
[data-design-root] em{font-style:italic}
[data-design-root] small{font-size:.83em}
[data-design-root] a{color:#2f6fed;text-decoration:underline}
[data-design-root] hr{border:0;border-top:1px solid #d4d4d0;margin:.5em 0}
[data-design-root] button{font:inherit;padding:1px 6px;border:1px solid #c8c8c4;border-radius:4px;background:#efefed;color:inherit}
[data-design-root] input{font:inherit;padding:2px 4px;border:1px solid #c8c8c4;border-radius:3px;background:#fff;color:inherit}
[data-design-root] img{display:inline-block;max-width:none}
[data-design-root] [contenteditable]{outline:none;cursor:text;user-select:text;-webkit-user-select:text}
`

/** Inline CSS for React: only allowlisted declarations, names in camelCase. */
export function reactStyle(style: DesignNode["style"]): CSSProperties {
  const out: Record<string, string> = {}
  for (const [prop, value] of Object.entries(style ?? {})) {
    if (styleError(prop, value)) continue
    out[prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value
  }
  return out
}

const attr = (n: DesignNode, name: string) => {
  const v = n.attrs?.[name]
  return v !== undefined && !attrError(n.tag, name, v) ? v : undefined
}

export type TextEdit = { node: string; onCommit: (text: string) => void; onCancel: () => void }

/**
 * The layers themselves. Memoized on the tree, so panning, zooming, hovering and
 * selecting never re-render them; only edits do.
 */
export const DesignContent = memo(function DesignContent({ tree, edit }: { tree: DesignTree; edit: TextEdit | null }) {
  const render = (id: string, depth: number): ReactNode => {
    const n = tree.nodes[id]
    if (!n || depth > maxDesignDepth + 1) return null
    const editing = edit?.node === id
    // The canvas is a picture of the design, not a live page: links don't navigate,
    // buttons and inputs don't take focus or submit, images send no referrer.
    const props = {
      // A fresh element when editing starts and ends, so React never reconciles text the user typed into the DOM.
      key: editing ? `${id}:edit` : id,
      "data-node-id": id,
      style: reactStyle(n.style),
      ...(n.tag === "img" && { src: attr(n, "src"), alt: attr(n, "alt") ?? "", draggable: false, referrerPolicy: "no-referrer" as const, loading: "lazy" as const, decoding: "async" as const }),
      ...(n.tag === "input" && { placeholder: attr(n, "placeholder"), type: attr(n, "type") ?? "text", readOnly: true, tabIndex: -1 }),
      ...(n.tag === "button" && { type: "button" as const, tabIndex: -1 }),
      ...(editing && edit && textEditProps(edit, n.text ?? "")),
    }
    if (n.tag === "img" || n.tag === "input" || n.tag === "hr") return createElement(n.tag, props)
    return createElement(n.tag, props, n.text !== undefined && !editing ? n.text : editing ? (n.text ?? "") : n.children.map((c) => render(c, depth + 1)))
  }
  return (
    <div
      data-design-root
      className="relative h-full w-full overflow-hidden bg-white"
      style={{ contain: "layout paint", isolation: "isolate" }}
    >
      <style href="standard-artifacts-design-base" precedence="default">
        {baseCss}
      </style>
      {/* The root fills the frame at least, so a background on it covers the whole frame. */}
      <div className="h-full w-full [&>*]:min-h-full">{render(tree.root, 0)}</div>
    </div>
  )
})

/** contentEditable for in-place text editing: Enter or blur commits, Escape cancels. */
function textEditProps(edit: TextEdit, initial: string) {
  let cancelled = false
  return {
    contentEditable: "plaintext-only" as const,
    suppressContentEditableWarning: true,
    ref: (el: HTMLElement | null) => {
      if (!el || el === document.activeElement) return
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    },
    // The canvas captures the pointer and handles keys; text editing needs both for itself.
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    onPaste: (e: React.ClipboardEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      e.stopPropagation()
      if (e.key === "Escape") {
        e.preventDefault()
        cancelled = true
        e.currentTarget.textContent = initial
        e.currentTarget.blur()
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        e.currentTarget.blur()
      }
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      if (cancelled) return edit.onCancel()
      edit.onCommit(e.currentTarget.textContent ?? "")
    },
  }
}

export type LayerMark = { node: string; color: string; label: string; kind: "selected" | "hover" | "remote" }
type Rect = { x: number; y: number; w: number; h: number }

/**
 * Outlines for the hovered, selected and other people's selected layers, drawn
 * over the frame (outside its clipping) in board units. Positions come from the
 * DOM: layout is the browser's, so this is the only exact source.
 */
export function DesignOutlines({ shapeId, tree, marks, zoom }: { shapeId: string; tree: DesignTree; marks: ReadonlyArray<LayerMark>; zoom: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [rects, setRects] = useState<ReadonlyMap<string, Rect>>(new Map())
  const [tick, setTick] = useState(0)
  const key = marks.map((m) => `${m.kind}:${m.node}`).join(",")

  useLayoutEffect(() => {
    const host = ref.current?.parentElement
    const frame = host?.querySelector<HTMLElement>("[data-design-root]")
    if (!host || !frame) return
    const base = frame.getBoundingClientRect()
    const next = new Map<string, Rect>()
    for (const m of marks) {
      const el = frame.querySelector<HTMLElement>(`[data-node-id="${m.node}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      // Screen pixels back to board units: the world layer is scaled by the zoom.
      next.set(m.node, { x: (r.left - base.left) / zoom, y: (r.top - base.top) / zoom, w: r.width / zoom, h: r.height / zoom })
    }
    setRects(next)
    // `key` stands for `marks`; tree, zoom and tick cover layout changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tree, zoom, tick, shapeId])

  // Images load and fonts settle after the first layout; re-measure when the frame's content resizes.
  useLayoutEffect(() => {
    const frame = ref.current?.parentElement?.querySelector<HTMLElement>("[data-design-root] > div > *")
    if (!frame) return
    const ro = new ResizeObserver(() => setTick((t) => t + 1))
    ro.observe(frame)
    return () => ro.disconnect()
  }, [tree.root])

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      {marks.map((m) => {
        const r = rects.get(m.node)
        if (!r) return null
        const n = tree.nodes[m.node]
        const width = (m.kind === "hover" ? 1 : 2) / zoom
        return (
          <div
            key={`${m.kind}:${m.node}:${m.label}`}
            data-layer-outline={m.kind}
            className="absolute"
            style={{ left: r.x, top: r.y, width: r.w, height: r.h, outline: `${width}px solid ${m.color}`, outlineOffset: -width / 2 }}
          >
            {m.kind !== "hover" && (
              <span
                className="absolute bottom-full left-0 mb-0.5 rounded-sm px-1 text-[10px] leading-4 font-medium whitespace-nowrap text-white"
                style={{ background: m.color, transform: `scale(${1 / zoom})`, transformOrigin: "bottom left" }}
              >
                {m.kind === "remote" ? m.label : n ? `${n.tag}${n.text || n.tag === "img" ? ` · ${nodeLabel(n)}` : ""}` : m.label}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
