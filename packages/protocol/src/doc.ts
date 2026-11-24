import { Schema } from "effect"
import { ArtifactRef, Id } from "./core.ts"
import { applyListOp, listOpSchema, mergePatch, type ListOp, type ListResult, type ListState } from "./list.ts"

/**
 * Doc surface: an ordered list of blocks (Notion-style). Edits are block-level:
 * each block's text is last-writer-wins, and presence shows who is editing which
 * block. Character-level merging inside one block (CRDT) is a later upgrade;
 * agents edit whole blocks anyway.
 */

export const BlockType = Schema.Literals([
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bullet",
  "numbered",
  "todo",
  "quote",
  "code",
  "divider",
  "image",
  "embed",
])
export type BlockType = typeof BlockType.Type

/** Blocks that show something other than their text (a picture, a linked artifact); their text is the caption. */
export const isFigureType = (type: BlockType) => type === "image" || type === "embed"

const Text = Schema.String.check(Schema.isMaxLength(20_000))

/**
 * Where an image block's bytes come from: an uploaded asset or an https URL. The
 * asset form is matched whole because browsers fetch `src` on sight: a looser
 * prefix would let "/api/v1/artifacts/../../share/exit" hit any route as the viewer.
 */
export const ImageSrc = Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^(https:\/\/\S+|\/api\/v1\/artifacts\/[\w-]+\/assets\/[\w-]+)$/))
export const isImageSrc = Schema.is(ImageSrc)

/**
 * An agent's change that a person hasn't reviewed yet (Notion-style "Accept /
 * Discard"). `insert`: the whole block is proposed; accept clears this field,
 * discard removes the block. `replace`: the text was rewritten; `original` is
 * what it said before, so discard restores it. Both are plain `update`/`remove`
 * ops, so review syncs and replays like any other edit.
 */
export const Suggestion = Schema.Struct({
  kind: Schema.Literals(["insert", "replace"]),
  /** actorKey of the agent. */
  by: Schema.String,
  /** The request (mention) this came from; groups a reply's blocks for review. */
  mentionId: Schema.optionalKey(Schema.String),
  original: Schema.optionalKey(Text),
})
export interface Suggestion extends Schema.Schema.Type<typeof Suggestion> {}

/**
 * Who last changed a block's content. The reducer stamps `by` from the op's
 * actor, so it can't be forged; `at` (epoch ms) and `name` are the writer's own
 * hints and survive only when the writer is that same actor. Writers that don't
 * send them (agents over HTTP) leave the time unknown.
 */
export const BlockEdit = Schema.Struct({
  by: Schema.String,
  at: Schema.optionalKey(Schema.Number),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
})
export interface BlockEdit extends Schema.Schema.Type<typeof BlockEdit> {}

/**
 * The doc's own header: an emoji icon and a cover (a preset name the editor
 * maps to a gradient). It lives on one reserved record, `PAGE_BLOCK_ID`, so it
 * persists and syncs through the same list ops as blocks. Editors don't render
 * that record as a block, and markdown skips it.
 */
export const PageMeta = Schema.Struct({
  icon: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(16)))),
  cover: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(32)))),
})
export interface PageMeta extends Schema.Schema.Type<typeof PageMeta> {}

export const PAGE_BLOCK_ID = "page"

export const Block = Schema.Struct({
  id: Id,
  type: BlockType,
  text: Text,
  checked: Schema.optionalKey(Schema.Boolean),
  /** Image blocks only (`text` is the caption). Missing while the image is still being added. */
  src: Schema.optionalKey(ImageSrc),
  /** Embed blocks only: the artifact, or one item in it, previewed read-only. Access is checked when it's viewed, not here. */
  ref: Schema.optionalKey(ArtifactRef),
  suggestion: Schema.optionalKey(Schema.NullOr(Suggestion)),
  edited: Schema.optionalKey(BlockEdit),
  /** Only on the reserved `PAGE_BLOCK_ID` record. */
  page: Schema.optionalKey(PageMeta),
})
export interface Block extends Schema.Schema.Type<typeof Block> {}

export const BlockPatch = Schema.Struct({
  type: Schema.optionalKey(BlockType),
  text: Schema.optionalKey(Text),
  checked: Schema.optionalKey(Schema.Boolean),
  src: Schema.optionalKey(ImageSrc),
  ref: Schema.optionalKey(ArtifactRef),
  /** null clears it (accept); an object proposes. */
  suggestion: Schema.optionalKey(Schema.NullOr(Suggestion)),
  /** The writer's time and name for the edit (see BlockEdit); the reducer sets `by`. */
  edited: Schema.optionalKey(BlockEdit),
  /** Replaces the page header whole. */
  page: Schema.optionalKey(PageMeta),
})
export interface BlockPatch extends Schema.Schema.Type<typeof BlockPatch> {}

export const DocOp = listOpSchema(Block, BlockPatch)
export type DocOp = ListOp<Block, BlockPatch>
export const decodeDocOp = Schema.decodeUnknownResult(DocOp)

export const DocState = Schema.Struct({ items: Schema.Array(Block) })
export interface DocState extends ListState<Block> {}

export type DocPresence = {
  /** The block this member's caret is in. */
  blockId?: string | null
  editing?: boolean
  thinking?: boolean
  status?: string
}

const mergeBlock = (block: Block, patch: BlockPatch): Block => mergePatch(block, patch)

export const isPageBlock = (b: Block) => b.id === PAGE_BLOCK_ID || b.page !== undefined

/** `by`'s stamp: its own time and name hints are kept, anyone else's are dropped. */
const stampFor = (by: string, hint: BlockEdit | undefined): BlockEdit =>
  hint?.by === by ? { ...hint, by } : { by }

/** Patches that change what a block says (not just its review state) count as an edit. */
const changesContent = (p: BlockPatch) => p.text !== undefined || p.type !== undefined || p.checked !== undefined || p.src !== undefined || p.ref !== undefined || p.page !== undefined

/** Stamp who edited each block (see BlockEdit), then apply like any list op. Deterministic, so cell and browser agree. */
export const applyDocOp = (state: DocState, op: DocOp, by: string): ListResult<Block> => {
  let stamped: DocOp = op
  if (op.type === "insert") stamped = { ...op, item: { ...op.item, edited: stampFor(by, op.item.edited) } }
  else if (op.type === "update") {
    const { edited, ...rest } = op.patch
    stamped = { ...op, patch: changesContent(rest) ? { ...rest, edited: stampFor(by, edited) } : rest }
  }
  return applyListOp(state, stamped, mergeBlock)
}

/** `![caption](src)`, escaped so `markdownToBlocks` reads the same caption and src back. */
export const imageMarkdown = (caption: string, src: string) =>
  `![${caption.replace(/\s*\n\s*/g, " ").replace(/[\\\]]/g, "\\$&")}](${src.replace(/\(/g, "%28").replace(/\)/g, "%29")})`

/** `![[artifact#item|caption]]`: a linked artifact, in the wiki-embed form `markdownToBlocks` reads back. */
export const embedMarkdown = (ref: ArtifactRef, caption = "") =>
  `![[${ref.artifactId}${ref.item ? `#${ref.item}` : ""}${caption ? `|${caption.replace(/\s*\n\s*/g, " ")}` : ""}]]`

/** Markdown rendering for agents (MCP `read`) and export. */
export function docToMarkdown(state: DocState): string {
  let n = 0
  return state.items
    .filter((b) => !isPageBlock(b))
    .map((b) => {
      n = b.type === "numbered" ? n + 1 : 0
      switch (b.type) {
        case "heading1":
          return `# ${b.text}`
        case "heading2":
          return `## ${b.text}`
        case "heading3":
          return `### ${b.text}`
        case "bullet":
          return `- ${b.text}`
        case "numbered":
          return `${n}. ${b.text}`
        case "todo":
          return `- [${b.checked ? "x" : " "}] ${b.text}`
        case "quote":
          return `> ${b.text}`
        case "code":
          return "```\n" + b.text + "\n```"
        case "divider":
          return "---"
        case "image":
          return b.src ? imageMarkdown(b.text, b.src) : b.text
        case "embed":
          return b.ref ? embedMarkdown(b.ref, b.text) : b.text
        case "paragraph":
          return b.text
      }
    })
    .join("\n\n")
}

/**
 * Parse markdown into blocks (the inverse of docToMarkdown), for agents and the
 * CLI writing docs in markdown. Inline formatting is kept as literal text.
 *
 * `lineBreaks: true` makes every non-empty line its own block instead of joining
 * soft-wrapped lines into one paragraph. Pasted plain text wants that: each line
 * someone copied is a line they meant.
 */
export function markdownToBlocks(markdown: string, makeId: () => string, options?: { lineBreaks?: boolean }): Array<Block> {
  const blocks: Array<Block> = []
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  let paragraph: Array<string> = []
  const flush = () => {
    if (paragraph.length) blocks.push({ id: makeId(), type: "paragraph", text: paragraph.join(" ") })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const fence = line.match(/^```/)
    if (fence) {
      flush()
      const code: Array<string> = []
      while (++i < lines.length && !/^```/.test(lines[i] ?? "")) code.push(lines[i] ?? "")
      blocks.push({ id: makeId(), type: "code", text: code.join("\n") })
      continue
    }
    // Only an image alone on its line, with a source we'd render; anything else stays literal text.
    const image = line.trim().match(/^!\[((?:[^\]\\]|\\.)*)\]\(([^()\s]+)\)$/)
    if (image && isImageSrc(image[2])) {
      flush()
      blocks.push({ id: makeId(), type: "image", text: (image[1] ?? "").replace(/\\(.)/g, "$1"), src: image[2] })
      continue
    }
    const embed = line.trim().match(/^!\[\[([\w-]{1,64})(?:#([\w-]{1,64}))?(?:\|(.*))?\]\]$/)
    if (embed?.[1]) {
      flush()
      blocks.push({ id: makeId(), type: "embed", text: embed[3] ?? "", ref: { artifactId: embed[1], ...(embed[2] && { item: embed[2] }) } })
      continue
    }
    const rules: Array<[RegExp, (m: RegExpMatchArray) => Omit<Block, "id">]> = [
      [/^###\s+(.*)$/, (m) => ({ type: "heading3", text: m[1] ?? "" })],
      [/^##\s+(.*)$/, (m) => ({ type: "heading2", text: m[1] ?? "" })],
      [/^#\s+(.*)$/, (m) => ({ type: "heading1", text: m[1] ?? "" })],
      [/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/, (m) => ({ type: "todo", text: m[2] ?? "", checked: m[1] !== " " })],
      [/^\s*[-*+]\s+(.*)$/, (m) => ({ type: "bullet", text: m[1] ?? "" })],
      [/^\s*\d+[.)]\s+(.*)$/, (m) => ({ type: "numbered", text: m[1] ?? "" })],
      [/^>\s?(.*)$/, (m) => ({ type: "quote", text: m[1] ?? "" })],
      [/^(-{3,}|\*{3,})\s*$/, () => ({ type: "divider", text: "" })],
    ]
    const rule = rules.find(([re]) => re.test(line))
    if (rule) {
      flush()
      blocks.push({ id: makeId(), ...rule[1](line.match(rule[0])!) })
    } else if (line.trim() === "") {
      flush()
    } else {
      paragraph.push(line.trim())
      if (options?.lineBreaks) flush()
    }
  }
  flush()
  return blocks
}
