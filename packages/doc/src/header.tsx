import { useEffect, useRef, useState, type ReactNode } from "react"
import { ImageIcon, RobotIcon, SmileyIcon, TrashIcon } from "@phosphor-icons/react"
import { BrandTile, brandOf } from "@standard-artifacts/room/brands"
import { actorKey, colorFor, type Block, type Member, type PageMeta } from "@standard-artifacts/protocol"

/** Cover presets: the doc stores the name, the editor owns the look. */
export const covers: ReadonlyArray<{ id: string; label: string; css: string }> = [
  { id: "dawn", label: "Dawn", css: "linear-gradient(120deg, #fbd3e9 0%, #bbd2ff 100%)" },
  { id: "ocean", label: "Ocean", css: "linear-gradient(120deg, #2f6fed 0%, #12a594 100%)" },
  { id: "mint", label: "Mint", css: "linear-gradient(120deg, #d4fc79 0%, #96e6a1 100%)" },
  { id: "sunset", label: "Sunset", css: "linear-gradient(120deg, #f76b15 0%, #d6409f 100%)" },
  { id: "dusk", label: "Dusk", css: "linear-gradient(120deg, #8e4ec6 0%, #2f6fed 100%)" },
  { id: "sand", label: "Sand", css: "linear-gradient(120deg, #f6e7cf 0%, #e8cfa8 100%)" },
  { id: "graphite", label: "Graphite", css: "linear-gradient(120deg, #3a3a38 0%, #73736e 100%)" },
  { id: "sky", label: "Sky", css: "linear-gradient(180deg, #e0f0ff 0%, #a6c8ff 100%)" },
]
const coverCss = (id: string) => (covers.find((c) => c.id === id) ?? covers[0]!).css

const emojis = [
  "📄", "📝", "📌", "📎", "📚", "📊", "📈", "🗂️",
  "🚀", "🎯", "💡", "🧠", "🔥", "⭐", "✨", "🌱",
  "🛠️", "⚙️", "🧪", "🔍", "🧭", "🗺️", "🏁", "🎉",
  "✅", "❗", "❓", "💬", "🤝", "👋", "🙌", "❤️",
  "🍀", "🌊", "🌙", "☀️", "🍕", "☕", "🎨", "🎧",
]

/** Who changed the doc and when, from the blocks' edit stamps. */
export type Byline = {
  /** The newest timed edit; agents' HTTP edits carry no time and can't be ordered. */
  last: { key: string; at: number } | null
  /** Everyone with an edit stamp, the last editor first, then by how much they wrote. */
  authors: ReadonlyArray<string>
  /** Display names from the stamps themselves. */
  names: ReadonlyMap<string, string>
}

export function bylineOf(items: ReadonlyArray<Block>): Byline {
  let last: Byline["last"] = null
  const count = new Map<string, number>()
  const names = new Map<string, string>()
  for (const b of items) {
    const e = b.edited
    if (!e) continue
    count.set(e.by, (count.get(e.by) ?? 0) + 1)
    if (e.name) names.set(e.by, e.name)
    if (e.at !== undefined && (!last || e.at > last.at)) last = { key: e.by, at: e.at }
  }
  const authors = [...count.keys()].sort((a, b) => (a === last?.key ? -1 : b === last?.key ? 1 : (count.get(b) ?? 0) - (count.get(a) ?? 0)))
  return { last, authors, names }
}

/** Agents' actor keys are "<agent>:<on behalf of>". */
export const isAgentKey = (key: string) => key.includes(":")

export function ago(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** A full-width gradient band above the doc, with Change / Remove on hover. */
export function DocCover({ page, readOnly, onPage }: { page: PageMeta; readOnly: boolean; onPage: (next: PageMeta) => void }) {
  const [open, setOpen] = useState(false)
  const cover = page.cover
  if (!cover) return null
  return (
    <div data-doc-cover className="group/cover relative h-[30vh] max-h-[220px] min-h-[140px] w-full" style={{ background: coverCss(cover) }}>
      {!readOnly && (
        <div className={`absolute right-4 bottom-3 flex gap-1 transition-opacity group-hover/cover:opacity-100 focus-within:opacity-100 ${open ? "opacity-100" : "opacity-0"}`}>
          <HeaderButton onClick={() => setOpen(!open)} solid>
            Change cover
          </HeaderButton>
          <HeaderButton onClick={() => onPage({ ...page, cover: null })} solid label="Remove cover">
            <TrashIcon size={14} />
          </HeaderButton>
        </div>
      )}
      {open && (
        <Popover onClose={() => setOpen(false)} className="right-4 bottom-12">
          <div className="px-1 pb-1.5 text-[11px] font-medium text-faint">Cover</div>
          <div className="grid grid-cols-4 gap-1.5">
            {covers.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.label}
                aria-label={`${c.label} cover`}
                aria-pressed={c.id === cover}
                onClick={() => {
                  onPage({ ...page, cover: c.id })
                  setOpen(false)
                }}
                className={`h-10 w-16 rounded-md ring-offset-2 ring-offset-bg hover:ring-2 hover:ring-border ${c.id === cover ? "ring-2 ring-accent" : ""}`}
                style={{ background: c.css }}
              />
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}

/**
 * The top of the doc column (under the cover): icon, title (when the host
 * passes one) and a byline. "Add icon" / "Add cover" stay invisible until the
 * header is hovered (Notion's pattern), so an undecorated doc looks plain.
 */
export function DocHeader({
  page,
  readOnly,
  onPage,
  title,
  onTitle,
  onTitleEnter,
  byline,
}: {
  page: PageMeta
  readOnly: boolean
  onPage: (next: PageMeta) => void
  title: string | undefined
  onTitle: ((title: string) => void) | undefined
  /** Enter in the title moves into the doc. */
  onTitleEnter: () => void
  /** The byline, when it goes in the header (else the host places it, e.g. under the doc's first heading). */
  byline: ReactNode
}) {
  const [picking, setPicking] = useState(false)
  const icon = page.icon ?? null
  const cover = page.cover ?? null

  // Like Notion, adding a cover picks one right away; "Change cover" offers the rest.
  const addCover = () => onPage({ ...page, cover: covers[Math.floor(Math.random() * covers.length)]!.id })

  return (
    <div data-doc-header className="group/header relative">
      <div className={cover ? (icon ? "-mt-[38px]" : "pt-6") : "pt-10"}>
        {icon && (
          <div className="relative mb-2 w-fit">
            <button
              type="button"
              data-doc-icon
              disabled={readOnly}
              onClick={() => setPicking(!picking)}
              aria-label="Change icon"
              className="grid size-[76px] place-items-center rounded-lg text-[62px] leading-none transition-colors enabled:hover:bg-hover"
            >
              <span className="translate-y-[2px]">{icon}</span>
            </button>
            {picking && <EmojiPicker current={icon} onPick={(e) => onPage({ ...page, icon: e })} onClose={() => setPicking(false)} />}
          </div>
        )}

        {!readOnly && (!icon || !cover) && (
          <div className={`relative -ml-2 flex h-7 items-center gap-1 text-[13px] transition-opacity group-hover/header:opacity-100 focus-within:opacity-100 max-md:opacity-100 ${picking ? "opacity-100" : "opacity-0"}`}>
            {!icon && (
              <HeaderButton onClick={() => setPicking(!picking)}>
                <SmileyIcon size={15} /> Add icon
              </HeaderButton>
            )}
            {!cover && (
              <HeaderButton onClick={addCover}>
                <ImageIcon size={15} /> Add cover
              </HeaderButton>
            )}
            {picking && !icon && (
              <EmojiPicker current={null} onPick={(e) => onPage({ ...page, icon: e })} onClose={() => setPicking(false)} className="top-8 left-2" />
            )}
          </div>
        )}

        {title !== undefined && <Title value={title} onChange={readOnly ? undefined : onTitle} onEnter={onTitleEnter} />}

        {byline}
      </div>
    </div>
  )
}

function Title({ value, onChange, onEnter }: { value: string; onChange: ((t: string) => void) | undefined; onEnter: () => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const next = draft.trim()
    if (!next) return setDraft(value)
    if (next !== value) onChange?.(next)
  }
  return (
    <input
      value={draft}
      readOnly={!onChange}
      aria-label="Doc title"
      placeholder="Untitled"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          commit()
          onEnter()
        }
        if (e.key === "Escape") {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
      className="mb-1 w-full bg-transparent text-[38px] leading-tight font-bold tracking-tight outline-none placeholder:text-faint"
    />
  )
}

/** An agent's name from its key: "agt_codex:usr_1" is codex. The shared agent that names no app is Claude's. */
function agentNameOf(key: string) {
  const id = (key.split(":")[0] ?? key).replace(/^agt_/, "")
  return id === "dev" ? "Claude" : id
}

/** "Edited by @claude 3m ago · with you": the last timed edit and the other authors, with an avatar each. */
export function BylineRow({ byline, self, members }: { byline: Byline; self: Member | null; members: ReadonlyArray<Member> }) {
  // Relative times go stale; re-render twice a minute.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => setNow(Date.now()), [byline.last?.at])

  if (!byline.authors.length) return null
  const live = new Map([...members, ...(self ? [self] : [])].map((m) => [actorKey(m.actor), m.name]))
  const selfKey = self ? actorKey(self.actor) : null
  // Edit stamps from agents usually carry no name. Without one (or the agent here live) to go on, its id names the app.
  const fullName = (key: string) => byline.names.get(key) ?? live.get(key) ?? (isAgentKey(key) ? agentNameOf(key) : "A teammate")
  const label = (key: string) => (isAgentKey(key) ? `@${brandOf(fullName(key)) ?? fullName(key).toLowerCase()}` : key === selfKey ? "you" : fullName(key))
  const who = (key: string) => <span className={`font-medium ${isAgentKey(key) ? "text-accent" : "text-text"}`}>{label(key)}</span>
  const list = (keys: ReadonlyArray<string>, max: number) => (
    <>
      {keys.slice(0, max).map((k, i, shown) => (
        <span key={k}>
          {i > 0 && (i === shown.length - 1 && keys.length <= max ? " and " : ", ")}
          {who(k)}
        </span>
      ))}
      {keys.length > max && ` +${keys.length - max}`}
    </>
  )

  const last = byline.last
  const others = byline.authors.filter((k) => k !== last?.key)
  return (
    <div data-doc-byline className="mt-1.5 mb-4 flex items-center gap-2 text-[13px] text-muted select-none">
      <span className="flex -space-x-1.5">
        {byline.authors.slice(0, 4).map((k) => {
          // Agents are tiles and people are circles, as in the header's presence stack.
          const brand = isAgentKey(k) ? brandOf(fullName(k)) : null
          if (brand)
            return (
              <span key={k} data-agent-brand={brand} className="grid rounded-[6px] ring-2 ring-bg">
                <BrandTile brand={brand} size={22} title={`${fullName(k)} (agent)`} />
              </span>
            )
          return (
            <span
              key={k}
              title={isAgentKey(k) ? `${fullName(k)} (agent)` : fullName(k)}
              className={`grid size-[22px] place-items-center text-[10px] font-semibold text-white ring-2 ring-bg ${isAgentKey(k) ? "rounded-[6px]" : "rounded-full"}`}
              style={{ background: isAgentKey(k) ? "var(--accent)" : colorFor(k) }}
            >
              {isAgentKey(k) ? <RobotIcon size={12} weight="bold" /> : fullName(k).slice(0, 1).toUpperCase()}
            </span>
          )
        })}
      </span>
      {last ? (
        <span className="min-w-0 truncate">
          Edited by {who(last.key)} <span title={new Date(last.at).toLocaleString()}>{ago(last.at, now)}</span>
          {others.length > 0 && <span className="text-faint"> · with {list(others, 2)}</span>}
        </span>
      ) : (
        // No times anywhere (written by agents or scripts): say who, not when.
        <span className="min-w-0 truncate">Edited by {list(byline.authors, 3)}</span>
      )}
    </div>
  )
}

function HeaderButton({ onClick, children, solid, label }: { onClick: () => void; children: ReactNode; solid?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] ${
        solid ? "bg-bg/90 text-text shadow-sm backdrop-blur hover:bg-bg" : "text-faint hover:bg-hover hover:text-muted"
      }`}
    >
      {children}
    </button>
  )
}

function Popover({ onClose, className, children }: { onClose: () => void; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target) && !(e.target instanceof Element && e.target.closest("[data-doc-header] button, [data-doc-cover] button"))) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])
  return (
    <div ref={ref} role="dialog" className={`absolute z-40 rounded-lg border border-border bg-bg p-2 shadow-lg ${className}`}>
      {children}
    </div>
  )
}

function EmojiPicker({ current, onPick, onClose, className = "top-full left-0 mt-1" }: { current: string | null; onPick: (emoji: string | null) => void; onClose: () => void; className?: string }) {
  return (
    <Popover onClose={onClose} className={className}>
      <div aria-label="Pick an icon" className="w-[296px]">
        <div className="flex items-center justify-between px-1 pb-1.5 text-[11px] font-medium text-faint">
          Icon
          {current && (
            <button
              type="button"
              onClick={() => {
                onPick(null)
                onClose()
              }}
              className="rounded px-1.5 py-0.5 text-[12px] font-normal text-muted hover:bg-hover hover:text-text"
            >
              Remove
            </button>
          )}
        </div>
        <div className="grid grid-cols-8 gap-0.5">
          {emojis.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`Icon ${e}`}
              onClick={() => {
                onPick(e)
                onClose()
              }}
              className={`grid size-[34px] place-items-center rounded-md text-[20px] hover:bg-hover ${e === current ? "bg-hover" : ""}`}
            >
              {e}
            </button>
          ))}
        </div>
      </div>
    </Popover>
  )
}
