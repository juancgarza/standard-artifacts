import { Schema } from "effect"
import { BoardState } from "./board.ts"
import { Artifact, ArtifactKind } from "./core.ts"
import { DocState } from "./doc.ts"
import { TableState, cellKey, cellText } from "./table.ts"
import { TrackerState, commentsOf, issuesOf } from "./tracker.ts"

/**
 * Workspace search. A hit is an artifact (its title matched) or one item inside
 * it (its content matched). `item` is what the artifact's URL and the edit tools
 * take: a block, row or shape id, or an issue's number.
 */

export const SearchQuery = Schema.Struct({
  q: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  kind: Schema.optionalKey(ArtifactKind),
  /** Clamped to 1–50; default 20. */
  limit: Schema.optionalKey(Schema.FiniteFromString),
})

export const SearchHit = Schema.Struct({
  artifact: Artifact,
  item: Schema.optionalKey(Schema.String),
  /** The matching text; absent when only the title matched. */
  text: Schema.optionalKey(Schema.String),
})
export interface SearchHit extends Schema.Schema.Type<typeof SearchHit> {}

export const SearchResults = Schema.Struct({
  hits: Schema.Array(SearchHit),
  /** "title": content search is off or failed, so only titles were matched. */
  mode: Schema.Literals(["hybrid", "title"]),
})
export interface SearchResults extends Schema.Schema.Type<typeof SearchResults> {}

export const Reindexed = Schema.Struct({ queued: Schema.Number })
export interface Reindexed extends Schema.Schema.Type<typeof Reindexed> {}

/** Title search: every word of the query must start a word of the title, or be the kind ("q4 le" finds "Q4 Leads"). An empty query matches everything. Most recently updated first. */
export function searchArtifacts(artifacts: ReadonlyArray<Artifact>, query: string, limit = 20): Array<Artifact> {
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const terms = words(query)
  return artifacts
    .filter((a) => {
      const title = words(`${a.title} ${a.kind}`)
      return terms.every((t) => title.some((w) => w.startsWith(t)))
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

export interface SearchItem {
  readonly item: string
  readonly text: string
}

/** Enough for any embedding model's context; a longer item still matches on how it starts. */
const maxItemLength = 8_000

const clipped = (item: string, text: string): SearchItem => ({ item, text: text.slice(0, maxItemLength) })

function docItems(state: DocState): Array<SearchItem> {
  let heading = ""
  return state.items.flatMap((b) => {
    const text = b.text.trim()
    const isHeading = b.type === "heading1" || b.type === "heading2" || b.type === "heading3"
    if (isHeading) heading = text
    if (!text) return []
    // A short block means little alone ("Yes, ship it"); its section says what it's about.
    return [clipped(b.id, heading && !isHeading ? `${heading}\n${text}` : text)]
  })
}

function tableItems(state: TableState): Array<SearchItem> {
  return state.rowIds.flatMap((rowId) => {
    const parts = state.columns.flatMap((c) => {
      // References are ids, which say nothing to a search; what they point at is indexed on its own.
      if (c.type === "artifact") return []
      const value = cellText(state.cells[cellKey(rowId, c.id)]?.v)
      return value ? [`${c.name}: ${value}`] : []
    })
    return parts.length ? [clipped(rowId, parts.join("\n"))] : []
  })
}

/** Shapes by their text. The source of html embeds and design frames isn't indexed, only their titles. */
const boardItems = (state: BoardState): Array<SearchItem> =>
  state.items.flatMap((s) => (s.text?.trim() ? [clipped(s.id, s.text.trim())] : []))

/** An issue with its description and comments, so one document answers "where did we discuss this". Run steps are left out as noise. */
const trackerItems = (state: TrackerState): Array<SearchItem> =>
  issuesOf(state).map((i) =>
    clipped(String(i.number), [`#${i.number} ${i.title}`, i.description ?? "", ...commentsOf(state, i.id).map((c) => c.text)].filter(Boolean).join("\n")),
  )

/**
 * Everything searchable in an artifact, one entry per item. Decoding throws on
 * a state it doesn't recognize, on purpose: returning nothing would read as
 * "every item was removed" and wipe the artifact from the index.
 */
export function searchItems(kind: ArtifactKind, state: unknown): Array<SearchItem> {
  switch (kind) {
    case "doc":
      return docItems(Schema.decodeUnknownSync(DocState)(state))
    case "table":
      return tableItems(Schema.decodeUnknownSync(TableState)(state))
    case "board":
      return boardItems(Schema.decodeUnknownSync(BoardState)(state))
    case "tracker":
      return trackerItems(Schema.decodeUnknownSync(TrackerState)(state))
  }
}

export const searchSnippet = (text: string, length = 240) => {
  const line = text.replace(/\s*\n\s*/g, " · ")
  return line.length > length ? `${line.slice(0, length)}…` : line
}
