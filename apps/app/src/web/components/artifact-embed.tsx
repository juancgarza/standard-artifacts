import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { ArrowSquareOutIcon, LinkBreakIcon } from "@phosphor-icons/react"
import {
  cellKey,
  cellLabel,
  cellText,
  issuesOf,
  issueStatuses,
  isPageBlock,
  kinds,
  type Artifact,
  type ArtifactRef,
  type Block,
  type Issue,
  type RoomContent,
  type TableState,
  type TrackerState,
} from "@standard-artifacts/protocol"
import { ShapePreview } from "@standard-artifacts/board"
import { StatusIcon } from "@standard-artifacts/tracker"
import { useWorkspace } from "../workspace"
import { Preview, useArtifactContent } from "./home-preview"
import { KindIcon } from "./kind-icon"

/** Most fields a row's preview lists, after its title. */
const MAX_FIELDS = 8
/** How much of a whole table a preview shows. */
const MAX_TABLE_COLUMNS = 6
const MAX_TABLE_ROWS = 8

export const findIssue = (state: TrackerState, item: string) => issuesOf(state).find((i) => i.id === item || String(i.number) === item)

/** A row's name: its first column's value. */
export const rowTitle = (state: TableState, rowId: string) => {
  const first = state.columns[0]
  // A list of ids isn't a name.
  return (first && first.type !== "artifact" && cellText(state.cells[cellKey(rowId, first.id)]?.v)) || "Untitled row"
}

/** Rows with something in them: new tables start with blank ones, which would push real rows out of a short preview. */
export const filledRows = (state: TableState) => state.rowIds.filter((rowId) => state.columns.some((c) => cellText(state.cells[cellKey(rowId, c.id)]?.v)))

/** Says nothing about what's linked: someone without access shouldn't learn its title, or even that it exists. */
const Unavailable = ({ fill }: { fill?: boolean | undefined }) => (
  <div className={`flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-[13px] text-muted ${fill ? "h-full justify-center" : "pr-11"}`}>
    <LinkBreakIcon size={16} className="shrink-0" /> This link isn’t available
  </div>
)

/** The preview as a link to its source. A real link, so ⌘-click opens a tab like any other. */
function Card({ artifact, item, label, fill, children }: { artifact: Artifact; item?: string | undefined; label?: string | undefined; fill?: boolean | undefined; children: ReactNode }) {
  return (
    <Link
      to="/$kind/$id/{-$item}"
      params={{ kind: kinds[artifact.kind].slug, id: artifact.id, item }}
      draggable={false}
      data-embed={artifact.id}
      className={`overflow-hidden rounded-lg border border-border bg-bg text-left transition-colors hover:border-faint/60 ${fill ? "flex h-full flex-col" : "block"}`}
    >
      <div className={`border-b border-border bg-surface ${fill ? "min-h-0 flex-1 overflow-hidden" : ""}`}>{children}</div>
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-[12.5px]">
        <KindIcon kind={artifact.kind} size={14} className="shrink-0" />
        <span className={`min-w-0 truncate font-medium text-text ${label ? "max-w-[60%] shrink-0" : ""}`}>{artifact.title}</span>
        {label && <span className="min-w-0 truncate text-muted">· {label}</span>}
        <ArrowSquareOutIcon size={12} className="ml-auto shrink-0 text-faint" />
      </div>
    </Link>
  )
}

/** Titles of what this viewer can open, for showing an Artifact cell as text. */
function useTitleOf() {
  const { artifacts } = useWorkspace()
  return (id: string) => artifacts.find((a) => a.id === id)?.title
}

function TablePreview({ state }: { state: TableState }) {
  const titleOf = useTitleOf()
  const columns = state.columns.slice(0, MAX_TABLE_COLUMNS)
  const rows = filledRows(state)
  const hiddenColumns = state.columns.length - columns.length
  const hiddenRows = rows.length - MAX_TABLE_ROWS
  if (rows.length === 0) return <div className="grid h-24 place-items-center text-[13px] text-muted">No rows yet</div>
  return (
    <div className="overflow-hidden text-[13px]">
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr className="border-b border-border text-left text-[12px] text-muted">
            {columns.map((c) => (
              <th key={c.id} scope="col" className="truncate px-3 py-1.5 font-medium">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_TABLE_ROWS).map((rowId) => (
            <tr key={rowId} className="border-b border-border bg-bg last:border-b-0">
              {columns.map((c) => (
                <td key={c.id} className="truncate px-3 py-1.5 text-text">
                  {cellLabel(c, state.cells[cellKey(rowId, c.id)]?.v, titleOf)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(hiddenRows > 0 || hiddenColumns > 0) && (
        <div className="border-t border-border px-3 py-1.5 text-[12px] text-muted">
          {[hiddenRows > 0 && `${hiddenRows} more row${hiddenRows === 1 ? "" : "s"}`, hiddenColumns > 0 && `${hiddenColumns} more column${hiddenColumns === 1 ? "" : "s"}`].filter(Boolean).join(", ")}
        </div>
      )}
    </div>
  )
}

function RowPreview({ state, rowId }: { state: TableState; rowId: string }) {
  const titleOf = useTitleOf()
  const fields = state.columns
    .slice(1)
    .map((c) => ({ id: c.id, name: c.name, value: cellLabel(c, state.cells[cellKey(rowId, c.id)]?.v, titleOf) }))
    .filter((f) => f.value)
  return (
    <div className="px-4 py-3 text-[13px]">
      <div className="truncate text-[15px] font-semibold text-text">{rowTitle(state, rowId)}</div>
      {fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1">
          {fields.slice(0, MAX_FIELDS).map((f) => (
            <div key={f.id} className="contents">
              <dt className="truncate text-muted">{f.name}</dt>
              <dd className="truncate text-text">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function IssuePreview({ issue }: { issue: Issue }) {
  return (
    <div className="px-4 py-3 text-[13px]">
      <div className="flex items-center gap-2 text-text">
        <StatusIcon status={issue.status} size={14} />
        <span className="shrink-0 text-muted">#{issue.number}</span>
        <span className="min-w-0 truncate text-[15px] font-semibold">{issue.title}</span>
      </div>
      <div className="mt-1 text-muted">{issueStatuses.find((s) => s.id === issue.status)?.label}</div>
      {issue.description && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-text">{issue.description}</p>}
    </div>
  )
}

const BlockPreview = ({ block }: { block: Block }) => <p className="line-clamp-6 px-4 py-3 text-[14px] whitespace-pre-wrap text-text">{block.text}</p>

/** The linked item in `content`, with what its card needs: a link into the source, a label, and how it looks. Null when it's gone. */
function itemView(content: RoomContent, item: string): { item?: string; label?: string; body: ReactNode } | null {
  switch (content.kind) {
    case "board": {
      const shape = content.state.items.find((s) => s.id === item)
      if (!shape || shape.kind === "arrow") return null
      // Notes and the like already show their text; these keep theirs as a title or caption outside the shape.
      const titled = shape.kind === "frame" || shape.kind === "image" || shape.kind === "html" || shape.kind === "design"
      return { item, ...(titled && shape.text && { label: shape.text }), body: <div className="p-4"><ShapePreview shape={shape} shapes={content.state.items} /></div> }
    }
    case "table":
      if (!content.state.rowIds.includes(item)) return null
      return { item, body: <RowPreview state={content.state} rowId={item} /> }
    case "tracker": {
      const issue = findIssue(content.state, item)
      // Issue pages are addressed by number.
      return issue ? { item: String(issue.number), body: <IssuePreview issue={issue} /> } : null
    }
    case "doc": {
      const block = content.state.items.find((b) => b.id === item && !isPageBlock(b))
      return block ? { body: <BlockPreview block={block} /> } : null
    }
  }
}

function ItemEmbed({ artifact, item, fill }: { artifact: Artifact; item: string; fill: boolean | undefined }) {
  const { ref, content, failed } = useArtifactContent(artifact)
  if (failed) return <Unavailable fill={fill} />
  const view = content && itemView(content, item)
  return (
    <div ref={ref} className={fill ? "h-full" : ""}>
      {!content ? (
        <Card artifact={artifact} fill={fill}>
          <div className="h-24 animate-pulse bg-hover/40" />
        </Card>
      ) : view ? (
        <Card artifact={artifact} item={view.item} label={view.label} fill={fill}>
          {view.body}
        </Card>
      ) : (
        <Card artifact={artifact} label="this item was removed" fill={fill}>
          <div className={`grid place-items-center text-[13px] text-muted ${fill ? "h-full" : "h-16"}`}>
            <LinkBreakIcon size={18} />
          </div>
        </Card>
      )}
    </div>
  )
}

/** A whole table reads better as a table than as Home's thumbnail, which is sized for a small card. */
function WholeTable({ artifact, fill }: { artifact: Artifact; fill: boolean | undefined }) {
  const { ref, content, failed } = useArtifactContent(artifact)
  if (failed) return <Unavailable fill={fill} />
  return (
    <div ref={ref} className={fill ? "h-full" : ""}>
      <Card artifact={artifact} fill={fill}>{content?.kind === "table" ? <TablePreview state={content.state} /> : <div className="h-24 animate-pulse bg-hover/40" />}</Card>
    </div>
  )
}

const chipClass = "inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded border border-border bg-surface px-1.5 text-[12px] leading-5"

/** Says nothing about what's linked, like the full-size preview. */
const UnavailableChip = () => (
  <span className={`${chipClass} text-muted`} title="This link isn’t available">
    <LinkBreakIcon size={12} className="shrink-0" /> Unavailable
  </span>
)

function ChipLink({ artifact, item, label }: { artifact: Artifact; item?: string | undefined; label?: string | undefined }) {
  return (
    <Link
      to="/$kind/$id/{-$item}"
      params={{ kind: kinds[artifact.kind].slug, id: artifact.id, item }}
      draggable={false}
      data-chip={artifact.id}
      title={label ? `${artifact.title} · ${label}` : artifact.title}
      className={`${chipClass} text-text transition-colors hover:border-faint/60`}
    >
      <KindIcon kind={artifact.kind} size={12} className="shrink-0" />
      <span className="truncate">{label ?? artifact.title}</span>
    </Link>
  )
}

/** The linked item's name and the address that opens it, or null when it's gone. */
function itemName(content: RoomContent, item: string): { item?: string; label: string } | null {
  switch (content.kind) {
    case "board": {
      const shape = content.state.items.find((s) => s.id === item)
      return shape && shape.kind !== "arrow" ? { item, label: shape.text?.trim().split("\n")[0] || "Shape" } : null
    }
    case "table":
      return content.state.rowIds.includes(item) ? { item, label: rowTitle(content.state, item) } : null
    case "tracker": {
      const issue = findIssue(content.state, item)
      return issue ? { item: String(issue.number), label: `#${issue.number} ${issue.title}` } : null
    }
    case "doc": {
      const block = content.state.items.find((b) => b.id === item && !isPageBlock(b))
      return block ? { label: block.text.trim().split("\n")[0] || "Block" } : null
    }
  }
}

function ItemChip({ artifact, item }: { artifact: Artifact; item: string }) {
  const { ref, content, failed } = useArtifactContent(artifact)
  const named = content && itemName(content, item)
  if (failed || (content && !named)) return <UnavailableChip />
  return (
    <div ref={ref} className="flex max-w-full min-w-0">
      <ChipLink artifact={artifact} item={named?.item} label={named?.label} />
    </div>
  )
}

/** A linked artifact or item in one line, for a table cell. Its title stays current. Clicking opens the source. */
export function ArtifactChip({ target }: { target: ArtifactRef }) {
  const { artifacts } = useWorkspace()
  const artifact = artifacts.find((a) => a.id === target.artifactId)
  if (!artifact) return <UnavailableChip />
  return target.item ? <ItemChip artifact={artifact} item={target.item} /> : <ChipLink artifact={artifact} />
}

/** A read-only preview of a linked artifact or one item in it, as of when it loaded. Clicking opens the source. */
export function ArtifactEmbed({ target, fill }: { target: ArtifactRef; /** Take the container's height, as on a board, instead of the preview's own. */ fill?: boolean }) {
  const { artifacts } = useWorkspace()
  // The workspace lists only what this viewer may open, so a share-link guest lands here for everything else.
  const artifact = artifacts.find((a) => a.id === target.artifactId)
  if (!artifact) return <Unavailable fill={fill} />
  if (target.item) return <ItemEmbed artifact={artifact} item={target.item} fill={fill} />
  if (artifact.kind === "table") return <WholeTable artifact={artifact} fill={fill} />
  return (
    <Card artifact={artifact} fill={fill}>
      <div className={`relative ${fill ? "h-full" : "h-56"}`}>
        <Preview artifact={artifact} />
      </div>
    </Card>
  )
}
