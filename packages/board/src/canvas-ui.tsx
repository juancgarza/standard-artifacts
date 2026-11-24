import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { CaretDownIcon, CheckIcon, SelectionBackgroundIcon, SelectionForegroundIcon, SparkleIcon, TextAaIcon, TrashIcon, type Icon } from "@phosphor-icons/react"
import { colorFor, type Shape, type ShapeColor, type ShapeKind, type TextSize } from "@standard-artifacts/protocol"
import { palette } from "./geometry"

/** Kinds whose text the format bar can resize. */
export const sizedKinds: ReadonlySet<ShapeKind> = new Set(["note", "rect", "ellipse", "text"])
/** Kinds the color swatches apply to (images, embeds and design frames draw their own content). */
export const coloredKinds: ReadonlySet<ShapeKind> = new Set(["note", "rect", "ellipse", "frame", "arrow"])

export const textSizes: ReadonlyArray<{ id: TextSize; label: string }> = [
  { id: "s", label: "Small" },
  { id: "m", label: "Medium" },
  { id: "l", label: "Large" },
  { id: "xl", label: "Extra large" },
]
const boxPx: Record<TextSize, number> = { s: 12, m: 14, l: 20, xl: 28 }
const textPx: Record<TextSize, number> = { s: 14, m: 20, l: 32, xl: 48 }
/** Font size in world pixels for a shape's text. */
export const fontPx = (s: Shape) => (s.kind === "text" ? textPx : boxPx)[s.textSize ?? "m"]

/** Who added a shape, from its `by` actorKey. Agents' keys are "agentId:userId". */
export type Author = { key: string; name: string; agent: boolean }

/**
 * A small "who wrote this" chip for a note's corner. Agents get a sparkle so
 * their notes read differently from people's at a glance. The name is drawn
 * with CSS (`attr()`), so a note's text content stays exactly its text.
 */
export function AuthorChip({ author }: { author: Author }) {
  return (
    <span
      role="img"
      aria-label={`Added by ${author.agent ? "Claude (agent)" : author.name}`}
      title={author.agent ? "Added by Claude, an agent" : `Added by ${author.name}`}
      data-author={author.agent ? "@claude" : author.name}
      className={`pointer-events-none absolute bottom-2 left-2.5 flex max-w-[calc(100%-20px)] items-center gap-1 rounded-full py-px pr-1.5 pl-px text-[11px] leading-4 font-medium whitespace-nowrap after:truncate after:content-[attr(data-author)] ${
        author.agent ? "text-[#6e3aa8]" : "text-[#1f1f1d]/60"
      }`}
      style={{ background: author.agent ? "rgb(255 255 255 / 0.7)" : "rgb(255 255 255 / 0.45)" }}
    >
      {author.agent ? (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[#8e4ec6] text-white">
          <SparkleIcon size={10} weight="fill" />
        </span>
      ) : (
        <span
          className="grid size-4 shrink-0 place-items-center rounded-full text-[9px] leading-none font-semibold text-white uppercase after:content-[attr(data-initial)]"
          data-initial={author.name.trim().charAt(0) || "?"}
          style={{ background: colorFor(author.key) }}
        />
      )}
    </span>
  )
}

/**
 * A frame's name as a filled tab sitting on its top edge. It's drawn above the
 * arrow layer (so connectors never cover it) at a constant screen size (so it
 * stays readable zoomed out), truncated to the frame's width.
 */
export function FrameHeader({ shape: s, zoom, selected, editor }: { shape: Shape; zoom: number; selected: boolean; editor?: ReactNode }) {
  const stroke = palette[s.color ?? "gray"].stroke
  return (
    <div
      data-frame-header={s.id}
      className="absolute flex h-6 items-center gap-1 rounded-t-md px-2 text-[12px] leading-6 font-semibold whitespace-nowrap"
      style={{
        left: s.x,
        top: s.y,
        maxWidth: s.w * zoom,
        minWidth: editor ? 200 : undefined,
        transform: `scale(${1 / zoom}) translateY(-100%)`,
        transformOrigin: "0 0",
        background: selected ? "var(--accent)" : `color-mix(in srgb, ${stroke} 24%, var(--bg))`,
        color: selected ? "var(--accent-text)" : `color-mix(in srgb, ${stroke} 55%, var(--text))`,
      }}
    >
      {editor ?? <span className="truncate">{s.text || "Frame"}</span>}
    </div>
  )
}

export type FormatBarProps = {
  shapes: ReadonlyArray<Shape>
  /** The selection's box in canvas (screen) pixels. */
  rect: { left: number; top: number; right: number; bottom: number }
  viewport: { w: number; h: number }
  onColor: (c: ShapeColor) => void
  onTextSize: (s: TextSize) => void
  onFront: () => void
  onBack: () => void
  onDelete: () => void
  onAsk?: () => void
  /** Give the keyboard back to the canvas (a menu item that took focus is gone once picked). */
  focusCanvas: () => void
  /** Kind-specific actions (embeds, design frames), shown before the layer buttons. */
  children?: ReactNode
}

const GAP = 10
const MARGIN = 8

/**
 * Contextual actions floating just above the selection (below it when there's
 * no room above), FigJam-style: color, text size, layer order, ask the agent,
 * delete.
 */
export function FormatBar({ shapes, rect, viewport, onColor, onTextSize, onFront, onBack, onDelete, onAsk, focusCanvas, children }: FormatBarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 40 })
  const [sizeMenu, setSizeMenu] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight })
  })

  const colored = shapes.filter((s) => coloredKinds.has(s.kind))
  const sized = shapes.filter((s) => sizedKinds.has(s.kind))
  const color = colored.length && colored.every((s) => (s.color ?? "gray") === (colored[0]!.color ?? "gray")) ? (colored[0]!.color ?? "gray") : null
  const current = sized.length && sized.every((s) => (s.textSize ?? "m") === (sized[0]!.textSize ?? "m")) ? (sized[0]!.textSize ?? "m") : null
  const onlyArrows = shapes.every((s) => s.kind === "arrow")

  const above = rect.top - GAP - size.h
  const top = above >= MARGIN ? above : rect.bottom + GAP + size.h <= viewport.h - 72 ? rect.bottom + GAP : MARGIN
  const mid = (rect.left + rect.right) / 2
  const left = Math.max(MARGIN, Math.min(viewport.w - size.w - MARGIN, mid - size.w / 2))

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selection"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="absolute top-0 left-0 z-30 flex items-center gap-0.5 rounded-lg border border-border bg-bg p-1 shadow-md"
      style={{ transform: `translate(${Math.round(left)}px, ${Math.round(top)}px)`, visibility: size.w ? "visible" : "hidden" }}
    >
      {colored.length > 0 && (
        <>
          <div className="flex items-center gap-1 px-1">
            {(Object.keys(palette) as ShapeColor[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                title={c[0]!.toUpperCase() + c.slice(1)}
                onClick={() => onColor(c)}
                className="grid size-6 place-items-center rounded-full transition-transform hover:scale-110"
                style={color === c ? { boxShadow: `0 0 0 2px var(--bg), 0 0 0 3.5px ${palette[c].stroke}` } : undefined}
              >
                <span className="size-5 rounded-full border-[1.5px]" style={{ background: palette[c].fill, borderColor: palette[c].stroke }} />
              </button>
            ))}
          </div>
          <Divider />
        </>
      )}
      {sized.length > 0 && (
        <>
          <div className="relative">
            <button
              type="button"
              aria-label="Text size"
              aria-haspopup="menu"
              aria-expanded={sizeMenu}
              title={`Text size${current ? `: ${textSizes.find((t) => t.id === current)!.label}` : ""}`}
              onClick={() => setSizeMenu((o) => !o)}
              className={`flex h-7 items-center gap-0.5 rounded px-1.5 ${sizeMenu ? "bg-hover text-text" : "text-muted hover:bg-hover hover:text-text"}`}
            >
              <TextAaIcon size={16} />
              <CaretDownIcon size={10} weight="bold" />
            </button>
            {sizeMenu && (
              <Menu onClose={() => setSizeMenu(false)} className="top-full left-0 mt-2 w-40">
                {textSizes.map((t) => (
                  <MenuItem
                    key={t.id}
                    label={t.label}
                    checked={current === t.id}
                    onSelect={() => {
                      onTextSize(t.id)
                      setSizeMenu(false)
                      focusCanvas()
                    }}
                    hint={<span style={{ fontSize: Math.min(18, boxPx[t.id]) }}>Aa</span>}
                  />
                ))}
              </Menu>
            )}
          </div>
          <Divider />
        </>
      )}
      {children}
      {!onlyArrows && (
        <>
          <IconButton label="Bring to front" icon={SelectionForegroundIcon} onClick={onFront} />
          <IconButton label="Send to back" icon={SelectionBackgroundIcon} onClick={onBack} />
          <Divider />
        </>
      )}
      {onAsk && (
        <>
          <button
            type="button"
            onClick={onAsk}
            title="Ask Claude about this: adds a connected @claude note"
            className="flex h-7 items-center gap-1.5 rounded px-2 text-[12px] font-medium text-[#8e4ec6] hover:bg-[#8e4ec6]/10 dark:text-[#c39af0]"
          >
            <SparkleIcon size={14} weight="fill" />
            Ask Claude
          </button>
          <Divider />
        </>
      )}
      <IconButton label="Delete" icon={TrashIcon} onClick={onDelete} />
    </div>
  )
}

export function ZoomMenu({
  zoom,
  hasSelection,
  onFit,
  onFitSelection,
  onZoom,
  onZoomBy,
  focusCanvas,
}: {
  zoom: number
  hasSelection: boolean
  onFit: () => void
  onFitSelection: () => void
  onZoom: (zoom: number) => void
  onZoomBy: (factor: number) => void
  focusCanvas: () => void
}) {
  const [open, setOpen] = useState(false)
  const run = (f: () => void) => () => {
    f()
    setOpen(false)
    focusCanvas()
  }
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Zoom"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Zoom options"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 items-center gap-0.5 rounded px-1.5 text-[12px] tabular-nums ${open ? "bg-hover text-text" : "text-muted hover:bg-hover hover:text-text"}`}
      >
        <span className="min-w-[34px] text-right">{Math.round(zoom * 100)}%</span>
        <CaretDownIcon size={10} weight="bold" className={`transition-transform ${open ? "" : "rotate-180"}`} />
      </button>
      {open && (
        <Menu onClose={() => setOpen(false)} className="right-0 bottom-full mb-2 w-52">
          <MenuItem label="Zoom in" hint="⌘ +" onSelect={() => onZoomBy(1.2)} />
          <MenuItem label="Zoom out" hint="⌘ −" onSelect={() => onZoomBy(1 / 1.2)} />
          <MenuDivider />
          <MenuItem label="Zoom to fit" hint="⇧ 1" onSelect={run(onFit)} />
          <MenuItem label="Zoom to selection" hint="⇧ 2" disabled={!hasSelection} onSelect={run(onFitSelection)} />
          <MenuDivider />
          {[0.5, 1, 2].map((z) => (
            <MenuItem key={z} label={`${z * 100}%`} checked={Math.abs(zoom - z) < 0.005} hint={z === 1 ? "⌘ 0" : undefined} onSelect={run(() => onZoom(z))} />
          ))}
        </Menu>
      )}
    </div>
  )
}

function Menu({ onClose, className, children }: { onClose: () => void; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      // The toggle button handles its own clicks.
      const owner = ref.current?.parentElement
      if (owner && e.target instanceof Node && !owner.contains(e.target)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose())
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("keydown", key, true)
    return () => {
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("keydown", key, true)
    }
  }, [onClose])
  return (
    <div ref={ref} role="menu" className={`absolute z-40 rounded-lg border border-border bg-bg p-1 text-[13px] shadow-lg ${className}`}>
      {children}
    </div>
  )
}

function MenuItem({ label, hint, checked, disabled, onSelect }: { label: string; hint?: ReactNode; checked?: boolean; disabled?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-text enabled:hover:bg-hover disabled:text-faint"
    >
      <span className="grid w-3.5 shrink-0 place-items-center text-accent">{checked && <CheckIcon size={13} weight="bold" />}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
    </button>
  )
}

const MenuDivider = () => <div className="mx-1 my-1 h-px bg-border" />
const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-border" />

export function IconButton({ label, icon: I, onClick, pressed, disabled }: { label: string; icon: Icon; onClick: () => void; pressed?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-7 place-items-center rounded disabled:opacity-30 ${pressed ? "bg-accent text-accent-text" : "text-muted enabled:hover:bg-hover enabled:hover:text-text"}`}
    >
      <I size={15} />
    </button>
  )
}

export function TextEditor({
  initial,
  onCommit,
  className,
  single,
  caretEnd,
  style,
}: {
  initial: string
  onCommit: (t: string) => void
  className: string
  single?: boolean
  /** Put the caret after the text instead of selecting it (for prefilled text like "@claude "). */
  caretEnd?: boolean
  style?: React.CSSProperties
}) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (caretEnd) el.setSelectionRange(el.value.length, el.value.length)
    else el.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <textarea
      ref={ref}
      value={text}
      rows={single ? 1 : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey || single))) {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      className={`h-full w-full resize-none bg-transparent leading-snug outline-none ${className}`}
      style={{ color: "inherit", ...style }}
    />
  )
}
