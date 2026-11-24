import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  ArrowLineDownIcon,
  ArrowLineUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  CursorClickIcon,
  FrameCornersIcon,
  ImageSquareIcon,
  LinkIcon,
  ListBulletsIcon,
  MinusIcon,
  StackIcon,
  TextAlignCenterIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextboxIcon,
  TextTIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react"
import {
  designAttrsFor,
  designFonts,
  designTags,
  isVoidTag,
  nodeLabel,
  parentOf,
  parseStyle,
  styleError,
  attrError,
  subtreeIds,
  type DesignNode,
  type DesignNodePatch,
  type DesignTag,
  type DesignTree,
} from "@standard-artifacts/protocol"

/*
 * Side panels for an entered design frame: the layer tree on the left, the
 * selected layer's properties on the right. Both stay visible for read-only
 * people (selection and inspection work; editing controls are disabled).
 */

const textTags: ReadonlySet<DesignTag> = new Set(["p", "h1", "h2", "h3", "h4", "span", "strong", "em", "small", "label", "li"])
function layerIcon(tag: DesignTag): Icon {
  if (tag === "img") return ImageSquareIcon
  if (tag === "button") return CursorClickIcon
  if (tag === "a") return LinkIcon
  if (tag === "input") return TextboxIcon
  if (tag === "ul" || tag === "ol") return ListBulletsIcon
  if (tag === "hr") return MinusIcon
  if (textTags.has(tag)) return TextTIcon
  return FrameCornersIcon
}

/** Whether a layer can hold other layers (not a void tag, and no text of its own). */
const canHold = (n: DesignNode) => !isVoidTag(n.tag) && n.text === undefined

type Drop = { target: string; zone: "before" | "after" | "inside" }

/** Panel chrome shared by both panels: stops the canvas from treating presses, wheels and keys as its own. */
function Panel({ side, label, children }: { side: "left" | "right"; label: string; children: ReactNode }) {
  return (
    <div
      data-board-panel
      role="complementary"
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      className={`absolute top-3 bottom-20 z-40 flex cursor-default flex-col overflow-hidden rounded-xl border border-border bg-bg text-[12px] text-text shadow-lg select-none ${side === "left" ? "left-3 w-60" : "right-3 w-72"}`}
    >
      {children}
    </div>
  )
}

export function LayersPanel({
  title,
  tree,
  selected,
  readOnly,
  onSelect,
  onHover,
  onMove,
  onNudge,
  onRename,
  onClose,
}: {
  title: string
  tree: DesignTree
  selected: string | null
  readOnly: boolean
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  onMove: (id: string, parent: string, index: number) => void
  onNudge: (by: -1 | 1) => void
  onRename: (title: string) => void
  onClose: () => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [drop, setDrop] = useState<Drop | null>(null)
  const drag = useRef<{ id: string; y: number; active: boolean; drop: Drop | null } | null>(null)

  const rows: Array<{ node: DesignNode; depth: number }> = []
  const walk = (id: string, depth: number) => {
    const node = tree.nodes[id]
    if (!node || depth > 60) return
    rows.push({ node, depth })
    if (!collapsed.has(id)) for (const c of node.children) walk(c, depth + 1)
  }
  walk(tree.root, 0)

  // Expand the ancestors of a layer selected on the canvas, so the tree always shows it.
  useEffect(() => {
    if (!selected) return
    const open: Array<string> = []
    for (let at = parentOf(tree, selected); at; at = parentOf(tree, at)) if (collapsed.has(at)) open.push(at)
    if (open.length) setCollapsed((c) => new Set([...c].filter((id) => !open.includes(id))))
    document.querySelector(`[data-layer-id="${selected}"]`)?.scrollIntoView({ block: "nearest" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  /** Where a dragged layer would land if released over `el` at `y`. */
  const dropAt = (id: string, el: HTMLElement | null, y: number): Drop | null => {
    const target = el?.dataset.layerId
    const node = target ? tree.nodes[target] : undefined
    if (!el || !target || !node || subtreeIds(tree, id).includes(target)) return null
    const r = el.getBoundingClientRect()
    const f = (y - r.top) / r.height
    if (target === tree.root) return { target, zone: "inside" }
    if (canHold(node) && f > 0.3 && f < 0.7) return { target, zone: "inside" }
    return { target, zone: f < 0.5 ? "before" : "after" }
  }

  const commitDrop = (id: string, d: Drop) => {
    if (d.zone === "inside") return onMove(id, d.target, tree.nodes[d.target]!.children.filter((c) => c !== id).length)
    const parent = parentOf(tree, d.target)
    if (!parent) return
    const siblings = tree.nodes[parent]!.children.filter((c) => c !== id)
    onMove(id, parent, siblings.indexOf(d.target) + (d.zone === "after" ? 1 : 0))
  }

  const single = selected ? tree.nodes[selected] : undefined
  const movable = !readOnly && single && selected !== tree.root
  return (
    <Panel side="left" label="Layers">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <StackIcon size={14} className="shrink-0 text-muted" />
        <input
          aria-label="Frame title"
          defaultValue={title}
          key={title}
          readOnly={readOnly}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur()
          }}
          onBlur={(e) => {
            const t = e.currentTarget.value.trim()
            if (!readOnly && t && t !== title) onRename(t)
          }}
          className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 font-medium outline-none focus:bg-surface"
        />
        {!readOnly && (
          <>
            <PanelButton label="Move layer up" icon={ArrowLineUpIcon} disabled={!movable} onClick={() => onNudge(-1)} />
            <PanelButton label="Move layer down" icon={ArrowLineDownIcon} disabled={!movable} onClick={() => onNudge(1)} />
          </>
        )}
        <PanelButton label="Close layers" icon={XIcon} onClick={onClose} />
      </div>
      <div role="tree" aria-label="Layer tree" className="min-h-0 flex-1 overflow-auto py-1" onPointerLeave={() => onHover(null)}>
        {rows.map(({ node, depth }) => {
          const I = layerIcon(node.tag)
          const isSel = node.id === selected
          const indicator = drop?.target === node.id ? drop.zone : null
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-selected={isSel}
              aria-level={depth + 1}
              aria-label={`${node.tag} ${nodeLabel(node)}`}
              data-layer-id={node.id}
              onPointerEnter={() => onHover(node.id)}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                onSelect(node.id)
                if (readOnly || node.id === tree.root) return
                e.currentTarget.setPointerCapture(e.pointerId)
                drag.current = { id: node.id, y: e.clientY, active: false, drop: null }
              }}
              onPointerMove={(e) => {
                const d = drag.current
                if (!d) return
                if (!d.active && Math.abs(e.clientY - d.y) < 4) return
                d.active = true
                // Captured: find the row under the pointer by position, not by event target.
                const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-layer-id]") ?? null
                d.drop = dropAt(d.id, under, e.clientY)
                setDrop(d.drop)
              }}
              onPointerUp={() => {
                const d = drag.current
                drag.current = null
                setDrop(null)
                if (d?.active && d.drop) commitDrop(d.id, d.drop)
              }}
              onPointerCancel={() => {
                drag.current = null
                setDrop(null)
              }}
              className={`relative flex h-7 cursor-default items-center gap-1 pr-2 ${isSel ? "bg-accent/15 text-text" : "hover:bg-hover"} ${indicator === "inside" ? "ring-2 ring-accent ring-inset" : ""}`}
              style={{ paddingLeft: 6 + depth * 12 }}
            >
              {indicator === "before" && <span className="absolute -top-px right-1 left-1 h-0.5 bg-accent" />}
              {indicator === "after" && <span className="absolute right-1 -bottom-px left-1 h-0.5 bg-accent" />}
              {node.children.length ? (
                <button
                  type="button"
                  aria-label={collapsed.has(node.id) ? "Expand" : "Collapse"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setCollapsed((c) => (c.has(node.id) ? new Set([...c].filter((x) => x !== node.id)) : new Set([...c, node.id])))}
                  className="grid size-4 shrink-0 place-items-center rounded text-faint hover:text-text"
                >
                  {collapsed.has(node.id) ? <CaretRightIcon size={10} weight="bold" /> : <CaretDownIcon size={10} weight="bold" />}
                </button>
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <I size={13} className={`shrink-0 ${isSel ? "text-accent" : "text-muted"}`} />
              <span className="truncate">{node.text || node.tag === "img" ? nodeLabel(node) : node.tag}</span>
              {node.text !== undefined && <span className="ml-auto shrink-0 text-[10px] text-faint">{node.tag}</span>}
            </div>
          )
        })}
      </div>
      <div className="border-t border-border px-2 py-1.5 text-[11px] text-faint">{readOnly ? "View only" : "Drag to reorder · Esc goes up a level"}</div>
    </Panel>
  )
}

function PanelButton({ label, icon: I, onClick, disabled }: { label: string; icon: Icon; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <I size={13} />
    </button>
  )
}

// --- Inspector -------------------------------------------------------------------------

type Commit = (value: string) => void

/** Done with a field: give the keyboard back to the canvas, so Esc, Delete and the other layer keys work again. */
const backToCanvas = (el: HTMLElement) => {
  el.blur()
  el.closest<HTMLElement>('[aria-label="Board canvas"]')?.focus()
}

/**
 * A text field that commits on Enter or blur and reverts on Escape. It follows
 * remote changes while it isn't being edited, and refuses values the
 * allowlists would reject (shown in red, with the reason as a tooltip).
 */
function Field({
  label,
  value,
  onCommit,
  readOnly,
  validate,
  placeholder,
  wide,
}: {
  label: string
  value: string
  onCommit: Commit
  readOnly: boolean
  validate?: (v: string) => string | undefined
  placeholder?: string
  wide?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  const error = draft.trim() && validate ? validate(draft.trim()) : undefined
  const commit = () => {
    if (error || draft.trim() === value) return
    onCommit(draft.trim())
  }
  return (
    <label className={`flex min-w-0 flex-col gap-0.5 ${wide ? "col-span-2" : ""}`}>
      <span className="text-[11px] text-muted">{label}</span>
      <input
        aria-label={label}
        value={draft}
        readOnly={readOnly}
        placeholder={placeholder}
        title={error}
        aria-invalid={!!error}
        spellCheck={false}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false
          commit()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          const el = e.currentTarget
          if (e.key === "Enter") {
            commit()
            backToCanvas(el)
          } else if (e.key === "Escape") {
            setDraft(value)
            // Leave after the reset lands, so the blur doesn't commit the stale draft.
            queueMicrotask(() => backToCanvas(el))
          }
        }}
        className={`h-7 min-w-0 rounded-md border bg-bg px-1.5 text-[12px] outline-none read-only:bg-surface read-only:text-muted ${error ? "border-danger" : "border-border focus:border-accent"}`}
      />
    </label>
  )
}

function Choice({ label, value, options, onChange, readOnly, wide }: { label: string; value: string; options: ReadonlyArray<string>; onChange: Commit; readOnly: boolean; wide?: boolean }) {
  const all = value && !options.includes(value) ? [value, ...options] : options
  return (
    <label className={`flex min-w-0 flex-col gap-0.5 ${wide ? "col-span-2" : ""}`}>
      <span className="text-[11px] text-muted">{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 min-w-0 rounded-md border border-border bg-bg px-1 text-[12px] outline-none focus:border-accent disabled:bg-surface disabled:text-muted"
      >
        <option value="">—</option>
        {all.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

function Segmented({
  label,
  value,
  options,
  onChange,
  readOnly,
}: {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string; icon?: Icon }>
  onChange: Commit
  readOnly: boolean
}) {
  return (
    <div className="col-span-2 flex flex-col gap-0.5">
      <span className="text-[11px] text-muted">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex rounded-md border border-border bg-surface p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.label}
            title={o.label}
            disabled={readOnly}
            // A second click on the current value clears it, back to the default.
            onClick={() => onChange(value === o.value ? "" : o.value)}
            className={`flex h-6 flex-1 items-center justify-center rounded text-[11px] ${value === o.value ? "bg-bg text-text shadow-sm" : "text-muted enabled:hover:text-text"}`}
          >
            {o.icon ? <o.icon size={13} /> : o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A color swatch (for hex colors) next to a free-form value field (for anything else: rgb(), gradients, names). */
function ColorField({ label, value, onCommit, readOnly }: { label: string; value: string; onCommit: Commit; readOnly: boolean }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : /^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : undefined
  return (
    <div className="col-span-2 flex items-end gap-1.5">
      <input
        type="color"
        aria-label={`${label} swatch`}
        value={hex ?? "#ffffff"}
        disabled={readOnly}
        onChange={(e) => onCommit(e.target.value)}
        className="h-7 w-8 shrink-0 cursor-pointer rounded-md border border-border bg-bg p-0.5 disabled:cursor-default"
        style={hex ? undefined : { background: value ? "repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/8px 8px" : undefined }}
      />
      <div className="min-w-0 flex-1">
        <Field label={label} value={value} onCommit={onCommit} readOnly={readOnly} validate={(v) => styleError(label === "Text color" ? "color" : "background", v)} />
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-2.5">
      <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">{children}</div>
    </section>
  )
}

const containerTags = designTags.filter((t) => !isVoidTag(t))
const weights = ["300", "400", "500", "600", "700", "800"]

export function DesignInspector({
  node,
  readOnly,
  onPatch,
  onClose,
  position,
  layout,
}: {
  node: DesignNode
  readOnly: boolean
  onPatch: (patch: DesignNodePatch) => void
  onClose: () => void
  /** This layer: in its parent's auto layout, or placed freely (Figma's "absolute position"). Not for the frame's root. */
  position?: { free: boolean; onChange: (free: boolean) => void }
  /** This container's children: auto layout, or all placed freely (a frame without auto layout). */
  layout?: { free: boolean; onChange: (free: boolean) => void }
}) {
  const s = node.style ?? {}
  const get = (p: string) => s[p] ?? ""
  const set = (prop: string) => (v: string) => onPatch({ style: { [prop]: v || null } })
  const check = (prop: string) => (v: string) => styleError(prop, v)
  const field = (label: string, prop: string, extra: { wide?: boolean; placeholder?: string } = {}) => (
    <Field label={label} value={get(prop)} onCommit={set(prop)} readOnly={readOnly} validate={check(prop)} {...extra} />
  )
  const choice = (label: string, prop: string, options: ReadonlyArray<string>, wide = false) => (
    <Choice label={label} value={get(prop)} options={options} onChange={set(prop)} readOnly={readOnly} wide={wide} />
  )
  const isVoid = isVoidTag(node.tag)
  // A button's type changes nothing visible on the canvas, so it only shows once set (e.g. by pasted HTML).
  const attrs = designAttrsFor(node.tag).filter((a) => !(node.tag === "button" && a === "type" && node.attrs?.type === undefined))
  const leaf = !isVoid && node.children.length === 0
  const display = get("display")
  // A layer's fill may be written either way; the inspector edits `background` and clears the other.
  const fill = s.background ?? s["background-color"] ?? ""
  const setFill = (v: string) => onPatch({ style: { background: v || null, ...(s["background-color"] !== undefined && { "background-color": null }) } })

  return (
    <Panel side="right" label="Inspector">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        {isVoid || readOnly ? (
          <span className="font-semibold">&lt;{node.tag}&gt;</span>
        ) : (
          <select
            aria-label="Tag"
            value={node.tag}
            onChange={(e) => {
              const tag = containerTags.find((t) => t === e.target.value)
              if (tag) onPatch({ tag })
            }}
            className="h-6 rounded border border-border bg-bg px-1 font-semibold outline-none"
          >
            {containerTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        <span className="truncate font-mono text-[10px] text-faint" title="Layer id">
          {node.id}
        </span>
        <button type="button" aria-label="Close inspector" title="Close" onClick={onClose} className="ml-auto grid size-6 place-items-center rounded text-muted hover:bg-hover hover:text-text">
          <XIcon size={13} />
        </button>
      </div>
      {/* Typing here must not trigger canvas shortcuts (Delete, tool keys, arrows). */}
      <div key={node.id} className="min-h-0 flex-1 overflow-auto select-text" onKeyDown={(e) => e.stopPropagation()}>
        {leaf && (
          <section className="border-b border-border px-3 py-2.5">
            <TextContent value={node.text ?? ""} readOnly={readOnly} onCommit={(text) => onPatch({ text: text || null })} />
          </section>
        )}
        {attrs.length > 0 && (
          <Section title="Attributes">
            {attrs.map((a) => (
              <Field
                key={a}
                label={a}
                value={node.attrs?.[a] ?? ""}
                wide={a === "src" || a === "href"}
                readOnly={readOnly}
                validate={(v) => attrError(node.tag, a, v)}
                onCommit={(v) => onPatch({ attrs: { [a]: v || null } })}
              />
            ))}
          </Section>
        )}
        {position && (
          <Section title="Position">
            <Segmented
              label="Place"
              value={position.free ? "free" : "auto"}
              readOnly={readOnly}
              onChange={(v) => position.onChange(v === "free")}
              options={[
                { value: "auto", label: "Auto layout" },
                { value: "free", label: "Free" },
              ]}
            />
            {position.free && (
              <>
                {field("X", "left", { placeholder: "0px" })}
                {field("Y", "top", { placeholder: "0px" })}
                {field("Z", "z-index", { placeholder: "auto" })}
              </>
            )}
          </Section>
        )}
        {!isVoid && (
          <Section title="Layout">
            {layout && (
              <Segmented
                label="Children"
                value={layout.free ? "free" : "auto"}
                readOnly={readOnly}
                onChange={(v) => layout.onChange(v === "free")}
                options={[
                  { value: "auto", label: "Auto layout" },
                  { value: "free", label: "Free" },
                ]}
              />
            )}
            <Segmented
              label="Display"
              value={display}
              readOnly={readOnly}
              onChange={set("display")}
              options={[
                { value: "block", label: "Block" },
                { value: "flex", label: "Flex" },
                { value: "grid", label: "Grid" },
                { value: "none", label: "Hidden" },
              ]}
            />
            {/* With every child placed freely, the container's flow settings do nothing. */}
            {!layout?.free && (display === "flex" || display === "inline-flex") && (
              <>
                <Segmented
                  label="Direction"
                  value={get("flex-direction")}
                  readOnly={readOnly}
                  onChange={set("flex-direction")}
                  options={[
                    { value: "row", label: "Row" },
                    { value: "column", label: "Column" },
                  ]}
                />
                {choice("Wrap", "flex-wrap", ["nowrap", "wrap"])}
              </>
            )}
            {!layout?.free && (display === "grid" || display === "inline-grid") && field("Columns", "grid-template-columns", { wide: true, placeholder: "repeat(3, 1fr)" })}
            {!layout?.free && (display.includes("flex") || display.includes("grid")) ? (
              <>
                {choice("Align", "align-items", ["stretch", "flex-start", "center", "flex-end", "baseline"])}
                {choice("Justify", "justify-content", ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"])}
                {field("Gap", "gap", { placeholder: "8px" })}
              </>
            ) : null}
            {field("Padding", "padding", { placeholder: "0" })}
            {field("Margin", "margin", { placeholder: "0" })}
          </Section>
        )}
        <Section title="Size">
          {field("Width", "width", { placeholder: "auto" })}
          {field("Height", "height", { placeholder: "auto" })}
          {field("Min width", "min-width")}
          {field("Max width", "max-width")}
          {node.tag === "img" && choice("Fit", "object-fit", ["fill", "contain", "cover", "none"], true)}
        </Section>
        <Section title="Fill">
          <ColorField label="Background" value={fill} onCommit={setFill} readOnly={readOnly} />
          {field("Opacity", "opacity", { placeholder: "1" })}
        </Section>
        <Section title="Border">
          {field("Radius", "border-radius", { placeholder: "0" })}
          {field("Border", "border", { placeholder: "1px solid #ddd" })}
          {field("Shadow", "box-shadow", { wide: true, placeholder: "0 4px 12px rgb(0 0 0 / 0.1)" })}
        </Section>
        {node.tag !== "img" && node.tag !== "hr" && (
          <Section title="Text">
            <ColorField label="Text color" value={get("color")} onCommit={set("color")} readOnly={readOnly} />
            {field("Size", "font-size", { placeholder: "14px" })}
            {choice("Weight", "font-weight", weights)}
            {choice("Font", "font-family", designFonts, true)}
            {field("Line height", "line-height", { placeholder: "1.45" })}
            {field("Letter spacing", "letter-spacing", { placeholder: "0" })}
            <Segmented
              label="Align text"
              value={get("text-align")}
              readOnly={readOnly}
              onChange={set("text-align")}
              options={[
                { value: "left", label: "Left", icon: TextAlignLeftIcon },
                { value: "center", label: "Center", icon: TextAlignCenterIcon },
                { value: "right", label: "Right", icon: TextAlignRightIcon },
                { value: "justify", label: "Justify", icon: TextAlignJustifyIcon },
              ]}
            />
            {choice("Case", "text-transform", ["none", "uppercase", "lowercase", "capitalize"])}
            {field("Decoration", "text-decoration", { placeholder: "none" })}
          </Section>
        )}
        <CssSection node={node} readOnly={readOnly} onPatch={onPatch} />
      </div>
    </Panel>
  )
}

function TextContent({ value, readOnly, onCommit }: { value: string; readOnly: boolean; onCommit: Commit }) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Text</span>
      <textarea
        aria-label="Text content"
        value={draft}
        readOnly={readOnly}
        rows={3}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false
          if (draft !== value) onCommit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
        }}
        className="resize-y rounded-md border border-border bg-bg px-1.5 py-1 text-[12px] leading-snug outline-none read-only:bg-surface read-only:text-muted focus:border-accent"
      />
    </label>
  )
}

/** Every declaration as CSS text, for anything the fields above don't cover. Saving sends only what changed. */
function CssSection({ node, readOnly, onPatch }: { node: DesignNode; readOnly: boolean; onPatch: (patch: DesignNodePatch) => void }) {
  const text = Object.entries(node.style ?? {})
    .map(([k, v]) => `${k}: ${v};`)
    .join("\n")
  const [draft, setDraft] = useState(text)
  const [error, setError] = useState<string | null>(null)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(text)
  }, [text])
  const save = () => {
    const next = Object.fromEntries(parseStyle(draft).map(([k, v]) => [k.toLowerCase(), v.replace(/\s+/g, " ")]))
    for (const [k, v] of Object.entries(next)) {
      const e = styleError(k, v)
      if (e) return setError(e)
    }
    setError(null)
    const patch: Record<string, string | null> = {}
    for (const k of Object.keys(node.style ?? {})) if (!(k in next)) patch[k] = null
    for (const [k, v] of Object.entries(next)) if (node.style?.[k] !== v) patch[k] = v
    if (Object.keys(patch).length) onPatch({ style: patch })
  }
  return (
    <section className="px-3 py-2.5">
      <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">CSS</h3>
      <textarea
        aria-label="CSS"
        value={draft}
        readOnly={readOnly}
        spellCheck={false}
        rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false
          if (!readOnly && draft !== text) save()
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
        }}
        className={`w-full resize-y rounded-md border bg-surface p-1.5 font-mono text-[11px] leading-[1.5] outline-none ${error ? "border-danger" : "border-border focus:border-accent"}`}
      />
      {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
    </section>
  )
}
