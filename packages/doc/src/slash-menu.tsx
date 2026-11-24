import { useEffect, useRef } from "react"
import {
  CheckSquareIcon,
  CodeIcon,
  ImageIcon,
  ListBulletsIcon,
  LinkSimpleIcon,
  ListNumbersIcon,
  MinusIcon,
  QuotesIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
  TextTIcon,
  type Icon,
} from "@phosphor-icons/react"
import type { BlockType } from "@standard-artifacts/protocol"

export type SlashItem = { type: BlockType; label: string; hint: string; icon: Icon; keywords: ReadonlyArray<string> }

/** The block types "/" offers, in menu order. `hint` is the markdown shortcut that does the same. */
export const slashItems: ReadonlyArray<SlashItem> = [
  { type: "paragraph", label: "Text", hint: "", icon: TextTIcon, keywords: ["paragraph", "plain"] },
  { type: "heading1", label: "Heading 1", hint: "#", icon: TextHOneIcon, keywords: ["h1", "title"] },
  { type: "heading2", label: "Heading 2", hint: "##", icon: TextHTwoIcon, keywords: ["h2", "subtitle"] },
  { type: "heading3", label: "Heading 3", hint: "###", icon: TextHThreeIcon, keywords: ["h3"] },
  { type: "bullet", label: "Bulleted list", hint: "-", icon: ListBulletsIcon, keywords: ["bullet", "ul", "unordered"] },
  { type: "numbered", label: "Numbered list", hint: "1.", icon: ListNumbersIcon, keywords: ["ol", "ordered", "number"] },
  { type: "todo", label: "To-do", hint: "[]", icon: CheckSquareIcon, keywords: ["task", "checkbox", "check"] },
  { type: "quote", label: "Quote", hint: ">", icon: QuotesIcon, keywords: ["blockquote", "callout"] },
  { type: "code", label: "Code", hint: "```", icon: CodeIcon, keywords: ["snippet", "pre"] },
  { type: "divider", label: "Divider", hint: "---", icon: MinusIcon, keywords: ["hr", "line", "separator", "rule"] },
  { type: "image", label: "Image", hint: "", icon: ImageIcon, keywords: ["picture", "photo", "img", "screenshot", "upload"] },
  { type: "embed", label: "Linked artifact", hint: "", icon: LinkSimpleIcon, keywords: ["link", "embed", "preview", "table", "board", "doc", "issue", "tracker"] },
]

// Compare letters and digits only, so "todo" finds "To-do" and "heading 2" finds "Heading 2".
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/** Items matching `query`, best first: label prefix, then keyword prefix, then anywhere in the label. */
export function filterSlash(query: string): ReadonlyArray<SlashItem> {
  const q = norm(query)
  if (!q) return slashItems
  const score = (item: SlashItem) => {
    const label = norm(item.label)
    if (label.startsWith(q)) return 0
    if (item.keywords.some((k) => norm(k).startsWith(q))) return 1
    if (label.includes(q)) return 2
    return -1
  }
  return slashItems
    .map((item) => ({ item, s: score(item) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.item)
}

/**
 * Whether the menu should give up on `query`: like Notion, it stays open through
 * a typo or two with "No results", then closes once the query has run three
 * characters past its last match (the "/" was probably just a slash).
 */
export function slashGaveUp(query: string): boolean {
  // "/ " is a slash in prose, not a command.
  if (/\n/.test(query) || /^\s/.test(query)) return true
  if (filterSlash(query).length) return false
  let matched = 0
  for (let n = query.length - 1; n >= 0; n--) {
    if (filterSlash(query.slice(0, n)).length) {
      matched = n
      break
    }
  }
  return query.length - matched >= 3 || /\s$/.test(query)
}

export function SlashMenu({
  items,
  active,
  position,
  onHover,
  onChoose,
}: {
  items: ReadonlyArray<SlashItem>
  active: number
  /** Relative to the block: below the caret, or above it when there's no room below. */
  position: { left: number; top?: number; bottom?: number }
  onHover: (index: number) => void
  onChoose: (item: SlashItem) => void
}) {
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" })
  }, [active])

  return (
    <div
      ref={list}
      id="doc-slash-menu"
      role="listbox"
      aria-label="Block types"
      // Keep focus (and the caret) in the block while clicking the menu.
      onMouseDown={(e) => e.preventDefault()}
      className="absolute z-30 max-h-80 w-64 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-lg"
      style={{ left: position.left, top: position.top, bottom: position.bottom }}
    >
      {items.length === 0 ? (
        <div className="px-2 py-1.5 text-[13px] text-muted">No results</div>
      ) : (
        <>
          <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-faint">Turn into</div>
          {items.map((item, i) => (
            <div
              key={item.type}
              id={`doc-slash-${item.type}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => i !== active && onHover(i)}
              onClick={() => onChoose(item)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[14px] ${i === active ? "bg-hover" : ""}`}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded border border-border bg-bg text-muted">
                <item.icon size={16} />
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.hint && <span className="font-mono text-[11px] text-faint">{item.hint}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
