/**
 * Design frames: a board shape whose content is a tree of HTML elements with
 * inline CSS, rendered as real DOM inside the app (no iframe), like Paper or
 * Figma where the layer tree *is* the DOM tree.
 *
 * Because nodes render in the app's own document, the tag, style and attribute
 * allowlists below ARE the security boundary: no scripts or event handlers can
 * be expressed at all, URLs are limited to https (and data: images), and CSS
 * can't escape the frame (no `position: fixed`) or pull in anything but https
 * and data images (no `@import`, `var()`, `expression()`, escapes or comments).
 * HTML coming in may use more than that (custom properties, `<svg>` icons,
 * `::before`): `htmlToDesign` settles those into plain values, images and
 * layers, so what's stored still only says what the allowlists allow.
 *
 * Everything here is plain TypeScript with no imports, so the same rules run in
 * the browser (optimistic ops, rendering), the cell (authoritative ops), the CLI,
 * MCP, and Node tests.
 *
 * Model: a flat map of nodes keyed by id, plus the root id. A node has either
 * `text` or `children`, never both: mixed content (`Read the <a>docs</a>.`)
 * becomes bare `span` text runs, which serialize back to plain text.
 */

export const designTags = [
  "div", "section", "header", "footer", "nav", "main", "article", "aside",
  "span", "p", "h1", "h2", "h3", "h4", "strong", "em", "small",
  "a", "button", "img", "input", "label", "ul", "ol", "li", "hr",
] as const
export type DesignTag = (typeof designTags)[number]

export interface DesignNode {
  readonly id: string
  readonly tag: DesignTag
  readonly text?: string
  readonly attrs?: { readonly [name: string]: string }
  readonly style?: { readonly [prop: string]: string }
  readonly children: ReadonlyArray<string>
}

export interface DesignTree {
  readonly root: string
  readonly nodes: { readonly [id: string]: DesignNode }
}

/** Per-property merge: `null` removes a property (or the text), a string sets it. */
export interface DesignNodePatch {
  readonly tag?: DesignTag
  readonly text?: string | null
  readonly style?: { readonly [prop: string]: string | null }
  readonly attrs?: { readonly [name: string]: string | null }
}

export type DesignResult = { ok: true; tree: DesignTree } | { ok: false; error: string }

/** JSON size cap per frame. A shape is one SQLite row (2 MB max) and every replace is also an op in the log. */
export const maxDesignSize = 200_000
export const maxDesignNodes = 3000
export const maxDesignDepth = 48
const maxText = 10_000
/** Values are short, except image URLs, which may be data: URIs. */
const maxValue = 2_000
const maxUrlValue = 150_000

const voidTags: ReadonlySet<DesignTag> = new Set(["img", "input", "hr"])
export const isVoidTag = (tag: DesignTag) => voidTags.has(tag)
const tagSet: ReadonlySet<string> = new Set(designTags)
export const isDesignTag = (tag: string): tag is DesignTag => tagSet.has(tag)

const idPattern = /^[\w-]{1,64}$/

// --- CSS values ---------------------------------------------------------------------

type Check = (value: string) => boolean

const keywords = (...words: Array<string>): Check => {
  const set = new Set(words)
  return (v) => set.has(v.toLowerCase())
}

/** Functions a value may call. Notably absent: url (handled separately), var, env, attr, expression, image-set, element. */
const functions = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color-mix",
  "calc", "min", "max", "clamp", "minmax", "repeat", "fit-content",
  "linear-gradient", "radial-gradient", "conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
  // Transforms and clip shapes. A frame clips its own painting (`contain: paint`), so neither can reach outside it.
  "translate", "translatex", "translatey", "scale", "scalex", "scaley", "rotate", "skew", "skewx", "skewy", "matrix",
  "polygon", "circle", "ellipse", "inset",
])

const httpsUrl = /^https:\/\/[^\s"'()\\<>]+$/i
/** data: images only. SVG must be base64 or percent-encoded (no raw markup); images can't run scripts either way. */
const dataImage = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|svg\+xml)(?:;[\w=-]+)*(?:;base64)?,[\w+/=%.~:;,!*'-]*$/i
export const isImageUrl = (url: string) => url.length <= maxUrlValue && (httpsUrl.test(url) || dataImage.test(url))

/**
 * Whether a value is plain CSS: allowlisted functions, no escapes, comments,
 * at-rules, braces, semicolons or `!important`, and url() only where `urls`
 * allows it (https or data images).
 */
function plainValue(value: string, urls: boolean): boolean {
  if (!value || value.length > (urls ? maxUrlValue : maxValue)) return false
  let rest = value
  if (urls) {
    let bad = false
    rest = value.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (_, _q, url: string) => {
      if (!isImageUrl(url.trim())) bad = true
      return " imageurl "
    })
    if (bad) return false
  }
  // Control characters, escapes, comments, statements, blocks, at-rules, markup.
  if (/[\u0000-\u001f\u007f\\;{}<>@!`]|\/\*/.test(rest)) return false
  // Any function call left (including a url() that didn't match the safe form above) must be allowlisted.
  for (const m of rest.matchAll(/(-?[a-z][a-z0-9-]*)\s*\(/gi)) if (!functions.has(m[1]!.toLowerCase())) return false
  return true
}

const value: Check = (v) => plainValue(v, false)
const withUrls: Check = (v) => plainValue(v, true)

/** Families that render the same everywhere without loading anything. */
export const designFonts = [
  "system-ui", "-apple-system", "ui-sans-serif", "ui-serif", "ui-monospace", "sans-serif", "serif", "monospace", "cursive",
  "Inter", "Helvetica", "Helvetica Neue", "Arial", "Segoe UI", "Roboto", "Georgia", "Times New Roman", "Courier New", "Menlo", "Monaco", "SF Pro Text", "SF Mono",
] as const
const fontSet = new Map(designFonts.map((f) => [f.toLowerCase(), f]))
const families = (v: string) => v.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase())
const fontFamily: Check = (v) => v.length <= 300 && families(v).every((f) => fontSet.has(f))

const align = keywords("normal", "stretch", "start", "end", "center", "flex-start", "flex-end", "self-start", "self-end", "baseline", "first baseline", "last baseline", "auto")
const justify = keywords("normal", "start", "end", "center", "flex-start", "flex-end", "left", "right", "space-between", "space-around", "space-evenly", "stretch")
const overflow = keywords("visible", "hidden", "clip", "auto", "scroll")
const radius = value
const backgroundClip = keywords("border-box", "padding-box", "content-box", "text")

/** Allowed CSS properties and how their values are checked. */
const styleRules: Readonly<Record<string, Check>> = {
  // Layout
  display: keywords("block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none", "contents", "flow-root"),
  "flex-direction": keywords("row", "row-reverse", "column", "column-reverse"),
  "flex-wrap": keywords("nowrap", "wrap", "wrap-reverse"),
  "align-items": align,
  "align-self": align,
  "align-content": justify,
  "justify-content": justify,
  "justify-items": align,
  "justify-self": align,
  "place-items": value,
  "place-content": value,
  gap: value,
  "row-gap": value,
  "column-gap": value,
  "grid-template-columns": value,
  "grid-template-rows": value,
  "grid-column": value,
  "grid-row": value,
  "grid-auto-flow": keywords("row", "column", "dense", "row dense", "column dense"),
  flex: value,
  "flex-grow": value,
  "flex-shrink": value,
  "flex-basis": value,
  order: value,
  padding: value,
  "padding-top": value,
  "padding-right": value,
  "padding-bottom": value,
  "padding-left": value,
  margin: value,
  "margin-top": value,
  "margin-right": value,
  "margin-bottom": value,
  "margin-left": value,
  // `fixed` is the one that escapes a frame; the frame is also a containing block (`contain: layout`) for absolute children.
  position: keywords("static", "relative", "absolute", "sticky"),
  top: value,
  right: value,
  bottom: value,
  left: value,
  inset: value,
  "z-index": (v) => /^-?\d{1,4}$/.test(v),
  overflow,
  "overflow-x": overflow,
  "overflow-y": overflow,
  "box-sizing": keywords("border-box", "content-box"),
  // Size
  width: value,
  height: value,
  "min-width": value,
  "min-height": value,
  "max-width": value,
  "max-height": value,
  "aspect-ratio": value,
  "object-fit": keywords("fill", "contain", "cover", "none", "scale-down"),
  "object-position": value,
  transform: value,
  "transform-origin": value,
  // Fill
  background: withUrls,
  "background-color": value,
  "background-image": withUrls,
  "background-size": value,
  "background-position": value,
  "background-repeat": value,
  "background-clip": backgroundClip,
  "-webkit-background-clip": backgroundClip,
  opacity: value,
  // Shape: what of the box shows. Masks take the same images backgrounds do.
  "clip-path": value,
  mask: withUrls,
  "-webkit-mask": withUrls,
  "mask-image": withUrls,
  "-webkit-mask-image": withUrls,
  "mask-size": value,
  "-webkit-mask-size": value,
  "mask-position": value,
  "-webkit-mask-position": value,
  "mask-repeat": value,
  "-webkit-mask-repeat": value,
  "mask-composite": value,
  "-webkit-mask-composite": value,
  // Border
  border: value,
  "border-top": value,
  "border-right": value,
  "border-bottom": value,
  "border-left": value,
  "border-width": value,
  "border-style": value,
  "border-color": value,
  ...Object.fromEntries(["top", "right", "bottom", "left"].flatMap((side) => ["width", "style", "color"].map((part) => [`border-${side}-${part}`, value] as const))),
  outline: value,
  "outline-offset": value,
  "border-radius": radius,
  "border-top-left-radius": radius,
  "border-top-right-radius": radius,
  "border-bottom-right-radius": radius,
  "border-bottom-left-radius": radius,
  "box-shadow": value,
  // Type
  color: value,
  "font-size": value,
  "font-weight": value,
  "font-style": keywords("normal", "italic", "oblique"),
  "font-family": fontFamily,
  "line-height": value,
  "letter-spacing": value,
  "text-align": keywords("left", "right", "center", "justify", "start", "end"),
  "text-transform": keywords("none", "uppercase", "lowercase", "capitalize"),
  "text-decoration": value,
  "white-space": keywords("normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"),
  "word-break": keywords("normal", "break-all", "keep-all", "break-word"),
  "text-overflow": keywords("clip", "ellipsis"),
  "font-variant-numeric": value,
  "font-feature-settings": value,
  "vertical-align": value,
  "list-style": keywords("none", "disc", "circle", "square", "decimal", "inside", "outside", "disc inside", "decimal inside"),
}

export const designStyleProps: ReadonlyArray<string> = Object.keys(styleRules)

/** Why `prop: value` isn't allowed, or undefined if it is. */
export function styleError(prop: string, v: string): string | undefined {
  const check = Object.hasOwn(styleRules, prop) ? styleRules[prop] : undefined
  if (!check) return `CSS property "${prop}" is not allowed`
  if (!check(v.trim())) return `"${prop}: ${v.slice(0, 80)}" is not allowed`
  return undefined
}

/**
 * Tolerant cleanup for input from outside (pasted HTML, `style=""`): lowercases
 * names, trims values, drops `!important`, keeps the safe font families of a
 * stack, and silently drops everything else that isn't allowed.
 */
export function cleanStyle(entries: Iterable<readonly [string, string]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawProp, rawValue] of entries) {
    const prop = rawProp.trim().toLowerCase()
    let v = rawValue.replace(/\s+/g, " ").trim().replace(/\s*!\s*important$/i, "")
    if (prop === "font-family") {
      const safe = v.split(",").map((f) => fontSet.get(f.trim().replace(/^["']|["']$/g, "").toLowerCase())).filter((f) => f !== undefined)
      if (!safe.length) continue
      v = safe.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(", ")
    }
    if (!styleError(prop, v)) out[prop] = v
  }
  return out
}

/** Split `a: b; c: url(data:…;base64,…)` into declarations, respecting quotes and parentheses. */
export function parseStyle(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let depth = 0
  let quote = ""
  let start = 0
  const push = (decl: string) => {
    const at = decl.indexOf(":")
    if (at > 0) out.push([decl.slice(0, at).trim(), decl.slice(at + 1).trim()])
  }
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!
    if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") quote = c
    else if (c === "(") depth++
    else if (c === ")") depth = Math.max(0, depth - 1)
    else if (c === ";" && depth === 0) {
      push(css.slice(start, i))
      start = i + 1
    }
  }
  push(css.slice(start))
  return out
}

// --- Attributes ---------------------------------------------------------------------

const plainText: Check = (v) => v.length <= 500 && !/[\u0000-\u001f\u007f]/.test(v)
const attrRules: Readonly<Record<string, { tags: ReadonlyArray<DesignTag>; check: Check }>> = {
  src: { tags: ["img"], check: isImageUrl },
  href: { tags: ["a"], check: (v) => v.length <= maxValue && /^(?:https:\/\/[^\s"'<>\\]+|mailto:[^\s"'<>\\]+|#[\w-]*)$/i.test(v) },
  alt: { tags: ["img"], check: plainText },
  placeholder: { tags: ["input"], check: plainText },
  type: { tags: ["input", "button"], check: keywords("text", "email", "number", "search", "tel", "url", "password", "date", "checkbox", "radio", "button", "submit", "reset") },
}

/** Which attributes a tag may carry (for inspectors and agents). */
export const designAttrsFor = (tag: DesignTag) => Object.keys(attrRules).filter((a) => attrRules[a]!.tags.includes(tag))

export function attrError(tag: DesignTag, name: string, v: string): string | undefined {
  const rule = Object.hasOwn(attrRules, name) ? attrRules[name] : undefined
  if (!rule || !rule.tags.includes(tag)) return `Attribute "${name}" is not allowed on <${tag}>`
  if (!rule.check(v)) return `"${name}" value is not allowed on <${tag}>${name === "src" || name === "href" ? " (https, data images, mailto: or #anchors only)" : ""}`
  return undefined
}

// --- Validation ---------------------------------------------------------------------

/** Why a node is invalid on its own (tag, text, style, attrs), or undefined. */
export function designNodeError(node: DesignNode): string | undefined {
  if (!idPattern.test(node.id)) return `Bad node id "${node.id}"`
  if (!isDesignTag(node.tag)) return `Tag <${String(node.tag)}> is not allowed`
  if (node.text !== undefined) {
    if (node.text.length > maxText) return `Text of ${node.id} is too long`
    if (isVoidTag(node.tag)) return `<${node.tag}> can't have text`
    if (node.children.length) return `Node ${node.id} has both text and children; wrap the text in a span`
  }
  if (isVoidTag(node.tag) && node.children.length) return `<${node.tag}> can't have children`
  for (const [p, v] of Object.entries(node.style ?? {})) {
    if (typeof v !== "string") return `Style ${p} must be a string`
    const e = styleError(p, v)
    if (e) return e
  }
  for (const [a, v] of Object.entries(node.attrs ?? {})) {
    if (typeof v !== "string") return `Attribute ${a} must be a string`
    const e = attrError(node.tag, a, v)
    if (e) return e
  }
  return undefined
}

/**
 * Why a tree is invalid, or undefined: every node valid, keyed by its id,
 * reachable from the root exactly once (so no cycles, orphans or shared
 * children), within the depth, node and size caps.
 */
export function designTreeError(tree: DesignTree): string | undefined {
  const ids = Object.keys(tree.nodes)
  if (ids.length > maxDesignNodes) return `A design can have at most ${maxDesignNodes} nodes`
  if (!Object.hasOwn(tree.nodes, tree.root)) return "The root node is missing"
  for (const id of ids) {
    const node = tree.nodes[id]!
    if (node.id !== id) return `Node key ${id} doesn't match its id ${node.id}`
    const e = designNodeError(node)
    if (e) return e
  }
  const seen = new Set<string>()
  const stack: Array<[string, number]> = [[tree.root, 0]]
  while (stack.length) {
    const [id, depth] = stack.pop()!
    if (seen.has(id)) return `Node ${id} appears more than once`
    if (depth > maxDesignDepth) return `A design can be at most ${maxDesignDepth} levels deep`
    seen.add(id)
    const node = tree.nodes[id]
    if (!node) return `Unknown child ${id}`
    for (const c of node.children) stack.push([c, depth + 1])
  }
  if (seen.size !== ids.length) return "Every node must be inside the root"
  if (JSON.stringify(tree).length > maxDesignSize) return `A design can be at most ${maxDesignSize.toLocaleString("en-US")} characters of JSON`
  return undefined
}

// --- Fine-grained edits ---------------------------------------------------------------
// Each changes only the nodes it names, so two people editing different layers
// (or different properties of one layer) both keep their changes.

const fail = (error: string): DesignResult => ({ ok: false, error })
const sizeOk = (tree: DesignTree): DesignResult =>
  JSON.stringify(tree).length > maxDesignSize ? fail(`A design can be at most ${maxDesignSize.toLocaleString("en-US")} characters of JSON`) : { ok: true, tree }

export function parentOf(tree: DesignTree, id: string): string | undefined {
  for (const n of Object.values(tree.nodes)) if (n.children.includes(id)) return n.id
  return undefined
}

/** The node and everything below it, depth-first in document order. */
export function subtreeIds(tree: DesignTree, id: string): Array<string> {
  const out: Array<string> = []
  const walk = (n: string, depth: number) => {
    const node = tree.nodes[n]
    if (!node || depth > maxDesignDepth + 1) return
    out.push(n)
    for (const c of node.children) walk(c, depth + 1)
  }
  walk(id, 0)
  return out
}

export function patchDesignNode(tree: DesignTree, id: string, patch: DesignNodePatch): DesignResult {
  const node = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined
  if (!node) return fail(`Unknown node ${id}`)
  const merge = (base: { readonly [k: string]: string } | undefined, p: { readonly [k: string]: string | null } | undefined) => {
    if (!p) return base
    const next: Record<string, string> = { ...base }
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete next[k]
      else next[k] = v
    }
    return Object.keys(next).length ? next : undefined
  }
  const style = merge(node.style, patch.style)
  const attrs = merge(node.attrs, patch.attrs)
  const text = patch.text === null ? undefined : (patch.text ?? node.text)
  const next: DesignNode = {
    id,
    tag: patch.tag ?? node.tag,
    ...(text !== undefined && { text }),
    ...(attrs && { attrs }),
    ...(style && { style }),
    children: node.children,
  }
  // Only the touched node is re-validated, so a design stored under older rules stays editable.
  const e = designNodeError(next)
  if (e) return fail(e)
  return sizeOk({ root: tree.root, nodes: { ...tree.nodes, [id]: next } })
}

/** Insert a subtree (`root` plus all its descendants in `nodes`) into `parent` at `index` (default: last). */
export function insertDesignNodes(tree: DesignTree, parent: string, index: number | undefined, root: string, nodes: ReadonlyArray<DesignNode>): DesignResult {
  const p = Object.hasOwn(tree.nodes, parent) ? tree.nodes[parent] : undefined
  if (!p) return fail(`Unknown parent ${parent}`)
  if (isVoidTag(p.tag) || p.text !== undefined) return fail(`<${p.tag}> ${p.id} can't contain other nodes${p.text !== undefined ? " (it has text)" : ""}`)
  const added: Record<string, DesignNode> = {}
  for (const n of nodes) {
    if (Object.hasOwn(tree.nodes, n.id) || Object.hasOwn(added, n.id)) return fail(`Node ${n.id} already exists`)
    added[n.id] = n
  }
  const sub: DesignTree = { root, nodes: added }
  const e = designTreeError(sub)
  if (e) return fail(e)
  const at = clampIndex(index, p.children.length)
  const children = [...p.children.slice(0, at), root, ...p.children.slice(at)]
  const next: DesignTree = { root: tree.root, nodes: { ...tree.nodes, ...added, [parent]: { ...p, children } } }
  if (Object.keys(next.nodes).length > maxDesignNodes) return fail(`A design can have at most ${maxDesignNodes} nodes`)
  if (depthOf(next, parent) + depthBelow(sub, root) > maxDesignDepth) return fail(`A design can be at most ${maxDesignDepth} levels deep`)
  return sizeOk(next)
}

/** Remove nodes and everything inside them. The root can't be removed (remove the shape instead). */
export function removeDesignNodes(tree: DesignTree, ids: ReadonlyArray<string>): DesignResult {
  if (ids.includes(tree.root)) return fail("The root node can't be removed")
  const drop = new Set<string>()
  for (const id of ids) {
    if (!Object.hasOwn(tree.nodes, id)) continue
    for (const d of subtreeIds(tree, id)) drop.add(d)
  }
  // Someone else may have removed them already; that's the outcome the op wanted.
  if (!drop.size) return { ok: true, tree }
  const nodes: Record<string, DesignNode> = {}
  for (const [id, n] of Object.entries(tree.nodes)) {
    if (drop.has(id)) continue
    nodes[id] = n.children.some((c) => drop.has(c)) ? { ...n, children: n.children.filter((c) => !drop.has(c)) } : n
  }
  return { ok: true, tree: { root: tree.root, nodes } }
}

/** Move a node under `parent`; `index` counts the parent's children without the moved node. */
export function moveDesignNode(tree: DesignTree, id: string, parent: string, index: number | undefined): DesignResult {
  if (id === tree.root) return fail("The root node can't be moved")
  const node = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined
  const p = Object.hasOwn(tree.nodes, parent) ? tree.nodes[parent] : undefined
  if (!node) return fail(`Unknown node ${id}`)
  if (!p) return fail(`Unknown parent ${parent}`)
  if (isVoidTag(p.tag) || p.text !== undefined) return fail(`<${p.tag}> ${p.id} can't contain other nodes`)
  if (subtreeIds(tree, id).includes(parent)) return fail("Can't move a node inside itself")
  const from = parentOf(tree, id)
  if (!from) return fail(`Node ${id} has no parent`)
  const nodes: Record<string, DesignNode> = { ...tree.nodes }
  nodes[from] = { ...nodes[from]!, children: nodes[from]!.children.filter((c) => c !== id) }
  const siblings = nodes[parent]!.children
  const at = clampIndex(index, siblings.length)
  nodes[parent] = { ...nodes[parent]!, children: [...siblings.slice(0, at), id, ...siblings.slice(at)] }
  const next = { root: tree.root, nodes }
  if (depthOf(next, id) + depthBelow(next, id) > maxDesignDepth) return fail(`A design can be at most ${maxDesignDepth} levels deep`)
  return { ok: true, tree: next }
}

const clampIndex = (index: number | undefined, length: number) => (index === undefined ? length : Math.max(0, Math.min(length, Math.floor(index))))

function depthOf(tree: DesignTree, id: string): number {
  let d = 0
  for (let at = parentOf(tree, id); at !== undefined && d <= maxDesignDepth + 1; at = parentOf(tree, at)) d++
  return d
}

function depthBelow(tree: DesignTree, id: string, depth = 0): number {
  const node = tree.nodes[id]
  if (!node || depth > maxDesignDepth) return depth
  return node.children.reduce((m, c) => Math.max(m, depthBelow(tree, c, depth + 1) + 1), 0)
}

// --- HTML → nodes ---------------------------------------------------------------------

/** Removed with everything inside them. */
const dropTags = new Set([
  "script", "style", "template", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math",
  "head", "title", "meta", "link", "base", "canvas", "video", "audio", "source", "track", "picture", "textarea", "select", "option", "datalist", "map", "dialog", "portal",
])
/** Their content is raw text up to the closing tag (so `</div>` inside a script doesn't end anything). */
const rawTextTags = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"])
const htmlVoid = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])
/** Opening one of these closes an open <p> (as the HTML parser does). */
const closesP = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul", "figure"])
const inlineTags: ReadonlySet<DesignTag> = new Set(["span", "strong", "em", "small", "a"])
/** Unknown tags that read as headings keep their meaning. */
const tagAliases: Readonly<Record<string, DesignTag>> = { h5: "h4", h6: "h4", b: "strong", i: "em", figure: "div", figcaption: "p", blockquote: "div", pre: "p", form: "div", address: "p" }

type Decl = [string, string]
type RawElement = {
  tag: string
  attrs: Array<[string, string]>
  children: Array<RawNode>
  parent: RawElement | null
  /** Declarations from the <style> rules that match it, least specific first. */
  style: Array<Decl>
  /** The same for its `::before` and `::after`. */
  before?: Array<Decl>
  after?: Array<Decl>
  /** An <svg>'s markup, verbatim: its names are case-sensitive, and the tokenizer lowercases. */
  source?: string
  /** What it ends up with, once custom properties and shorthands are settled (see `settle`). */
  final?: Array<Decl>
  /** Its `white-space`, its own or inherited: decides whether line breaks in its text survive. */
  space?: string
}

/** Stands for a <br> until its element decides what line breaks become. HTML can't contain it. */
const lineBreak = "\u0000"
/** `white-space` values under which a newline in text is a line break. */
const keepsLines = (space: string | undefined) => space === "pre" || space === "pre-wrap" || space === "pre-line" || space === "break-spaces"
type RawNode = RawElement | string

const entities: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•", times: "×", rarr: "→", larr: "←", uarr: "↑", darr: "↓", check: "✓", euro: "€", pound: "£", deg: "°",
}
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m
    }
    return entities[e.toLowerCase()] ?? m
  })
}

/** A small, tolerant tokenizer + tree builder for the subset designs use. Never throws. */
function parseHtml(html: string): { root: RawElement; css: string } {
  const root: RawElement = { tag: "#root", attrs: [], children: [], parent: null, style: [] }
  let open = root
  let css = ""
  let i = 0
  const text = (t: string) => {
    if (t) open.children.push(decode(t))
  }
  const close = (tag: string) => {
    for (let at: RawElement | null = open; at && at !== root; at = at.parent) {
      if (at.tag === tag) {
        open = at.parent ?? root
        return
      }
    }
  }
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt < 0) {
      text(html.slice(i))
      break
    }
    text(html.slice(i, lt))
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt)
      i = end < 0 ? html.length : end + 1
      continue
    }
    const end = /^<\/([a-zA-Z][\w-]*)[^>]*>/.exec(html.slice(lt, lt + 200))
    if (end) {
      close(end[1]!.toLowerCase())
      i = lt + end[0].length
      continue
    }
    const start = /^<([a-zA-Z][\w-]*)/.exec(html.slice(lt, lt + 100))
    if (!start) {
      text("<")
      i = lt + 1
      continue
    }
    const tag = start[1]!.toLowerCase()
    // Attributes: name, name=value, name="value", name='value'.
    const attrs: Array<[string, string]> = []
    let j = lt + start[0].length
    const attr = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?|\s*\/?/y
    for (;;) {
      attr.lastIndex = j
      const m = attr.exec(html)
      if (!m || m[0].length === 0) break
      j = attr.lastIndex
      if (m[1]) attrs.push([m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? "")])
    }
    const gt = html.indexOf(">", j)
    i = gt < 0 ? html.length : gt + 1
    if (rawTextTags.has(tag)) {
      const closeAt = html.toLowerCase().indexOf(`</${tag}`, i)
      const body = html.slice(i, closeAt < 0 ? html.length : closeAt)
      if (tag === "style") css += body + "\n"
      // Raw text of anything else (script, textarea, title…) is dropped along with the element.
      const after = closeAt < 0 ? -1 : html.indexOf(">", closeAt)
      i = after < 0 ? html.length : after + 1
      continue
    }
    if (tag === "svg") {
      // Kept whole, to become an image: nothing inside it is a layer.
      const closeAt = html.slice(lt, i).endsWith("/>") ? -1 : html.toLowerCase().indexOf("</svg", i)
      const after = closeAt < 0 ? -1 : html.indexOf(">", closeAt)
      const stop = html.slice(lt, i).endsWith("/>") ? i : after < 0 ? html.length : after + 1
      open.children.push({ tag, attrs, children: [], parent: open, style: [], source: html.slice(lt, stop) })
      i = stop
      continue
    }
    if (tag === "p" || closesP.has(tag)) {
      // A block opening inside an open <p> closes it, like the real parser.
      if (open.tag === "p") open = open.parent ?? root
    }
    if (tag === "li" && open.tag === "li") open = open.parent ?? root
    const el: RawElement = { tag, attrs, children: [], parent: open, style: [] }
    open.children.push(el)
    if (!htmlVoid.has(tag) && !html.slice(lt, i).endsWith("/>")) open = el
  }
  return { root, css }
}

// --- <style> rules → inline styles ------------------------------------------------------

type AttrTest = { name: string; /** "" tests that the attribute is there. */ op: string; value: string }
type Compound = {
  tag?: string
  id?: string
  classes: Array<string>
  attrs: Array<AttrTest>
  /** Pseudo-classes that depend on where the element sits (`:first-child`), or `:not(…)`. */
  pseudos: Array<{ name: string; arg?: string; not?: Compound }>
}
/** One compound and how it relates to the one before it: a descendant (" "), a child, the next sibling, or a later one. */
type Step = { compound: Compound; combinator: " " | ">" | "+" | "~" }
type Rule = { steps: Array<Step>; pseudo?: "before" | "after"; decls: Array<Decl>; specificity: number; order: number }

const positional = new Set(["first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "nth-child", "nth-last-child", "nth-of-type"])

/** Split on a separator that isn't inside quotes, parentheses or brackets. */
function splitTop(text: string, separator: string): Array<string> {
  const out: Array<string> = []
  let depth = 0
  let quote = ""
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") quote = c
    else if (c === "(" || c === "[") depth++
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1)
    else if (c === separator && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

/** One compound selector starting at `start` (`a.btn[data-size="sm"]:first-child`), or undefined if it uses something a static design can't answer. */
function parseCompound(s: string, start: number): { compound: Compound; end: number; pseudo?: "before" | "after"; weight: number } | undefined {
  const compound: Compound = { classes: [], attrs: [], pseudos: [] }
  let i = start
  let weight = 0
  let pseudo: "before" | "after" | undefined
  const ident = () => {
    const m = /^-?[a-zA-Z_][\w-]*/.exec(s.slice(i, i + 80))
    if (m) i += m[0].length
    return m?.[0]
  }
  if (s[i] === "*") i++
  else {
    const tag = ident()
    if (tag) {
      compound.tag = tag.toLowerCase()
      weight += 1
    }
  }
  for (;;) {
    const c = s[i]
    if (c === "." || c === "#") {
      i++
      const name = ident()
      if (!name) return undefined
      if (c === ".") compound.classes.push(name)
      else compound.id = name
      weight += c === "." ? 100 : 10000
    } else if (c === "[") {
      const m = /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(?:[is]\s*)?)?\]/.exec(s.slice(i))
      if (!m) return undefined
      compound.attrs.push({ name: m[1]!.toLowerCase(), op: m[2] ?? "", value: m[3] ?? m[4] ?? m[5] ?? "" })
      i += m[0].length
      weight += 100
    } else if (c === ":") {
      const element = s[i + 1] === ":"
      i += element ? 2 : 1
      const name = ident()?.toLowerCase()
      if (!name) return undefined
      let arg: string | undefined
      if (s[i] === "(") {
        let depth = 1
        let j = i + 1
        while (j < s.length && depth) {
          if (s[j] === "(") depth++
          else if (s[j] === ")") depth--
          j++
        }
        if (depth) return undefined
        arg = s.slice(i + 1, j - 1).trim()
        i = j
      }
      if (name === "before" || name === "after") {
        if (pseudo) return undefined
        pseudo = name
        weight += 1
      } else if (element) return undefined
      else if (name === "root") {
        // A design has no <html>; what's said of it lands on the frame's root, as `html` and `body` rules do.
        if (compound.tag && compound.tag !== "html") return undefined
        compound.tag = "html"
        weight += 100
      } else if (name === "not") {
        const inner = arg === undefined ? undefined : parseCompound(arg, 0)
        if (!inner || inner.end !== arg!.length || inner.pseudo) return undefined
        compound.pseudos.push({ name, not: inner.compound })
        weight += inner.weight
      } else if (positional.has(name)) {
        compound.pseudos.push({ name, ...(arg !== undefined && { arg }) })
        weight += 100
      }
      // Anything else is a state (:hover, :focus-visible, :checked): a design is a still picture, so it never applies.
      else return undefined
    } else break
  }
  return i === start ? undefined : { compound, end: i, ...(pseudo && { pseudo }), weight }
}

function parseSelector(s: string): Pick<Rule, "steps" | "pseudo" | "specificity"> | undefined {
  const steps: Array<Step> = []
  let specificity = 0
  let pseudo: "before" | "after" | undefined
  let combinator: Step["combinator"] | undefined
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === ">" || c === "+" || c === "~") {
      if (!steps.length || combinator) return undefined
      combinator = c
      i++
      continue
    }
    // Nothing may follow a pseudo-element.
    if (pseudo) return undefined
    const part = parseCompound(s, i)
    if (!part) return undefined
    steps.push({ compound: part.compound, combinator: combinator ?? " " })
    combinator = undefined
    specificity += part.weight
    pseudo = part.pseudo
    i = part.end
  }
  return steps.length && !combinator ? { steps, ...(pseudo && { pseudo }), specificity } : undefined
}

/**
 * Pasted snippets usually style through a <style> block. Designs only have
 * inline styles, so rules are matched here and inlined: tags, classes, ids,
 * attributes, `*`, the four combinators, positional pseudo-classes, `:not()`
 * and `::before` / `::after`. Rules about a state (`:hover`) and at-rules
 * (`@media`, `@font-face`) are skipped.
 */
function parseRules(css: string): Array<Rule> {
  const rules: Array<Rule> = []
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "")
  let order = 0
  let i = 0
  while (i < clean.length) {
    const open = clean.indexOf("{", i)
    if (open < 0) break
    const selector = clean.slice(i, open).trim()
    // Find the matching close brace (at-rules nest).
    let depth = 1
    let j = open + 1
    while (j < clean.length && depth) {
      if (clean[j] === "{") depth++
      else if (clean[j] === "}") depth--
      j++
    }
    const body = clean.slice(open + 1, j - 1)
    i = j
    if (selector.startsWith("@")) continue
    const decls = parseStyle(body)
    for (const sel of splitTop(selector, ",")) {
      const parsed = parseSelector(sel.trim())
      if (parsed) rules.push({ ...parsed, decls, order: order++ })
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order)
}

const elementsOf = (el: RawElement) => el.children.filter((c): c is RawElement => typeof c !== "string")

/** `:nth-child(2n+1)` and friends: whether position `n` (from 1) is one the formula names. */
function nth(arg: string | undefined, n: number): boolean {
  const a = (arg ?? "").replace(/\s+/g, "").toLowerCase()
  if (a === "odd") return n % 2 === 1
  if (a === "even") return n % 2 === 0
  if (/^[+-]?\d+$/.test(a)) return n === Number(a)
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(a)
  if (!m) return false
  const step = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1])
  const offset = Number(m[2] ?? 0)
  if (step === 0) return n === offset
  const k = (n - offset) / step
  return Number.isInteger(k) && k >= 0
}

function matches(el: RawElement, c: Compound): boolean {
  // The top of a snippet stands in for the page: bare `html` and `body` reach it, nothing else does.
  if (el.tag === "#root") return (c.tag === "html" || c.tag === "body") && !c.id && !c.classes.length && !c.attrs.length && !c.pseudos.length
  if (c.tag && c.tag !== el.tag) return false
  const get = (n: string) => el.attrs.find(([k]) => k === n)?.[1]
  if (c.id && get("id") !== c.id) return false
  if (c.classes.length) {
    const cls = new Set((get("class") ?? "").split(/\s+/))
    if (!c.classes.every((k) => cls.has(k))) return false
  }
  for (const a of c.attrs) {
    const v = get(a.name)
    if (v === undefined) return false
    const ok =
      a.op === "" ? true
      : a.op === "=" ? v === a.value
      : a.op === "~=" ? v.split(/\s+/).includes(a.value)
      : a.op === "|=" ? v === a.value || v.startsWith(`${a.value}-`)
      : a.value !== "" && (a.op === "^=" ? v.startsWith(a.value) : a.op === "$=" ? v.endsWith(a.value) : v.includes(a.value))
    if (!ok) return false
  }
  for (const p of c.pseudos) {
    if (p.not) {
      if (matches(el, p.not)) return false
      continue
    }
    const all = el.parent ? elementsOf(el.parent) : [el]
    const same = all.filter((s) => s.tag === el.tag)
    const at = all.indexOf(el)
    const ok =
      p.name === "first-child" ? at === 0
      : p.name === "last-child" ? at === all.length - 1
      : p.name === "only-child" ? all.length === 1
      : p.name === "first-of-type" ? same[0] === el
      : p.name === "last-of-type" ? same.at(-1) === el
      : p.name === "only-of-type" ? same.length === 1
      : p.name === "nth-child" ? nth(p.arg, at + 1)
      : p.name === "nth-last-child" ? nth(p.arg, all.length - at)
      : nth(p.arg, same.indexOf(el) + 1)
    if (!ok) return false
  }
  return true
}

/** Whether `el` is what the selector's steps up to `k` name, reading right to left. */
function matchesSteps(el: RawElement, steps: ReadonlyArray<Step>, k = steps.length - 1): boolean {
  const step = steps[k]!
  if (!matches(el, step.compound)) return false
  if (k === 0) return true
  if (step.combinator === ">") return !!el.parent && matchesSteps(el.parent, steps, k - 1)
  if (step.combinator === " ") {
    for (let at = el.parent; at; at = at.parent) if (matchesSteps(at, steps, k - 1)) return true
    return false
  }
  const before = el.parent ? elementsOf(el.parent) : []
  const i = before.indexOf(el)
  if (step.combinator === "+") return i > 0 && matchesSteps(before[i - 1]!, steps, k - 1)
  for (let j = i - 1; j >= 0; j--) if (matchesSteps(before[j]!, steps, k - 1)) return true
  return false
}

/** Hand each element the declarations of the rules that match it, least specific first. Returns the page's own (`html`, `body`, `:root`), which go on the design's root. */
function applyRules(root: RawElement, rules: ReadonlyArray<Rule>): Array<Decl> {
  const page: Array<Decl> = []
  for (const r of rules) if (r.steps.length === 1 && !r.pseudo && matches(root, r.steps[0]!.compound)) page.push(...r.decls)
  const walk = (el: RawElement) => {
    for (const c of el.children) {
      if (typeof c === "string") continue
      for (const r of rules) {
        if (!matchesSteps(c, r.steps)) continue
        if (r.pseudo) (c[r.pseudo] ??= []).push(...r.decls)
        else c.style.push(...r.decls)
      }
      walk(c)
    }
  }
  if (rules.length) walk(root)
  return page
}

// --- Settling: custom properties, shorthands, pseudo-elements, icons ---------------------

/** What an element hands down that settling needs: its custom properties, computed, and its text color. */
type Scope = { readonly vars: ReadonlyMap<string, string>; readonly color?: string; readonly space?: string }

/** Replace every `var(--x, fallback)` using `lookup`. Undefined when one can't be resolved, which makes the whole declaration invalid, as in CSS. */
function substituteVars(value: string, lookup: (name: string) => string | undefined, depth = 0): string | undefined {
  if (!value.includes("var(")) return value
  if (depth > 16) return undefined
  let out = ""
  let i = 0
  for (;;) {
    const at = value.indexOf("var(", i)
    if (at < 0) return out + value.slice(i)
    if (at > 0 && /[\w-]/.test(value[at - 1]!)) {
      out += value.slice(i, at + 4)
      i = at + 4
      continue
    }
    let level = 1
    let comma = -1
    let quote = ""
    let j = at + 4
    for (; j < value.length && level; j++) {
      const c = value[j]!
      if (quote) {
        if (c === quote) quote = ""
      } else if (c === '"' || c === "'") quote = c
      else if (c === "(") level++
      else if (c === ")") level--
      else if (c === "," && level === 1 && comma < 0) comma = j
    }
    if (level) return undefined
    const name = value.slice(at + 4, comma < 0 ? j - 1 : comma).trim()
    const known = lookup(name)
    const with_ = known !== undefined ? known : comma < 0 ? undefined : substituteVars(value.slice(comma + 1, j - 1), lookup, depth + 1)
    if (with_ === undefined) return undefined
    out += value.slice(i, at) + with_.trim()
    i = j
  }
}

/** An element's custom properties: what it inherits, overridden by what it declares (which may refer to either). */
function scopeVars(decls: ReadonlyArray<Decl>, inherited: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const own = new Map<string, string>()
  for (const [prop, value] of decls) if (prop.startsWith("--")) own.set(prop, value)
  if (!own.size) return inherited
  const out = new Map(inherited)
  const state = new Map<string, "busy" | "done">()
  const get = (name: string): string | undefined => {
    const raw = own.get(name)
    if (raw === undefined) return inherited.get(name)
    // A property that refers to itself, however indirectly, has no value.
    if (state.get(name) === "busy") return undefined
    if (state.get(name) !== "done") {
      state.set(name, "busy")
      const value = substituteVars(raw, get)
      // One that can't be computed keeps what it inherited.
      if (value !== undefined) out.set(name, value)
      state.set(name, "done")
    }
    return out.get(name)
  }
  for (const name of own.keys()) get(name)
  return out
}

function base64(text: string): string {
  let binary = ""
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Stored url() values are unquoted https or base64 data images. Snippets write
 * them quoted, and inline SVG as readable markup (`url("data:image/svg+xml,%3Csvg …")`);
 * this rewrites both into the stored form. Anything else is left for the checks to refuse.
 */
function normalizeUrls(value: string): string {
  if (!/url\(/i.test(value)) return value
  return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_, a?: string, b?: string, c?: string) => {
    const url = (a ?? b ?? c ?? "").trim()
    const svg = /^data:image\/svg\+xml([^,]*),/i.exec(url)
    if (!svg || /;base64/i.test(svg[1]!)) return `url(${url})`
    let markup = url.slice(svg[0].length)
    try {
      markup = decodeURIComponent(markup)
    } catch {
      // Not percent-encoded after all: it's the markup itself.
    }
    return `url(data:image/svg+xml;base64,${base64(markup)})`
  })
}

/** `font: 500 11px/1 Inter, sans-serif` as the properties it sets (those it leaves out go back to normal, as the shorthand does). */
function fontLonghands(value: string): Array<Decl> {
  if (/^inherit$/i.test(value)) return ["font-style", "font-weight", "font-size", "line-height", "font-family"].map((p) => [p, "inherit"])
  const m = /^((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|condensed|expanded)\s+)*)([^\s/]+)(?:\s*\/\s*([^\s/]+))?\s+(.+)$/i.exec(value)
  if (!m) return []
  const words = m[1]!.toLowerCase().split(/\s+/)
  return [
    ["font-style", words.find((w) => w === "italic" || w === "oblique") ?? "normal"],
    ["font-weight", words.find((w) => /^(bold|bolder|lighter|[1-9]00)$/.test(w)) ?? "normal"],
    ["font-size", m[2]!],
    ["line-height", m[3] ?? "normal"],
    ["font-family", m[4]!],
  ]
}

const important = /\s*!\s*important\s*$/i

/**
 * An element's final declarations, from its matched rules and inline style:
 * `!important` ones win, custom properties are substituted, shorthands the
 * allowlist doesn't have are spelled out, and a property declared twice keeps
 * its last place (a later `border` must still override an earlier `border-color`).
 */
function settle(el: RawElement, decls: ReadonlyArray<Decl>, scope: Scope): Scope {
  const ordered = [...decls.filter(([, v]) => !important.test(v)), ...decls.filter(([, v]) => important.test(v))]
  const vars = scopeVars(ordered, scope.vars)
  const final = new Map<string, string>()
  const put = (prop: string, value: string) => {
    final.delete(prop)
    final.set(prop, value)
  }
  for (const [rawProp, rawValue] of ordered) {
    if (rawProp.startsWith("--")) continue
    const prop = rawProp.trim().toLowerCase()
    const value = substituteVars(rawValue.replace(important, ""), (name) => vars.get(name))
    if (value === undefined) continue
    if (prop === "font") for (const [p, v] of fontLonghands(value.trim())) put(p, v)
    else put(prop, normalizeUrls(value.trim()))
  }
  el.final = [...final]
  const own = (prop: string, inherited: string | undefined) => {
    const value = final.get(prop)
    return value && !/^inherit$/i.test(value) ? value.toLowerCase() : inherited
  }
  const color = own("color", scope.color)
  el.space = own("white-space", scope.space)
  return { vars, ...(color !== undefined && { color }), ...(el.space !== undefined && { space: el.space }) }
}

/** The text of a `content` value (`"→"`, `attr(data-count)`, `""`), or undefined when there's no box to make (`none`) or it isn't text. */
function contentText(value: string, el: RawElement): string | undefined {
  let rest = value.trim()
  if (!rest || /^(none|normal)$/i.test(rest)) return undefined
  let out = ""
  while (rest) {
    const s = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/.exec(rest)
    const a = s ? null : /^attr\(\s*([\w-]+)\s*\)/i.exec(rest)
    if (s)
      out += (s[1] ?? s[2] ?? "").replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_, hex?: string, ch?: string) => {
        const code = hex ? parseInt(hex, 16) : 0
        return hex ? (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "") : (ch ?? "")
      })
    else if (a) out += el.attrs.find(([k]) => k === a[1]!.toLowerCase())?.[1] ?? ""
    else return undefined
    rest = rest.slice((s ?? a)![0].length).trimStart()
  }
  return out
}

/** CSS that paints an SVG's shapes. In a stylesheet it reaches into an inline <svg>; an image is on its own, so it's written into the markup. */
const svgPaint = new Set(["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "stroke-opacity", "fill-opacity", "fill-rule", "clip-rule"])

/**
 * Turn an inline <svg> into an <img> of the same picture. Designs have no svg
 * layers, but images may be SVG, so an icon survives as one: `currentColor`
 * and custom properties become the values they had here, and the size and
 * layout the stylesheet gave the svg go on the image.
 */
function svgToImage(el: RawElement, scope: Scope): void {
  const source = el.source ?? ""
  const end = source.indexOf(">")
  if (end < 0) return
  const selfClosing = /\/\s*$/.test(source.slice(0, end))
  const final = el.final ?? []
  const paint = final.filter(([p]) => svgPaint.has(p)).map(([p, v]) => `${p}:${v}`).join(";")
  let open = source.slice(0, end).replace(/\/\s*$/, "").replace(/\s(?:style|class)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
  if (!/\sxmlns\s*=/i.test(open)) open += ' xmlns="http://www.w3.org/2000/svg"'
  if (paint) open += ` style="${escapeAttr(paint)}"`
  // An image can't run scripts or load anything, so none of this would do harm; it's removed so the markup is also inert if someone copies it out.
  const markup = `${open}${selfClosing ? "/>" : `>${source.slice(end + 1)}`}`
    .replace(/<(script|foreignObject)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href\s*=\s*)(?:"(?!#|data:image\/)[^"]*"|'(?!#|data:image\/)[^']*')/gi, '$1""')
  const settled = (substituteVars(markup, (name) => scope.vars.get(name)) ?? markup).replace(/currentcolor/gi, scope.color ?? "#000")
  const src = `data:image/svg+xml;base64,${base64(settled)}`
  // Too big to store: left as an <svg>, which is dropped like any other.
  if (!isImageUrl(src)) return
  el.tag = "img"
  el.attrs = [["src", src], ["alt", el.attrs.find(([k]) => k === "aria-label")?.[1] ?? ""]]
  el.final = final.filter(([p]) => !svgPaint.has(p))
}

/** Settle every element under `el`, top down, so each sees what it inherits. */
function settleTree(el: RawElement, scope: Scope): void {
  for (const c of el.children) {
    if (typeof c === "string") continue
    const inline = c.attrs.find(([k]) => k === "style")?.[1]
    const own = settle(c, [...c.style, ...(inline ? parseStyle(inline) : [])], scope)
    if (c.tag === "svg") {
      if (c.source) svgToImage(c, own)
      continue
    }
    // ::before and ::after are boxes inside the element, so they become layers: a span at the start or the end.
    if (!htmlVoid.has(c.tag))
      for (const which of ["before", "after"] as const) {
        const decls = c[which]
        const content = decls?.filter(([p]) => p.trim().toLowerCase() === "content").at(-1)?.[1]
        const text = content === undefined ? undefined : contentText(substituteVars(content.replace(important, ""), (name) => own.vars.get(name)) ?? "none", c)
        if (text === undefined) continue
        const box: RawElement = { tag: "span", attrs: [], children: text ? [text] : [], parent: c, style: decls!.filter(([p]) => p.trim().toLowerCase() !== "content") }
        if (which === "before") c.children.unshift(box)
        else c.children.push(box)
      }
    settleTree(c, own)
  }
}

// --- Raw tree → design nodes ---------------------------------------------------------

export type DesignOptions = {
  /** Make a fresh node id (default: random `n_…`). */
  readonly newId?: () => string
  /** Ids already taken (e.g. by the tree a fragment is inserted into): `data-node` ids that clash get fresh ones. */
  readonly reserved?: ReadonlySet<string>
}

const randomId = () => {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
  return `n_${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % 36]).join("")}`
}

/**
 * Parse HTML into a design tree. Tolerant: unknown tags are unwrapped (their
 * content kept), dangerous ones dropped with their content, styles and
 * attributes filtered to the allowlists, and `<style>` rules with simple
 * selectors inlined. `data-node="…"` attributes keep node ids, so an agent can
 * edit the HTML from `designToHtml(tree, { ids: true })` and send it back
 * without changing the ids people have selected.
 */
export function htmlToDesign(html: string, options: DesignOptions = {}): DesignTree {
  return convert(html, options, false)
}

/**
 * Parse an HTML fragment into nodes to insert: `roots` are its top-level
 * layers in order, `nodes` all of them (and their descendants).
 */
export function htmlToDesignNodes(html: string, options: DesignOptions = {}): { roots: Array<string>; nodes: Array<DesignNode> } {
  const tree = convert(html, options, true)
  const wrapper = tree.nodes[tree.root]!
  return { roots: [...wrapper.children], nodes: Object.values(tree.nodes).filter((n) => n.id !== tree.root) }
}

function convert(html: string, options: DesignOptions, fragment: boolean): DesignTree {
  const makeId = options.newId ?? randomId
  const { root: raw, css } = parseHtml(html)
  // The page's own rules (html, body, :root) settle first: their custom properties are what everything else inherits.
  const scope = settle(raw, applyRules(raw, parseRules(css)), { vars: new Map() })
  settleTree(raw, scope)
  const page = raw.final ?? []
  const nodes: Record<string, DesignNode> = {}
  const used = new Set<string>(options.reserved)
  let count = 0
  const idFor = (el: RawElement | null) => {
    const wanted = el?.attrs.find(([k]) => k === "data-node")?.[1]
    if (wanted && idPattern.test(wanted) && !used.has(wanted)) {
      used.add(wanted)
      return wanted
    }
    let id = makeId()
    while (used.has(id)) id = makeId()
    used.add(id)
    return id
  }

  /** Flatten unknown wrappers into a list of allowed elements and text runs. */
  const flatten = (children: ReadonlyArray<RawNode>, depth: number): Array<RawElement | string> => {
    const out: Array<RawElement | string> = []
    for (const c of children) {
      if (typeof c === "string") out.push(c)
      else if (dropTags.has(c.tag)) continue
      else if (c.tag === "br") out.push(lineBreak)
      else if (isDesignTag(c.tag) || tagAliases[c.tag]) {
        if (depth < maxDesignDepth) out.push(c)
        else out.push(...flatten(c.children, depth))
      } else out.push(...flatten(c.children, depth))
    }
    return out
  }

  const build = (el: RawElement, tag: DesignTag, depth: number, extraStyle: Array<[string, string]> = []): string | undefined => {
    if (count >= maxDesignNodes) return undefined
    count++
    const id = idFor(el)
    const style = cleanStyle([...extraStyle, ...(el.final ?? [])])
    const attrs: Record<string, string> = {}
    for (const [k, v] of el.attrs) if (!attrError(tag, k, v.trim())) attrs[k] = v.trim()
    const node: { -readonly [K in keyof DesignNode]: DesignNode[K] } = { id, tag, children: [] }
    if (Object.keys(attrs).length) node.attrs = attrs
    if (Object.keys(style).length) node.style = style
    nodes[id] = node
    if (isVoidTag(tag)) return id
    const parts = flatten(el.children, depth)
    const merged: Array<RawElement | string> = []
    for (const p of parts) {
      const last = merged[merged.length - 1]
      if (typeof p === "string" && typeof last === "string") merged[merged.length - 1] = last + p
      else merged.push(p)
    }
    // Text follows its element's white-space, as in a browser: `pre` keeps it all, `pre-line` keeps the lines, the rest
    // collapses to single spaces. A <br> is a line whatever the mode, so where lines wouldn't survive it turns the element to `pre-line`.
    const exact = el.space === "pre" || el.space === "pre-wrap" || el.space === "break-spaces"
    const breaks = merged.some((p) => typeof p === "string" && p.includes(lineBreak))
    const made = breaks && !keepsLines(el.space) && el.space !== "nowrap"
    if (made) node.style = { ...node.style, "white-space": "pre-line" }
    const collapse = (t: string) =>
      exact
        ? t.replaceAll(lineBreak, "\n")
        : made
          ? t.replace(/[\t\n\f\r ]+/g, " ").replace(/ ?\u0000 ?/g, "\n")
          : el.space === "pre-line"
            ? t.replace(/[\t\f\r ]+/g, " ").replace(/ ?[\n\u0000] ?/g, "\n")
            : t.replace(/[\t\n\f\r\u0000 ]+/g, " ")
    if (merged.every((p) => typeof p === "string")) {
      // Inline elements keep their edge spaces (they separate words from the next run); blocks don't need them.
      const t = collapse(merged.join(""))
      if (t.trim()) node.text = (inlineTags.has(tag) || exact ? t : t.trim()).slice(0, maxText)
      return id
    }
    const children: Array<string> = []
    merged.forEach((p, k) => {
      if (typeof p !== "string") {
        const childTag = isDesignTag(p.tag) ? p.tag : tagAliases[p.tag]!
        const child = build(p, childTag, depth + 1)
        if (child) children.push(child)
        return
      }
      // A text run between elements: keep the spaces that separate words, except at the edges.
      let t = collapse(p)
      if (k === 0) t = t.trimStart()
      if (k === merged.length - 1) t = t.trimEnd()
      // Between elements, white space alone is formatting, unless a <br> put a line there.
      if ((!t.trim() && !(p.includes(lineBreak) && t.includes("\n"))) || count >= maxDesignNodes) return
      count++
      const runId = idFor(null)
      nodes[runId] = { id: runId, tag: "span", text: t.slice(0, maxText), children: [] }
      children.push(runId)
    })
    node.children = children
    return id
  }

  const top = flatten(raw.children, 0).filter((p) => typeof p !== "string" || p.trim())
  const single = top.length === 1 && typeof top[0] !== "string" ? top[0] : undefined
  const singleTag = single ? (isDesignTag(single.tag) ? single.tag : tagAliases[single.tag]) : undefined
  // One container at the top becomes the root itself, so html → design → html is stable. Anything
  // else (several elements, a lone heading or image) gets a wrapper, so the root can always hold layers.
  const container = single !== undefined && flatten(single.children, 0).some((p) => typeof p !== "string")
  const rootId =
    !fragment && single && singleTag && container && !isVoidTag(singleTag) && !page.length
      ? build(single, singleTag, 0)
      : build({ tag: "div", attrs: [], children: top, parent: null, style: [] }, "div", 0, page)
  const root = nodes[rootId!]!
  if (root.text !== undefined) {
    // Bare text at the top: put it in a paragraph so the root can still hold layers.
    const p = idFor(null)
    nodes[p] = { id: p, tag: "p", text: root.text, children: [] }
    const { text: _text, ...rest } = root
    nodes[root.id] = { ...rest, children: [p] }
  }
  return { root: rootId!, nodes }
}

// --- Nodes → HTML ---------------------------------------------------------------------

const escapeText = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;")
const escapeAttr = (t: string) => escapeText(t).replace(/"/g, "&quot;")
export const styleText = (style: { readonly [prop: string]: string } | undefined) =>
  Object.entries(style ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ")

/** A span with only text and no styling: written as plain text when it sits among siblings. */
const isTextRun = (n: DesignNode) => n.tag === "span" && n.text !== undefined && !n.style && !n.attrs && !n.children.length

/**
 * Serialize a design (or the subtree at `from`) to clean HTML with inline
 * styles. Block children go on their own indented lines; mixed text stays
 * inline so no whitespace is invented. `ids: true` adds `data-node` attributes
 * for agents that will send the HTML back.
 */
export function designToHtml(tree: DesignTree, options: { readonly from?: string; readonly ids?: boolean } = {}): string {
  const write = (id: string, indent: string, depth: number, inherited?: string): string => {
    const n = tree.nodes[id]
    if (!n || depth > maxDesignDepth + 1) return ""
    // A newline that shows as a line break is written as one, so it's still there when the HTML is read back.
    const space = n.style?.["white-space"] ?? inherited
    const text = (t: string) => (keepsLines(space) ? escapeText(t).replace(/\n/g, "<br>") : escapeText(t))
    // Re-check on the way out, so a tree stored under older rules can't emit anything unsafe.
    const attrs = Object.entries(n.attrs ?? {}).filter(([k, v]) => !attrError(n.tag, k, v))
    const style = Object.fromEntries(Object.entries(n.style ?? {}).filter(([k, v]) => !styleError(k, v)))
    const head =
      `<${n.tag}` +
      (options.ids ? ` data-node="${escapeAttr(n.id)}"` : "") +
      attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("") +
      (Object.keys(style).length ? ` style="${escapeAttr(styleText(style))}"` : "") +
      ">"
    if (isVoidTag(n.tag)) return head
    if (n.text !== undefined) return `${head}${text(n.text)}</${n.tag}>`
    if (!n.children.length) return `${head}</${n.tag}>`
    const kids = n.children.map((c) => tree.nodes[c]).filter((c) => c !== undefined)
    // Mixed text stays on one line: new lines and indentation would add spaces between words.
    const inline = kids.length > 1 && kids.some(isTextRun)
    if (inline) return `${head}${kids.map((c) => (isTextRun(c) && !options.ids ? text(c.text ?? "") : write(c.id, "", depth + 1, space))).join("")}</${n.tag}>`
    const inner = indent + "  "
    return `${head}\n${kids.map((c) => inner + write(c.id, inner, depth + 1, space)).join("\n")}\n${indent}</${n.tag}>`
  }
  return write(options.from ?? tree.root, "", 0)
}

/** A compact outline for agents: one line per node with its id, tag, text and a few styles. */
export function designOutline(tree: DesignTree): string {
  const lines: Array<string> = []
  const walk = (id: string, depth: number) => {
    const n = tree.nodes[id]
    if (!n || depth > maxDesignDepth + 1) return
    const style = Object.entries(n.style ?? {})
    const css = style.length ? ` {${style.slice(0, 4).map(([k, v]) => `${k}: ${v.length > 40 ? v.slice(0, 40) + "…" : v}`).join("; ")}${style.length > 4 ? `; +${style.length - 4}` : ""}}` : ""
    const attrs = Object.entries(n.attrs ?? {}).map(([k, v]) => ` ${k}="${v.length > 50 ? v.slice(0, 50) + "…" : v}"`).join("")
    const text = n.text !== undefined ? ` "${n.text.length > 60 ? n.text.slice(0, 60) + "…" : n.text}"` : ""
    lines.push(`${"  ".repeat(depth)}${n.id} <${n.tag}>${attrs}${text}${css}`)
    for (const c of n.children) walk(c, depth + 1)
  }
  walk(tree.root, 0)
  return lines.join("\n")
}

/** Copy a subtree with fresh ids (for duplicate and paste). Returns the new root and all its nodes. */
export function cloneSubtree(tree: DesignTree, id: string, makeId: () => string = randomId): { root: string; nodes: Array<DesignNode> } {
  const map = new Map<string, string>()
  const ids = subtreeIds(tree, id)
  for (const old of ids) map.set(old, makeId())
  const nodes = ids.map((old) => {
    const n = tree.nodes[old]!
    return { ...n, id: map.get(old)!, children: n.children.map((c) => map.get(c)!) }
  })
  return { root: map.get(id)!, nodes }
}

/** A human label for a layer: its text, else its tag. */
export function nodeLabel(n: DesignNode): string {
  if (n.text) return n.text.length > 32 ? n.text.slice(0, 32) + "…" : n.text
  if (n.tag === "img") return n.attrs?.alt || "Image"
  return n.tag
}
