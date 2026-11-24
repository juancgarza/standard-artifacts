import { useCallback, useEffect, useState, type RefObject } from "react"
import type { Block } from "@standard-artifacts/protocol"

/** Docs with fewer headings than this don't get the outline. */
export const TOC_MIN_HEADINGS = 3
/** A heading is "current" once its top has scrolled this close to the top of the page. */
const ACTIVE_OFFSET_PX = 96

const level = (b: Block) => (b.type === "heading1" ? 1 : b.type === "heading2" ? 2 : b.type === "heading3" ? 3 : 0)
export const headingsOf = (blocks: ReadonlyArray<Block>) => blocks.filter((b) => level(b) > 0)

/**
 * The floating outline on the right (Notion / Craft style): a quiet column of
 * ticks, one per heading, that opens into a list on hover or focus. The tick
 * and row of the section in view are highlighted; clicking a row scrolls there.
 */
export function TableOfContents({
  headings,
  scroller,
  elementFor,
  onJump,
}: {
  headings: ReadonlyArray<Block>
  /** The element the doc scrolls in. */
  scroller: RefObject<HTMLElement | null>
  /** A heading's block element, to measure and scroll to. */
  elementFor: (id: string) => HTMLElement | undefined
  onJump: (id: string) => void
}) {
  const [current, setCurrent] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const measure = useCallback(() => {
    const root = scroller.current
    if (!root) return
    const top = root.getBoundingClientRect().top + ACTIVE_OFFSET_PX
    let active: string | null = headings[0]?.id ?? null
    for (const h of headings) {
      const el = elementFor(h.id)
      if (el && el.getBoundingClientRect().top <= top) active = h.id
    }
    // At the very bottom, the last heading is current even if it can't reach the top.
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
      const lastVisible = [...headings].reverse().find((h) => {
        const r = elementFor(h.id)?.getBoundingClientRect()
        return r && r.top < root.getBoundingClientRect().bottom
      })
      if (lastVisible) active = lastVisible.id
    }
    setCurrent(active)
  }, [headings, scroller, elementFor])

  useEffect(() => {
    const root = scroller.current
    if (!root) return
    measure()
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    root.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [measure, scroller])

  if (headings.length < TOC_MIN_HEADINGS) return null
  const minLevel = Math.min(...headings.map(level))

  return (
    <nav
      aria-label="Table of contents"
      data-doc-toc
      data-open={open || undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
      className="absolute top-1/2 right-3 z-20 -translate-y-1/2 select-none max-xl:hidden"
    >
      {open ? (
        <div className="max-h-[min(60vh,520px)] w-56 overflow-y-auto rounded-xl border border-border bg-bg p-1.5 shadow-lg">
          <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-faint">On this page</div>
          {headings.map((h) => {
            const indent = level(h) - minLevel
            const active = h.id === current
            return (
              <button
                key={h.id}
                type="button"
                aria-current={active ? "location" : undefined}
                onClick={() => onJump(h.id)}
                style={{ paddingLeft: 8 + indent * 12 }}
                className={`block w-full truncate rounded-md py-1 pr-2 text-left text-[13px] leading-5 hover:bg-hover ${
                  active ? "font-medium text-accent" : level(h) === minLevel ? "text-text" : "text-muted"
                }`}
              >
                {h.text.trim() || "Untitled"}
              </button>
            )
          })}
        </div>
      ) : (
        // Collapsed: one tick per heading, longer for higher levels. A button so keyboard users can open it too.
        <button type="button" aria-label="Show table of contents" onClick={() => setOpen(true)} className="flex flex-col items-end gap-[7px] rounded-lg px-1.5 py-2 hover:bg-hover">
          {headings.map((h) => (
            <span
              key={h.id}
              className={`block h-[2px] rounded-full transition-colors ${h.id === current ? "bg-accent" : "bg-faint/45"}`}
              style={{ width: 18 - (level(h) - minLevel) * 5 }}
            />
          ))}
        </button>
      )}
    </nav>
  )
}
