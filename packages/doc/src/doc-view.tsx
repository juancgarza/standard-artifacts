import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { RobotIcon } from "@phosphor-icons/react"
import {
  actorKey,
  applyDocOp,
  imageTypes,
  isFigureType,
  isPageBlock,
  markdownToBlocks,
  newId,
  PAGE_BLOCK_ID,
  parseArtifactUrl,
  type ArtifactRef,
  type Block,
  type BlockEdit,
  type BlockPatch,
  type BlockType,
  type DocOp,
  type DocPresence,
  type DocState,
  type Member,
  type Mention,
  type MentionMode,
  type PageMeta,
} from "@standard-artifacts/protocol"
import type { RoomClient, RoomSnapshot } from "@standard-artifacts/room"
import { BrandTile, brandOf } from "@standard-artifacts/room/brands"
import { useRoom } from "@standard-artifacts/room/react"
import { isActive, useDocMentions, type DocAi } from "./ai"
import { AskBar } from "./ask-bar"
import { caretOffset, caretRect, editableText, hasSelection, selectionOffsets, setCaret } from "./caret"
import { blockAtPoint, caretAtPoint, spliceSelection } from "./cross-select"
import { bylineOf, BylineRow, DocCover, DocHeader } from "./header"
import { DocImage, Figure, type ImageUpload } from "./image-block"
import { BlockReview, DiffText, MentionBar, type Vote } from "./review"
import { SelectionBubble } from "./selection-bubble"
import { filterSlash, slashGaveUp, SlashMenu, type SlashItem } from "./slash-menu"
import { headingsOf, TableOfContents } from "./toc"

export type DocRoom = RoomClient<DocState, DocOp>
export type DocSnapshot = RoomSnapshot<DocState>

/**
 * What the host gives a doc so it can show the rest of the workspace. Previews are
 * the host's, since they need its data and its navigation; the host also decides
 * what a viewer may see, so a link to something they can't open reveals nothing.
 */
export type DocEmbeds = {
  readonly render: (ref: ArtifactRef) => ReactNode
  /** `onClose(true)` puts the caret back on the line; false when focus has already gone somewhere else. */
  readonly picker: (props: { readonly onPick: (ref: ArtifactRef) => void; readonly onClose: (refocus: boolean) => void }) => ReactNode
}

export function useDocRoom(url: string, actorKey: string) {
  return useRoom<DocState, DocOp>({ url, actorKey, apply: applyDocOp })
}

/** Typing these at the start of a paragraph turns it into another block type. */
const shortcuts: Array<[RegExp, BlockType, Partial<Block>?]> = [
  [/^#\s$/, "heading1"],
  [/^##\s$/, "heading2"],
  [/^###\s$/, "heading3"],
  [/^[-*]\s$/, "bullet"],
  [/^1[.)]\s$/, "numbered"],
  [/^\[\s?\]\s$/, "todo", { checked: false }],
  [/^\[x\]\s$/i, "todo", { checked: true }],
  [/^>\s$/, "quote"],
  [/^```$/, "code"],
  [/^---$/, "divider"],
]
const continues: ReadonlyArray<BlockType> = ["bullet", "numbered", "todo"]
const TEXT_DEBOUNCE_MS = 250
/** Height the slash menu needs below the caret before it opens upward instead. */
const MENU_ROOM_PX = 340

const typeClass: Record<BlockType, string> = {
  paragraph: "text-[16px] leading-[26px]",
  heading1: "text-[30px] leading-[38px] font-bold tracking-tight",
  heading2: "text-[24px] leading-[31px] font-semibold tracking-tight",
  heading3: "text-[20px] leading-[26px] font-semibold",
  bullet: "text-[16px] leading-[26px]",
  numbered: "text-[16px] leading-[26px]",
  todo: "text-[16px] leading-[26px]",
  quote: "text-[16px] leading-[26px] border-l-[3px] border-current pl-4",
  code: "font-mono text-[13px] leading-6 bg-surface rounded-md px-4 py-3 whitespace-pre overflow-x-auto",
  divider: "",
  image: "mt-0.5 text-[14px] leading-5 text-muted",
  embed: "mt-0.5 text-[14px] leading-5 text-muted",
}

const isHeading = (type: BlockType) => type === "heading1" || type === "heading2" || type === "heading3"

/**
 * The space above a block, which depends on what it follows: a list holds together, a
 * heading sits closer to its text than to what came before, and figures and code stand apart.
 */
const gapAbove = (type: BlockType, prev: BlockType | undefined) => {
  if (!prev) return ""
  const figure = isFigureType(type) || isFigureType(prev)
  const code = type === "code" || prev === "code"
  if (isHeading(prev)) return isFigureType(type) || type === "code" ? "mt-3" : "mt-1.5"
  if (type === "heading1") return "mt-9"
  if (type === "heading2") return "mt-7"
  if (type === "heading3" || figure) return "mt-5"
  if (code) return "mt-4"
  return type === prev && continues.includes(type) ? "mt-1" : "mt-3"
}

const placeholders: Record<BlockType, string> = {
  paragraph: "Type “/” for commands",
  heading1: "Heading 1",
  heading2: "Heading 2",
  heading3: "Heading 3",
  bullet: "List",
  numbered: "List",
  todo: "To-do",
  quote: "Quote",
  code: "Code",
  divider: "",
  image: "Add a caption",
  embed: "Add a caption",
}

/** With an agent runner available, the empty-line hint advertises Space too (Notion's "press space for AI"). */
const AI_HINT = "Write, press space for Claude, “/” for commands"
/** Cap on the selected excerpt quoted into a request about part of one block. */
const EXCERPT_MAX = 500

/** An open "/" menu: which block, where the "/" sits in its text, and what's been typed after it. */
type Slash = { blockId: string; start: number; query: string; active: number; position: { left: number; top?: number; bottom?: number } }

/**
 * An open Ask bar. `reply` writes new blocks below `target`; `edit` rewrites
 * `blocks` (the selection) in place. `excerpt` quotes a partial selection inside
 * one block, since requests are block-level. `returnTo` is where Esc puts the caret.
 */
type Ask = {
  anchor: string
  target: string
  mode: MentionMode
  blocks: ReadonlyArray<string>
  excerpt: string
  returnTo: { id: string; offset: number } | null
}

/** Blocks covered by the selection, and the bubble's spot: the selection's center and top (relative to the doc column). */
type SelectionTool = { ids: ReadonlyArray<string>; excerpt: string; x: number; top: number; width: number }

/** One request's bar: its mention (when known) and its blocks still pending review. */
type Bar = { key: string; mention: Mention | undefined; group: ReadonlyArray<Block> }

/** Suggestions group by request; ones without a mention (written by an agent outside the inbox) group by author. */
const groupKey = (b: Block) => (b.suggestion ? (b.suggestion.mentionId ?? `by:${b.suggestion.by}`) : "")

/** Attach the writer's own time and name to an edit; the reducer stamps who (see BlockEdit) and drops them from non-edits. */
function withStamp(op: DocOp, stamp: BlockEdit | undefined): DocOp {
  if (!stamp) return op
  if (op.type === "insert") return { ...op, item: { ...op.item, edited: stamp } }
  if (op.type === "update") return { ...op, patch: { ...op.patch, edited: stamp } }
  return op
}

/**
 * A live doc: a column of blocks. Each block is its own plain-text editable;
 * text syncs per block (debounced), and structure changes (split, merge, type)
 * are single ops. Presence marks which block each person or agent is in.
 *
 * `title` / `onTitleChange`: pass the artifact's title to show it as the doc's
 * heading (under the icon and cover); leave out when the host shows it elsewhere.
 *
 * `uploadImage` stores an image and returns its URL. It enables paste, drag-and-drop
 * and the image block's upload button; without it, image blocks take links only.
 * `embeds` enables linked artifacts.
 */
export function DocView({
  room,
  snapshot,
  ai,
  uploadImage,
  embeds,
  title,
  onTitleChange,
}: {
  room: DocRoom
  snapshot: DocSnapshot
  ai?: DocAi
  uploadImage?: (file: Blob) => Promise<string>
  embeds?: DocEmbeds
  title?: string
  onTitleChange?: (title: string) => void
}) {
  const { state, self, others, status } = snapshot
  const readOnly = self?.readOnly ?? true
  // Read-only viewers see suggestions but can't ask or review, so they don't poll the inbox either.
  const canAsk = !!ai && !readOnly
  const items = useMemo(() => state?.items ?? [], [state])
  /** The doc's header (icon, cover) lives on a reserved record that isn't a block on screen. */
  const pageBlock = useMemo(() => items.find(isPageBlock), [items])
  const blocks = useMemo(() => items.filter((b) => !isPageBlock(b)), [items])
  const page: PageMeta = pageBlock?.page ?? {}
  const byline = useMemo(() => bylineOf(items), [items])
  const bylineRow = <BylineRow byline={byline} self={self} members={others} />
  // With no title in the editor, a leading Heading 1 reads as the title, so the byline goes under it.
  const bylineAfter = title === undefined && blocks[0]?.type === "heading1" ? blocks[0].id : null
  const headings = useMemo(() => headingsOf(blocks), [blocks])
  const [flashId, setFlashId] = useState<string | null>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const column = useRef<HTMLDivElement>(null)
  /** The scrolling page: a drag that starts in its margin (beside the text column) is how people select across blocks. */
  const root = useRef<HTMLDivElement>(null)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  /** Each block's text as last typed, while its sync is waiting on `timers`. */
  const drafts = useRef(new Map<string, string>())
  const focusRequest = useRef<{ id: string; offset: number } | null>(null)
  const [slash, setSlash] = useState<Slash | null>(null)
  const canEmbed = !!embeds
  const slashMatches = useMemo(() => (slash ? filterSlash(slash.query).filter((i) => canEmbed || i.type !== "embed") : []), [slash, canEmbed])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [askBusy, setAskBusy] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [selectionTool, setSelectionTool] = useState<SelectionTool | null>(null)
  /** Requests this tab filed: their bars take focus, and their outcome shows even when nothing was written. */
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set())
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const [votes, setVotes] = useState<Readonly<Record<string, Vote>>>({})
  /** Requests that have had suggestions; once those are reviewed the bar goes away instead of turning into a summary. */
  const hadSuggestions = useRef(new Set<string>())
  /** This tab's uploads, by image block: gone once the block has its src. */
  const [uploads, setUploads] = useState<Readonly<Record<string, ImageUpload>>>({})
  const fileInput = useRef<HTMLInputElement>(null)
  /** The image block the open file picker is for. */
  const pickFor = useRef<string | null>(null)
  /** The block the open artifact picker will fill. */
  const [embedPick, setEmbedPick] = useState<string | null>(null)

  const stamp = useRef<() => BlockEdit | undefined>(() => undefined)
  stamp.current = () => (self && !readOnly ? { by: actorKey(self.actor), at: Date.now(), ...(self.name && { name: self.name }) } : undefined)
  const send = useCallback((op: DocOp) => room.send(withStamp(op, stamp.current())), [room])
  const update = useCallback((id: string, patch: BlockPatch) => send({ type: "update", id, patch }), [send])

  /** Pending suggestions, grouped by request, in doc order. */
  const groups = useMemo(() => {
    const map = new Map<string, Array<Block>>()
    for (const b of blocks) {
      const key = groupKey(b)
      if (key) map.set(key, [...(map.get(key) ?? []), b])
    }
    return map
  }, [blocks])
  useEffect(() => {
    for (const key of groups.keys()) hadSuggestions.current.add(key)
  }, [groups])

  const agents = useMemo(() => others.filter((m) => m.actor.type === "agent"), [others])
  // New suggestion groups or an agent starting to think mean a request we haven't seen (another tab, "@claude" in a block).
  const wake = `${[...groups.keys()].join(",")}|${agents
    .filter((m) => (m.presence as DocPresence).thinking)
    .map((m) => m.connectionId)
    .join(",")}`
  const { mentions, track } = useDocMentions(canAsk ? ai : undefined, wake)

  /** Each request's bar, keyed by the block it sits under: the last pending block, else the request's own block. */
  const bars = useMemo(() => {
    const byId = new Map(mentions.map((m) => [m.id, m]))
    const exists = new Set(blocks.map((b) => b.id))
    const out = new Map<string, Array<Bar>>()
    const place = (anchor: string | undefined, bar: Bar) => {
      const id = anchor && exists.has(anchor) ? anchor : blocks.at(-1)?.id
      if (id) out.set(id, [...(out.get(id) ?? []), bar])
    }
    for (const [key, group] of groups) place(group.at(-1)?.id, { key, mention: byId.get(key), group })
    for (const m of mentions) {
      if (groups.has(m.id) || dismissed.has(m.id)) continue
      // Working requests always show. A finished one shows only to the tab that asked (its error, or a
      // summary when nothing was written), never after its suggestions were reviewed, and not once stopped.
      const outcome = asked.has(m.id) && !hadSuggestions.current.has(m.id) && m.status !== "cancelled"
      if (!isActive(m) && !outcome) continue
      const anchor = m.mode === "edit" ? [...m.blocks].reverse().find((id) => exists.has(id)) : m.target.type === "block" ? m.target.id : undefined
      place(anchor, { key: m.id, mention: m, group: [] })
    }
    return out
  }, [mentions, groups, blocks, dismissed, asked])

  const activeKeys = useMemo(() => new Set(mentions.filter(isActive).map((m) => m.id)), [mentions])

  /** The runner shows presence as run "mention-<id>" (`stdartifacts agent serve`); other runners fall back to any thinking agent. */
  const agentFor = (bar: Bar, anchor: string) =>
    agents.find((m) => m.connectionId === `agent:mention-${bar.key}`) ??
    agents.find((m) => {
      const p = m.presence as DocPresence
      return p.thinking && (p.blockId === anchor || bar.group.some((b) => b.id === p.blockId))
    })

  /**
   * Push a block's pending text now (before a structural op, on blur, on unmount or
   * when a tab hides it). Sends the text as last typed rather than reading the block:
   * by the time a page's cleanup runs, React has detached its refs and hidden its DOM.
   */
  const flush = useCallback(
    (id: string) => {
      const t = timers.current.get(id)
      if (!t) return
      clearTimeout(t)
      timers.current.delete(id)
      const text = drafts.current.get(id)
      drafts.current.delete(id)
      const block = room.getSnapshot().state?.items.find((b) => b.id === id)
      if (text !== undefined && block && text !== block.text) update(id, { text })
    },
    [room, update],
  )

  /** Drop a block's pending text sync because the caller is about to write the text itself. */
  const cancelPending = (id: string) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    drafts.current.delete(id)
  }

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const id of [...pending.keys()]) flush(id)
    }
  }, [flush])

  const focusBlock = (id: string, offset: number) => {
    const el = els.current.get(id)
    if (el) setCaret(el, offset)
    else focusRequest.current = { id, offset }
  }

  // Apply a pending focus request once the target block has rendered.
  useLayoutEffect(() => {
    const req = focusRequest.current
    if (!req) return
    const el = els.current.get(req.id)
    if (el) {
      focusRequest.current = null
      setCaret(el, req.offset)
    }
  })

  /** Re-read the "/query" from the block after typing or caret moves; close the menu when it no longer applies. */
  const syncSlash = useCallback((s: Slash) => {
    const el = els.current.get(s.blockId)
    const offset = el && document.activeElement === el ? caretOffset(el) : null
    const text = el ? editableText(el) : ""
    if (offset === null || offset <= s.start || text[s.start] !== "/") return setSlash(null)
    const query = text.slice(s.start + 1, offset)
    if (slashGaveUp(query)) return setSlash(null)
    if (query !== s.query) setSlash({ ...s, query, active: 0 })
  }, [])

  // Arrow keys and clicks move the caret without an input event; follow them too.
  useEffect(() => {
    if (!slash) return
    const onSelection = () => syncSlash(slash)
    document.addEventListener("selectionchange", onSelection)
    return () => document.removeEventListener("selectionchange", onSelection)
  }, [slash, syncSlash])

  const openSlash = (block: Block, el: HTMLElement, start: number) => {
    const wrapper = el.closest<HTMLElement>("[data-block-id]")
    if (!wrapper) return
    const caret = caretRect(el)
    const box = wrapper.getBoundingClientRect()
    const left = Math.max(0, caret.left - box.left - 8)
    const below = window.innerHeight - caret.bottom >= MENU_ROOM_PX || caret.top < MENU_ROOM_PX
    const position = below ? { left, top: caret.bottom - box.top + 6 } : { left, bottom: box.bottom - caret.top + 6 }
    setSlash({ blockId: block.id, start, query: "", active: 0, position })
  }

  /** Turn the block into `item`, dropping the "/query" text and keeping the caret where the "/" was. */
  const chooseSlash = (item: SlashItem) => {
    const s = slash
    setSlash(null)
    if (!s) return
    const block = blocks.find((b) => b.id === s.blockId)
    const el = els.current.get(s.blockId)
    if (!block || !el) return
    const text = editableText(el)
    const rest = text.slice(0, s.start) + text.slice(s.start + 1 + s.query.length)
    cancelPending(block.id)

    if (item.type === "divider") {
      // An empty block becomes the divider; a block with text keeps it and gets a divider below.
      // Either way a fresh paragraph follows so there's somewhere to keep typing.
      const para = newId("k_")
      if (rest === "") {
        update(block.id, { type: "divider", text: "" })
        send({ type: "insert", item: { id: para, type: "paragraph", text: "" }, after: block.id })
      } else {
        el.textContent = rest
        update(block.id, { text: rest })
        const divider = newId("k_")
        send({ type: "insert", item: { id: divider, type: "divider", text: "" }, after: block.id })
        send({ type: "insert", item: { id: para, type: "paragraph", text: "" }, after: divider })
      }
      return focusBlock(para, 0)
    }

    if (item.type === "image") {
      // Same rule as the divider: an empty block becomes the image, a block with text keeps it. The caption takes the caret.
      el.textContent = rest
      if (rest === "") {
        update(block.id, { type: "image", text: "" })
        return pickImage(block.id)
      }
      update(block.id, { text: rest })
      const id = newId("k_")
      send({ type: "insert", item: { id, type: "image", text: "" }, after: block.id })
      focusBlock(id, 0)
      return pickImage(id)
    }

    if (item.type === "embed") {
      // Nothing changes until something is picked; closing the picker leaves an ordinary line.
      el.textContent = rest
      update(block.id, { text: rest })
      return setEmbedPick(block.id)
    }

    el.textContent = rest
    update(block.id, { type: item.type, text: rest, ...(item.type === "todo" && block.type !== "todo" && { checked: false }) })
    setCaret(el, s.start)
  }

  // --- Images ---------------------------------------------------------------------------

  const pickImage = (id: string) => {
    if (!uploadImage || readOnly) return
    pickFor.current = id
    fileInput.current?.click()
  }

  const setUpload = (id: string, upload: ImageUpload | null) =>
    setUploads((prev) => {
      const { [id]: _done, ...rest } = prev
      return upload ? { ...rest, [id]: upload } : rest
    })

  /** Upload into an image block. The block may be gone by the time it finishes (deleted, or by someone else). */
  const uploadInto = (id: string, file: Blob) => {
    if (!uploadImage) return
    setUpload(id, { status: "uploading" })
    uploadImage(file).then(
      (src) => {
        setUpload(id, null)
        if (room.getSnapshot().state?.items.some((b) => b.id === id)) update(id, { src })
      },
      (err: unknown) => setUpload(id, { status: "failed", message: err instanceof Error ? err.message : "Upload failed" }),
    )
  }

  /** New image blocks for pasted or dropped files, after a block (null: at the top). An empty paragraph there becomes the first. */
  const placeImages = (files: ReadonlyArray<File>, after: string | null) => {
    if (!uploadImage || readOnly) return
    let anchor = after
    files.forEach((file, i) => {
      const line = i === 0 ? blocks.find((b) => b.id === after) : undefined
      const lineEl = line && els.current.get(line.id)
      if (line?.type === "paragraph" && lineEl && !line.suggestion && editableText(lineEl) === "") {
        cancelPending(line.id)
        update(line.id, { type: "image" })
        return uploadInto(line.id, file)
      }
      const id = newId("k_")
      send({ type: "insert", item: { id, type: "image", text: "" }, after: anchor })
      anchor = id
      uploadInto(id, file)
    })
  }

  const focusFigure = (id: string) => root.current?.querySelector<HTMLElement>(`[data-block-id="${id}"] [data-doc-figure]`)?.focus()

  /** Remove an image or a linked artifact and put the caret in the text nearest to it. */
  const removeFigure = (id: string) => {
    const index = blocks.findIndex((b) => b.id === id)
    const target = textNeighbor(index, -1) ?? textNeighbor(index, 1)
    send({ type: "remove", ids: [id] })
    if (target) focusBlock(target.id, Number.MAX_SAFE_INTEGER)
  }

  /** Link an artifact from `id`: an empty line (or an embed with nothing linked) becomes it; a line with text keeps it and gets it below. */
  const placeEmbed = (id: string, ref: ArtifactRef) => {
    setEmbedPick(null)
    const block = blocks.find((b) => b.id === id)
    const el = els.current.get(id)
    if (block?.type === "embed" || (block?.type === "paragraph" && !block.suggestion && el && editableText(el) === "")) {
      cancelPending(id)
      update(id, { type: "embed", ref })
      return focusBlock(id, 0)
    }
    const next = newId("k_")
    send({ type: "insert", item: { id: next, type: "embed", text: "", ref }, after: id })
    focusBlock(next, 0)
  }

  const imageFiles = (data: DataTransfer) => [...data.files].filter((f) => f.type.startsWith("image/"))

  const onDragOverFiles = (e: DragEvent<HTMLElement>) => {
    if (readOnly || !uploadImage || !e.dataTransfer.types.includes("Files")) return
    // Without this the browser opens a dropped file in place of the app.
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }

  const onDropFiles = (e: DragEvent<HTMLElement>) => {
    if (readOnly || !uploadImage || !e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    // Goes after the last block whose middle is above the pointer.
    let after: string | null = null
    for (const b of blocks) {
      const box = root.current?.querySelector(`[data-block-id="${b.id}"]`)?.getBoundingClientRect()
      if (box && (box.top + box.bottom) / 2 < e.clientY) after = b.id
    }
    placeImages(imageFiles(e.dataTransfer), after)
  }

  // --- Ask Claude -----------------------------------------------------------------------

  /** Blocks the current selection covers inside the doc (a drag ending at the very start of a block doesn't count that block). */
  const selectedBlocks = useCallback((): { ids: Array<string>; excerpt: string; range: Range } | null => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    // No containment check: each block is its own editable, so a selection spanning blocks starts outside them
    // (a drag from the page margin), and Chrome may anchor it as far up as the page header. What counts is which blocks it covers.
    const ids = blocks.flatMap((b) => {
      const editable = els.current.get(b.id)
      // A pending rewrite shows its diff while the editable sits hidden; the diff is what gets selected.
      const el = editable?.parentElement?.querySelector<HTMLElement>("[data-diff]") ?? editable
      if (b.type === "divider" || !el || !range.intersectsNode(el)) return []
      const part = document.createRange()
      part.selectNodeContents(el)
      if (el.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset)
      if (el.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset)
      return part.toString().length > 0 ? [b.id] : []
    })
    if (!ids.length) return null
    const only = ids.length === 1 ? blocks.find((b) => b.id === ids[0]) : undefined
    const picked = sel.toString().trim()
    // Requests rewrite whole blocks, so a partial selection inside one block is quoted to say what to focus on.
    const excerpt = only && picked && picked !== only.text.trim() ? picked.slice(0, EXCERPT_MAX) : ""
    return { ids, excerpt, range }
  }, [blocks])

  const openAsk = (next: Ask) => {
    setSlash(null)
    setSelectionTool(null)
    setAskError(null)
    setAsk(next)
  }

  const closeAsk = useCallback(
    (restoreCaret: boolean) => {
      setAsk(null)
      setAskError(null)
      const back = ask?.returnTo
      if (restoreCaret && back) {
        const el = els.current.get(back.id)
        if (el) setCaret(el, back.offset)
      }
    },
    [ask],
  )

  /** ⌘J: edit the selection if there is one, else ask about the doc from the block with the caret (or the end). */
  const askHere = () => {
    const picked = selectedBlocks()
    if (picked) {
      const [first] = picked.ids
      const last = picked.ids.at(-1)
      if (first && last) return openAsk({ anchor: last, target: first, mode: "edit", blocks: picked.ids, excerpt: picked.excerpt, returnTo: null })
    }
    const focused = [...els.current].find(([, el]) => el === document.activeElement)
    const id = focused?.[0] ?? blocks.at(-1)?.id
    if (!id) return
    openAsk({ anchor: id, target: id, mode: "reply", blocks: [], excerpt: "", returnTo: focused ? { id, offset: caretOffset(focused[1]) ?? 0 } : null })
  }
  const askHereRef = useRef(askHere)
  askHereRef.current = askHere

  // ⌘J (Ctrl+J) anywhere in the doc toggles the bar, as in Notion. Listened on the document so it also works
  // with nothing focused, but only when focus isn't in some other input on the page.
  useEffect(() => {
    if (!canAsk) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "j") return
      const t = e.target
      const inDoc = t instanceof Node && !!root.current?.contains(t)
      if (!inDoc && t !== document.body) return
      e.preventDefault()
      if (ask) closeAsk(true)
      else askHereRef.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [canAsk, ask, closeAsk])

  // The selection bubble ("Ask Claude", "Turn into") follows any text selection in the doc.
  useEffect(() => {
    if (readOnly || ask) return setSelectionTool(null)
    const onChange = () => {
      const picked = selectedBlocks()
      const col = column.current
      if (!picked || !col) return setSelectionTool(null)
      const rect = picked.range.getBoundingClientRect()
      const box = col.getBoundingClientRect()
      // A cross-block selection's range can start above the doc (see selectedBlocks); sit on its first block instead.
      const first = els.current.get(picked.ids[0] ?? "")?.getBoundingClientRect()
      const top = Math.max(rect.top, first?.top ?? rect.top)
      // Center over the selection; a drag from the margin starts left of the text, so don't let it pull the bar out.
      const from = Math.max(rect.left, first?.left ?? rect.left)
      const x = (from + Math.min(rect.right, box.right)) / 2 - box.left
      setSelectionTool({ ids: picked.ids, excerpt: picked.excerpt, x, top: top - box.top, width: box.width })
    }
    document.addEventListener("selectionchange", onChange)
    return () => document.removeEventListener("selectionchange", onChange)
  }, [readOnly, ask, selectedBlocks])

  /** "Turn into" from the selection bubble: every selected block takes the type (todos start unchecked). */
  const turnInto = (ids: ReadonlyArray<string>, type: BlockType) => {
    for (const id of ids) {
      const b = blocks.find((x) => x.id === id)
      if (!b || b.type === "divider" || isFigureType(b.type) || b.type === type) continue
      flush(id)
      update(id, { type, ...(type === "todo" && b.checked === undefined && { checked: false }) })
    }
  }

  /** Set the doc's icon or cover. The header record is created the first time. */
  const setPage = (next: PageMeta) => {
    if (pageBlock) return update(pageBlock.id, { page: next })
    send({ type: "insert", item: { id: PAGE_BLOCK_ID, type: "paragraph", text: "", page: next }, after: null })
  }

  /** Scroll a heading near the top of the page (from the outline) and flash it so the eye lands on it. */
  const jumpTo = (id: string) => {
    const r = root.current
    const el = r?.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
    if (!r || !el) return
    r.scrollTo({ top: r.scrollTop + el.getBoundingClientRect().top - r.getBoundingClientRect().top - 72, behavior: "smooth" })
    setFlashId(id)
  }
  useEffect(() => {
    if (!flashId) return
    const t = setTimeout(() => setFlashId(null), 1200)
    return () => clearTimeout(t)
  }, [flashId])
  const headingEl = useCallback((id: string) => els.current.get(id), [])

  // --- Selecting across blocks (see cross-select.ts) -------------------------------------

  const drag = useRef<{ x: number; y: number; block: string; crossed: boolean; to?: { x: number; y: number } } | null>(null)

  /** Draw the cross-block selection from the drag's start to `to`, with no editable holding focus. */
  const selectAcross = (d: { x: number; y: number }, to: { x: number; y: number }) => {
    const from = caretAtPoint(d.x, d.y)
    const end = caretAtPoint(to.x, to.y)
    if (!from || !end) return
    if (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)) document.activeElement.blur()
    window.getSelection()?.setBaseAndExtent(from.node, from.offset, end.node, end.offset)
  }

  const onDragStart = (e: ReactPointerEvent) => {
    if (e.button !== 0 || e.shiftKey) return
    const t = e.target instanceof HTMLElement ? e.target : null
    const block = t?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId
    drag.current = block && t?.closest("[contenteditable]") ? { x: e.clientX, y: e.clientY, block, crossed: false } : null
  }

  const onDragMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || !(e.buttons & 1)) return
    const over = blockAtPoint(e.clientX, e.clientY)
    if (!d.crossed && (!over || over === d.block)) return
    if (!d.crossed) {
      // Leaving the start block: let go of its editable so the selection can span blocks.
      d.crossed = true
      flush(d.block)
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
    const to = { x: e.clientX, y: e.clientY }
    d.to = to
    // After the browser's own handling of this move, which would clamp the selection back into the start block.
    requestAnimationFrame(() => selectAcross(d, to))
  }

  const onDragEnd = () => {
    const d = drag.current
    drag.current = null
    // On mouse-up the browser snaps the selection back into the start block and re-focuses it; draw it once more after that.
    if (d?.crossed && d.to) {
      const to = d.to
      requestAnimationFrame(() => selectAcross(d, to))
    }
  }

  /**
   * Backspace, Delete, typing, Enter and ⌘X on a selection that spans blocks: merge
   * the first and last blocks around it and drop the ones between (dividers included).
   */
  const editAcrossRef = useRef<(e: globalThis.KeyboardEvent) => void>(() => {})
  editAcrossRef.current = (e) => {
    if (readOnly || e.defaultPrevented || e.isComposing) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !root.current?.contains(active)) return
    const picked = selectedBlocks()
    if (!picked || picked.ids.length < 2) return
    const mod = e.metaKey || e.ctrlKey
    let insert: string
    let split = false
    if (e.key === "Backspace" || e.key === "Delete") insert = ""
    else if (mod && !e.shiftKey && e.key.toLowerCase() === "x") {
      void navigator.clipboard?.writeText(window.getSelection()?.toString() ?? "")
      insert = ""
    } else if (e.key === "Enter" && !mod) {
      insert = ""
      split = true
    } else if (!mod && !e.altKey && e.key.length === 1) insert = e.key
    else return
    const textOf = (id: string) => {
      const el = els.current.get(id)
      return el ? editableText(el) : (blocks.find((b) => b.id === id)?.text ?? "")
    }
    const splice = spliceSelection(picked.range, picked.ids, els.current, textOf, insert)
    if (!splice) return
    e.preventDefault()
    const from = blocks.findIndex((b) => b.id === splice.keep)
    const to = blocks.findIndex((b) => b.id === picked.ids.at(-1))
    const removed = blocks.slice(from + 1, to + 1).map((b) => b.id)
    for (const id of [splice.keep, ...removed]) cancelPending(id)
    window.getSelection()?.removeAllRanges()
    const head = split ? splice.text.slice(0, splice.caret) : splice.text
    // Focused blocks don't take text from state, so write the merge into the editable before focusing it.
    const el = els.current.get(splice.keep)
    if (el) el.textContent = head
    update(splice.keep, { text: head })
    if (removed.length) send({ type: "remove", ids: removed })
    if (split) {
      const next = newId("k_")
      send({ type: "insert", item: { id: next, type: "paragraph", text: splice.text.slice(splice.caret) }, after: splice.keep })
      return focusBlock(next, 0)
    }
    focusBlock(splice.keep, splice.caret)
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => editAcrossRef.current(e)
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const submitAsk = (prompt: string) => {
    const a = ask
    if (!a || !ai) return
    // The runner reads the doc from the server, so push any typing it hasn't seen yet.
    flush(a.target)
    for (const id of a.blocks) flush(id)
    setAskBusy(true)
    setAskError(null)
    const text = a.excerpt ? `${prompt}\n\nFocus on this part: "${a.excerpt}"` : prompt
    ai.ask({ target: { type: "block", id: a.target }, text, mode: a.mode, ...(a.mode === "edit" && { blocks: [...a.blocks] }) })
      .then((m) => {
        track(m)
        setAsked((prev) => new Set(prev).add(m.id))
        // Closing drops focus to the page, and the new request's bar picks it up (Esc stops, ⌘↵ accepts).
        setAsk(null)
      })
      .catch((e: unknown) => setAskError(e instanceof Error ? e.message : "Couldn't reach Claude"))
      .finally(() => setAskBusy(false))
  }

  // --- Review -----------------------------------------------------------------------------

  const dismiss = (key: string) => setDismissed((prev) => new Set(prev).add(key))

  const acceptBlocks = (list: ReadonlyArray<Block>) => {
    for (const b of list) if (b.suggestion) update(b.id, { suggestion: null })
  }

  /** Inserted blocks go away; rewritten ones get their original text back. */
  const discardBlocks = (list: ReadonlyArray<Block>) => {
    const inserted = list.filter((b) => b.suggestion?.kind === "insert").map((b) => b.id)
    if (inserted.length) send({ type: "remove", ids: inserted })
    for (const b of list) {
      if (b.suggestion?.kind !== "replace") continue
      const original = b.suggestion.original ?? b.text
      cancelPending(b.id)
      // A focused block doesn't take text from state, so write the DOM too.
      const el = els.current.get(b.id)
      if (el) el.textContent = original
      update(b.id, { text: original, suggestion: null })
    }
  }

  const accept = (bar: Bar) => {
    acceptBlocks(bar.group)
    dismiss(bar.key)
    // A reply to an empty line takes that line's place (Notion writes where you pressed space).
    const t = bar.mention?.mode === "reply" ? bar.mention.target : undefined
    const at = t?.type === "block" ? blocks.findIndex((b) => b.id === t.id) : -1
    const line = blocks[at]
    const lineEl = line && els.current.get(line.id)
    const empty = line && line.type === "paragraph" && !line.suggestion && (lineEl ? editableText(lineEl) : line.text) === ""
    if (line && empty && blocks[at + 1]?.id === bar.group[0]?.id) send({ type: "remove", ids: [line.id] })
    const last = bar.group.at(-1)
    if (last && last.type !== "divider") focusBlock(last.id, Number.MAX_SAFE_INTEGER)
  }

  const discard = (bar: Bar) => {
    discardBlocks(bar.group)
    dismiss(bar.key)
    const t = bar.mention?.target
    const back = bar.mention?.mode === "edit" ? bar.mention.blocks.at(-1) : t?.type === "block" ? t.id : undefined
    if (back && els.current.has(back)) focusBlock(back, Number.MAX_SAFE_INTEGER)
  }

  /** Discard, then file the same request again (same prompt, mode, target and blocks). */
  const retry = (bar: Bar) => {
    const m = bar.mention
    if (!m || !ai) return
    discardBlocks(bar.group)
    dismiss(bar.key)
    ai.ask({ target: m.target, text: m.text, mode: m.mode, ...(m.mode === "edit" && { blocks: [...m.blocks] }) })
      .then((next) => {
        track(next)
        setAsked((prev) => new Set(prev).add(next.id))
      })
      .catch(() => {
        // Bring the old bar back so the person can see what they were reviewing failed to re-run.
        setDismissed((prev) => {
          const next = new Set(prev)
          next.delete(bar.key)
          return next
        })
      })
  }

  /**
   * Edit requests only: keep every original as it was and add Claude's version
   * as new, accepted blocks right after the last rewritten block. Blocks the
   * agent appended on top of its rewrites are accepted where they are.
   */
  const insertBelow = (bar: Bar) => {
    const rewritten = bar.group.filter((b) => b.suggestion?.kind === "replace")
    let after = rewritten.at(-1)?.id
    if (!after) return accept(bar)
    for (const b of rewritten) {
      const id = newId("k_")
      send({ type: "insert", item: { id, type: b.type, text: b.text, ...(b.checked !== undefined && { checked: b.checked }), ...(b.src !== undefined && { src: b.src }), ...(b.ref !== undefined && { ref: b.ref }) }, after })
      after = id
    }
    discardBlocks(rewritten)
    acceptBlocks(bar.group.filter((b) => b.suggestion?.kind === "insert"))
    dismiss(bar.key)
  }

  const stop = (m: Mention) => {
    if (!ai) return
    // Show it stopped right away; the runner notices on its next poll and leaves what it wrote for review.
    track({ ...m, status: "cancelled" })
    ai.cancel(m.id).then(track, () => track(m))
  }

  /** Typing into a pending block means the person is taking it over: that accepts it. */
  const own = (block: Block) => {
    if (block.suggestion && !readOnly) update(block.id, { suggestion: null })
  }

  const presenceByBlock = useMemo(() => {
    const map = new Map<string, Member[]>()
    for (const m of others) {
      const id = (m.presence as DocPresence).blockId
      if (id) map.set(id, [...(map.get(id) ?? []), m])
    }
    return map
  }, [others])

  const onInput = (block: Block, el: HTMLElement, typed: string | null) => {
    own(block)
    const text = editableText(el)
    // Deleting the last character leaves a stray <br>, which hides the :empty placeholder.
    if (text === "" && el.firstChild) el.replaceChildren()
    if (block.type === "paragraph") {
      for (const [re, type, extra] of shortcuts) {
        if (re.test(text)) {
          el.textContent = ""
          cancelPending(block.id)
          update(block.id, { type, text: "", ...extra })
          if (type === "divider") {
            const id = newId("k_")
            send({ type: "insert", item: { id, type: "paragraph", text: "" }, after: block.id })
            focusBlock(id, 0)
          }
          return
        }
      }
    }
    if (slash?.blockId === block.id) syncSlash(slash)
    else if (typed === "/" && block.type !== "code" && !isFigureType(block.type)) {
      // Like Notion: "/" opens the menu at the start of a block or after a space, not inside a word or URL.
      const offset = caretOffset(el)
      if (offset !== null && text[offset - 1] === "/" && (offset === 1 || /\s/.test(text[offset - 2] ?? ""))) openSlash(block, el, offset - 1)
    }
    clearTimeout(timers.current.get(block.id))
    drafts.current.set(block.id, editableText(el))
    timers.current.set(
      block.id,
      setTimeout(() => {
        timers.current.delete(block.id)
        drafts.current.delete(block.id)
        update(block.id, { text: editableText(el) })
      }, TEXT_DEBOUNCE_MS),
    )
  }

  /**
   * Multi-line paste splits into blocks (markdown-aware: "- a" becomes a bullet),
   * the way Notion does. The first line joins the block being pasted into; the
   * text after the caret moves to the end of the last pasted block.
   */
  const onPaste = (block: Block, e: ClipboardEvent<HTMLElement>) => {
    // A screenshot on the clipboard. Spreadsheets and Word copy text along with a picture of it; the text is what's meant.
    const images = imageFiles(e.clipboardData)
    if (images.length && uploadImage && !e.clipboardData.getData("text/plain")) {
      e.preventDefault()
      own(block)
      flush(block.id)
      return placeImages(images, block.id)
    }
    // A link to something in this workspace, on a line of its own, becomes its preview. In a sentence it stays a link.
    const linked = embeds && parseArtifactUrl(e.clipboardData.getData("text/plain"), window.location.origin)
    if (linked && block.type === "paragraph" && editableText(e.currentTarget) === "") {
      e.preventDefault()
      return placeEmbed(block.id, linked)
    }
    // Code keeps newlines literally; single lines paste as plain text natively.
    if (block.type === "code") return
    const pasted = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n").replace(/\n+$/, "")
    if (!pasted.includes("\n")) return
    const el = e.currentTarget
    const sel = selectionOffsets(el)
    const parsed = markdownToBlocks(pasted, () => newId("k_"), { lineBreaks: true })
    const [first, ...rest] = parsed
    if (!sel || !first) return
    e.preventDefault()
    own(block)
    setSlash(null)
    const text = editableText(el)
    const before = text.slice(0, sel.start)
    const after = text.slice(sel.end)
    cancelPending(block.id)

    // An empty paragraph takes the first pasted block's type; otherwise plain lines join the block and the rest follow it.
    const adopt = block.type === "paragraph" && before === ""
    const merge = adopt || first.type === "paragraph"
    const headType = adopt ? first.type : block.type
    const headText = headType === "divider" ? "" : merge ? before + first.text : before
    const queue = merge ? rest : parsed
    // The caret, and the text that was after it, end up in the last pasted block, so that one must hold body text.
    const tailType = queue.length === 0 ? headType : queue.at(-1)?.type
    if (tailType === "divider" || (tailType && isFigureType(tailType))) queue.push({ id: newId("k_"), type: "paragraph", text: "" })
    const last = queue.at(-1)
    const head: BlockPatch = {
      text: last ? headText : headText + after,
      ...(adopt && { type: first.type, ...(first.checked !== undefined && { checked: first.checked }), ...(first.src !== undefined && { src: first.src }), ...(first.ref !== undefined && { ref: first.ref }) }),
    }
    if (headType !== "divider") el.textContent = head.text ?? ""
    update(block.id, head)
    let anchor = block.id
    for (const item of queue) {
      send({ type: "insert", item: item === last ? { ...item, text: item.text + after } : item, after: anchor })
      anchor = item.id
    }
    focusBlock(last?.id ?? block.id, last ? last.text.length : headText.length)
  }

  /** The nearest block above or below that holds text (arrow keys step over dividers). */
  const textNeighbor = (index: number, step: 1 | -1) => {
    for (let j = index + step; j >= 0 && j < blocks.length; j += step) {
      const b = blocks[j]
      if (b && b.type !== "divider") return b
    }
    return undefined
  }

  const onKeyDown = (block: Block, index: number, e: KeyboardEvent<HTMLElement>) => {
    const el = e.currentTarget

    if (slash?.blockId === block.id) {
      const n = slashMatches.length
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        if (n) setSlash({ ...slash, active: (slash.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n })
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && n) {
        e.preventDefault()
        const item = slashMatches[slash.active] ?? slashMatches[0]
        if (item) chooseSlash(item)
        return
      }
      if (e.key === "Escape") {
        // Close but keep the typed "/query" as text, like Notion.
        e.preventDefault()
        return setSlash(null)
      }
      if (e.key === "Enter") setSlash(null)
    }

    const text = editableText(el)
    const offset = caretOffset(el) ?? text.length
    const prev = blocks[index - 1]
    const next = blocks[index + 1]

    // Space on an empty line asks Claude (Notion's "press space for AI"); with text, Space is just a space.
    if (e.key === " " && canAsk && text === "" && block.type !== "code" && !isFigureType(block.type) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      return openAsk({ anchor: block.id, target: block.id, mode: "reply", blocks: [], excerpt: "", returnTo: { id: block.id, offset: 0 } })
    }

    if (block.suggestion && !readOnly) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && block.type !== "code") {
        // ⌘↵ inside a pending block accepts its whole request, like the review bar.
        e.preventDefault()
        const key = groupKey(block)
        return accept({ key, mention: mentions.find((m) => m.id === key), group: groups.get(key) ?? [block] })
      }
      // Splitting, merging or deleting a pending block is taking it over too.
      if (e.key === "Enter" || e.key === "Backspace" || e.key === "Delete") own(block)
    }

    // A caption isn't body text: Enter leaves it instead of splitting, and nothing merges into or out of it.
    if (isFigureType(block.type)) {
      if (e.key === "Enter") {
        e.preventDefault()
        flush(block.id)
        const id = newId("k_")
        send({ type: "insert", item: { id, type: "paragraph", text: "" }, after: block.id })
        return focusBlock(id, 0)
      }
      if (e.key === "Backspace" && offset === 0 && !hasSelection(el)) {
        e.preventDefault()
        flush(block.id)
        return focusFigure(block.id)
      }
      if (e.key === "Delete" && offset === text.length && !hasSelection(el)) return e.preventDefault()
    }

    if (block.type === "code") {
      if (e.key === "Tab" && !e.shiftKey) {
        // Indent inside code instead of moving focus out of the doc. execCommand keeps native undo.
        e.preventDefault()
        document.execCommand("insertText", false, "  ")
        return
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        // Enter types a newline in code, so Mod+Enter is the way out to a new paragraph below.
        e.preventDefault()
        flush(block.id)
        const id = newId("k_")
        send({ type: "insert", item: { id, type: "paragraph", text: "" }, after: block.id })
        return focusBlock(id, 0)
      }
    }

    if (e.key === "Enter" && !e.shiftKey && block.type !== "code") {
      e.preventDefault()
      // Enter on an empty list item ends the list, like most editors.
      if (continues.includes(block.type) && text === "") return update(block.id, { type: "paragraph" })
      const type: BlockType = continues.includes(block.type) ? block.type : "paragraph"
      if (offset === 0 && text !== "" && !hasSelection(el)) {
        // Enter at the very start opens a line above and leaves this block (a heading, say) as it is.
        flush(block.id)
        send({ type: "insert", item: { id: newId("k_"), type, text: "", ...(type === "todo" && { checked: false }) }, after: prev?.id ?? null })
        return
      }
      const before = text.slice(0, offset)
      const after = text.slice(offset)
      cancelPending(block.id)
      el.textContent = before
      if (before !== block.text) update(block.id, { text: before })
      const id = newId("k_")
      send({ type: "insert", item: { id, type, text: after, ...(type === "todo" && { checked: false }) }, after: block.id })
      return focusBlock(id, 0)
    }

    if (e.key === "Backspace" && offset === 0 && !hasSelection(el)) {
      if (block.type !== "paragraph") {
        e.preventDefault()
        return update(block.id, { type: "paragraph" })
      }
      if (!prev) return
      e.preventDefault()
      flush(block.id)
      if (prev.type === "divider") return send({ type: "remove", ids: [prev.id] })
      if (isFigureType(prev.type)) {
        // Select it rather than delete it: losing a picture to one Backspace is too easy. An empty line goes away.
        if (text === "") send({ type: "remove", ids: [block.id] })
        return focusFigure(prev.id)
      }
      flush(prev.id)
      // Read the previous block from the DOM (it may hold unsent typing) and write the merge there
      // too: the block is about to be focused, and focused blocks don't take text from state.
      const prevEl = els.current.get(prev.id)
      const head = prevEl ? editableText(prevEl) : prev.text
      if (prevEl) prevEl.textContent = head + text
      update(prev.id, { text: head + text })
      send({ type: "remove", ids: [block.id] })
      return focusBlock(prev.id, head.length)
    }

    if (e.key === "Delete" && offset === text.length && next && !hasSelection(el)) {
      // Forward-delete at the end pulls the next block up into this one (or removes a divider).
      e.preventDefault()
      if (next.type === "divider") return send({ type: "remove", ids: [next.id] })
      if (isFigureType(next.type)) {
        flush(block.id)
        if (text === "") send({ type: "remove", ids: [block.id] })
        return focusFigure(next.id)
      }
      flush(next.id)
      const nextEl = els.current.get(next.id)
      const tail = nextEl ? editableText(nextEl) : next.text
      cancelPending(block.id)
      el.textContent = text + tail
      update(block.id, { text: text + tail })
      send({ type: "remove", ids: [next.id] })
      return setCaret(el, text.length)
    }

    // With Shift the browser extends the selection; jumping blocks would collapse it.
    if (e.key === "ArrowUp" && offset === 0 && !e.shiftKey) {
      const target = textNeighbor(index, -1)
      if (!target) return
      e.preventDefault()
      // Past the end lands at the end; the DOM may hold text that hasn't synced yet.
      return focusBlock(target.id, Number.MAX_SAFE_INTEGER)
    }
    if (e.key === "ArrowDown" && offset === text.length && !e.shiftKey) {
      const target = textNeighbor(index, 1)
      if (!target) return
      e.preventDefault()
      return focusBlock(target.id, 0)
    }
  }

  const soleBlock = blocks.length === 1
  let number = 0
  return (
    <div className="relative h-full">
      <div ref={root} className="h-full overflow-y-auto" onPointerDownCapture={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} onDragOver={onDragOverFiles} onDrop={onDropFiles}>
        {!readOnly && uploadImage && (
          <input
            ref={fileInput}
            type="file"
            accept={imageTypes.join(",")}
            aria-label="Upload an image"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Reset, or picking the same file again wouldn't fire a change.
              e.target.value = ""
              if (file && pickFor.current) uploadInto(pickFor.current, file)
            }}
          />
        )}
        <DocCover page={page} readOnly={readOnly} onPage={setPage} />
        <div ref={column} className="relative mx-auto max-w-[720px] px-6 pb-40">
          {status !== "open" && (
            <div className="absolute top-3 left-6 text-[12px] text-muted">{status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : "Disconnected"}</div>
          )}
          <DocHeader
            page={page}
            readOnly={readOnly}
            onPage={setPage}
            title={title}
            onTitle={onTitleChange}
            onTitleEnter={() => {
              const first = blocks.find((b) => b.type !== "divider")
              if (first) focusBlock(first.id, 0)
            }}
            byline={bylineAfter ? null : bylineRow}
          />
          {readOnly && status === "open" && blocks.every((b) => b.type !== "divider" && !b.src && !b.ref && b.text === "") && (
            <div className="text-[16px] leading-[26px] text-faint">This doc is empty.</div>
          )}
          {selectionTool && (
            <SelectionBubble
              x={selectionTool.x}
              top={selectionTool.top}
              width={selectionTool.width}
              types={selectionTool.ids.flatMap((id) => blocks.find((b) => b.id === id)?.type ?? [])}
              canAsk={canAsk}
              canEdit={!readOnly}
              onAsk={() => {
                const { ids, excerpt } = selectionTool
                const [first] = ids
                const last = ids.at(-1)
                if (first && last) openAsk({ anchor: last, target: first, mode: "edit", blocks: ids, excerpt, returnTo: null })
              }}
              onTurnInto={(type) => turnInto(selectionTool.ids, type)}
            />
          )}
          {blocks.map((block, i) => {
            number = block.type === "numbered" ? number + 1 : 0
            const here = presenceByBlock.get(block.id) ?? []
            const first = here[0]
            const firstPresence = first?.presence as DocPresence | undefined
            // The lone block of an empty doc always shows its hint; otherwise empty paragraphs hint only while focused.
            // Viewers get no hint, but an empty block still needs its line: contenteditable gives editors one, and
            // without it the block collapses to nothing. A zero-width space holds the line, like the caret does.
            const placeholder = readOnly
              ? "​"
              : block.type === "paragraph" && canAsk
                ? AI_HINT
                : soleBlock && block.type === "paragraph"
                  ? "Write something, or type “/” for commands"
                  : placeholders[block.type]
            const hintWhileFocused = !readOnly && ((block.type === "paragraph" && !soleBlock) || isFigureType(block.type))
            const suggestion = block.suggestion
            const key = groupKey(block)
            // A pending rewrite shows as tracked changes until someone puts the caret in it to edit the new text.
            const showDiff = suggestion?.kind === "replace" && suggestion.original !== undefined && focusedId !== block.id
            const picked = ask?.mode === "edit" && ask.blocks.includes(block.id)
            const blockClass = typeClass[block.type]
            return (
              <Fragment key={block.id}>
                <div
                  className={`group relative -ml-3 rounded pl-3 transition-colors duration-700 ${gapAbove(block.type, blocks[i - 1]?.type)} ${picked || flashId === block.id ? "bg-accent/10" : suggestion?.kind === "insert" ? "bg-accent/[0.07]" : ""}`}
                  data-block-id={block.id}
                  data-suggestion={suggestion?.kind}
                >
                  {suggestion && <span className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 w-[3px] rounded bg-accent" />}
                  {first && (
                    <>
                      <span className="pointer-events-none absolute top-1 bottom-1 left-0 w-[3px] rounded" style={{ background: first.color }} />
                      <span
                        className="pointer-events-none absolute top-1 -right-2 z-10 flex max-w-[260px] select-none translate-x-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-white max-lg:top-[-1.1rem] max-lg:right-0 max-lg:translate-x-0"
                        style={{ background: first.color }}
                      >
                        {first.actor.type === "agent" && <AgentMark name={first.name} />}
                        <span className="truncate">
                          {first.name}
                          {/* An agent's own status line says more than a generic "writing". */}
                          {firstPresence?.status ? ` · ${firstPresence.status}` : firstPresence?.thinking ? " is writing…" : ""}
                        </span>
                        {here.length > 1 && <span className="shrink-0">+{here.length - 1}</span>}
                      </span>
                    </>
                  )}
                  {suggestion && !readOnly && !activeKeys.has(key) && (
                    <BlockReview onAccept={() => acceptBlocks([block])} onDiscard={() => discardBlocks([block])} />
                  )}
                  {block.type === "image" && (
                    <DocImage
                      src={block.src}
                      alt={block.text}
                      readOnly={readOnly}
                      upload={uploads[block.id]}
                      canUpload={!!uploadImage}
                      onPick={() => pickImage(block.id)}
                      onLink={(src) => update(block.id, { src })}
                      onRemove={() => removeFigure(block.id)}
                      onCaption={() => focusBlock(block.id, 0)}
                    />
                  )}
                  {block.type === "embed" && (
                    <Figure readOnly={readOnly} onRemove={() => removeFigure(block.id)} onCaption={() => focusBlock(block.id, 0)} className="w-full">
                      {block.ref && embeds ? (
                        embeds.render(block.ref)
                      ) : (
                        <div className="rounded-md border border-dashed border-border bg-surface px-3 py-3 pr-11 text-[13px] text-muted">
                          {readOnly || !embeds ? (
                            "Nothing linked yet"
                          ) : (
                            <button type="button" onClick={() => setEmbedPick(block.id)} className="rounded border border-border bg-bg px-2 py-0.5 font-medium text-text hover:bg-hover">
                              Choose what to link
                            </button>
                          )}
                        </div>
                      )}
                    </Figure>
                  )}
                  {block.type === "divider" ? (
                    <div
                      tabIndex={readOnly ? -1 : 0}
                      role="separator"
                      onKeyDown={(e) => {
                        if (!readOnly && (e.key === "Backspace" || e.key === "Delete")) {
                          e.preventDefault()
                          send({ type: "remove", ids: [block.id] })
                        }
                      }}
                      className="py-3 outline-none focus:bg-hover"
                    >
                      <hr className="border-border" />
                    </div>
                  ) : (
                    <div className="relative flex items-start gap-2">
                      {block.type === "bullet" && <span className="mt-[10px] size-1.5 shrink-0 rounded-full bg-text" />}
                      {block.type === "numbered" && <span className="min-w-5 shrink-0 text-[16px] leading-[26px] text-muted tabular-nums">{number}.</span>}
                      {block.type === "todo" && (
                        <input
                          type="checkbox"
                          checked={block.checked ?? false}
                          disabled={readOnly}
                          onChange={(e) => update(block.id, { checked: e.target.checked })}
                          aria-label="Done"
                          className="mt-[6px] size-4 shrink-0 accent-accent"
                        />
                      )}
                      {showDiff && (
                        <DiffText
                          before={suggestion.original ?? ""}
                          after={block.text}
                          className={`min-w-0 flex-1 ${blockClass} ${readOnly ? "" : "cursor-text"}`}
                          onMouseDown={(e) => {
                            if (readOnly) return
                            // Clicking the tracked changes edits the new text (the editable sits hidden underneath).
                            e.preventDefault()
                            focusBlock(block.id, Number.MAX_SAFE_INTEGER)
                          }}
                        />
                      )}
                      <Editable
                        block={block}
                        readOnly={readOnly}
                        register={(el) => (el ? els.current.set(block.id, el) : els.current.delete(block.id))}
                        onInput={(el, typed) => onInput(block, el, typed)}
                        onKeyDown={(e) => onKeyDown(block, i, e)}
                        onPaste={(e) => onPaste(block, e)}
                        onFocus={() => {
                          setFocusedId(block.id)
                          room.setPresence({ blockId: block.id, editing: true })
                        }}
                        onBlur={() => {
                          flush(block.id)
                          setFocusedId((id) => (id === block.id ? null : id))
                          if (slash?.blockId === block.id) setSlash(null)
                          room.setPresence({ blockId: null })
                        }}
                        menuOpen={slash?.blockId === block.id}
                        // Hidden but still focusable while the diff shows, so arrow keys and clicks can still reach it.
                        className={
                          showDiff
                            ? "pointer-events-none absolute top-0 left-0 size-px overflow-hidden opacity-0"
                            : `min-w-0 flex-1 outline-none ${blockClass} ${block.type === "todo" && block.checked ? "text-muted line-through" : ""} ${
                                // The caption hint also shows on hover, or nobody would find it; viewers don't get an empty line under each image.
                                isFigureType(block.type) ? (readOnly && !block.text ? "hidden" : "group-hover:empty:before:content-[attr(data-placeholder)]") : ""
                              }`
                        }
                        placeholder={placeholder}
                        hintWhileFocused={hintWhileFocused}
                      />
                    </div>
                  )}
                  {slash?.blockId === block.id && (
                    <SlashMenu
                      items={slashMatches}
                      active={slash.active}
                      position={slash.position}
                      onHover={(active) => setSlash({ ...slash, active })}
                      onChoose={chooseSlash}
                    />
                  )}
                  {embedPick === block.id && embeds && !readOnly && (
                    <div className="absolute top-full left-3 z-30 mt-1">
                      {embeds.picker({
                        onPick: (ref) => placeEmbed(block.id, ref),
                        onClose: (refocus) => {
                          setEmbedPick(null)
                          if (refocus) focusBlock(block.id, Number.MAX_SAFE_INTEGER)
                        },
                      })}
                    </div>
                  )}
                  {ask?.anchor === block.id && (
                    <AskBar
                      context={ask.mode === "edit" ? { kind: "selection", count: ask.blocks.length } : { kind: "doc" }}
                      cover={ask.mode === "reply" && block.text === "" && block.type !== "divider" && !isFigureType(block.type)}
                      busy={askBusy}
                      error={askError}
                      onSubmit={submitAsk}
                      onClose={closeAsk}
                    />
                  )}
                </div>
                {block.id === bylineAfter && bylineRow}
                {bars.get(block.id)?.map((bar) => (
                  <MentionBar
                    key={bar.key}
                    mention={bar.mention}
                    group={bar.group}
                    agent={agentFor(bar, block.id)}
                    readOnly={readOnly}
                    claimFocus={asked.has(bar.key)}
                    vote={votes[bar.key]}
                    onStop={() => bar.mention && stop(bar.mention)}
                    onAccept={() => accept(bar)}
                    onDiscard={() => discard(bar)}
                    onRetry={() => retry(bar)}
                    onInsertBelow={() => insertBelow(bar)}
                    onDismiss={() => dismiss(bar.key)}
                    onVote={(v) => setVotes((prev) => ({ ...prev, [bar.key]: v }))}
                  />
                ))}
              </Fragment>
            )
          })}
          {!readOnly && (
            <button
              type="button"
              onClick={() => {
                const last = blocks.at(-1)
                if (last && last.type === "paragraph" && last.text === "") return focusBlock(last.id, 0)
                const id = newId("k_")
                send({ type: "insert", item: { id, type: "paragraph", text: "" } })
                focusBlock(id, 0)
              }}
              aria-label="Add a block at the end"
              className="mt-2 block h-24 w-full cursor-text text-left align-top text-[16px] text-faint"
            >
              {blocks.length === 0 && status === "open" ? "Click to start writing" : null}
            </button>
          )}
        </div>
      </div>
      <TableOfContents headings={headings} scroller={root} elementFor={headingEl} onJump={jumpTo} />
    </div>
  )
}

/** A known agent's app icon on its presence label; others keep the robot. */
function AgentMark({ name }: { name: string }) {
  const brand = brandOf(name)
  if (!brand) return <RobotIcon size={11} weight="bold" className="shrink-0" />
  return (
    <span data-agent-brand={brand} className="shrink-0">
      <BrandTile brand={brand} size={14} title={name} />
    </span>
  )
}

/**
 * One block's editable. The DOM owns the text while focused; outside focus,
 * remote changes are written into it. That keeps the caret stable while typing.
 */
function Editable({
  block,
  readOnly,
  register,
  onInput,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  menuOpen,
  className,
  placeholder,
  hintWhileFocused,
}: {
  block: Block
  readOnly: boolean
  register: (el: HTMLElement | null) => void
  /** `typed` is the inserted text for plain typing (null for deletes, pastes and the like). */
  onInput: (el: HTMLElement, typed: string | null) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  onPaste: (e: ClipboardEvent<HTMLElement>) => void
  onFocus: () => void
  onBlur: () => void
  menuOpen: boolean
  className: string
  placeholder: string
  /** Show the placeholder only while the block has focus (Notion's hint on empty lines). */
  hintWhileFocused: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    register(el)
    return () => register(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el && editableText(el) !== block.text) el.textContent = block.text
  }, [block.text])

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline={block.type === "code"}
      aria-label={isFigureType(block.type) ? "Caption" : block.type}
      aria-expanded={menuOpen || undefined}
      aria-controls={menuOpen ? "doc-slash-menu" : undefined}
      contentEditable={readOnly ? false : "plaintext-only"}
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      onInput={(e) => onInput(e.currentTarget, e.nativeEvent instanceof InputEvent && e.nativeEvent.inputType === "insertText" ? e.nativeEvent.data : null)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      onBlur={onBlur}
      className={`${className} ${block.type === "code" ? "" : "break-words whitespace-pre-wrap"} empty:before:pointer-events-none empty:before:text-faint ${
        hintWhileFocused ? "focus:empty:before:content-[attr(data-placeholder)]" : "empty:before:content-[attr(data-placeholder)]"
      } ${readOnly ? "" : "cursor-text"}`}
    />
  )
}
