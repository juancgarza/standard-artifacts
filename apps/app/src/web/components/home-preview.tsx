import { useEffect, useRef, useState } from "react"
import {
  cellKey,
  cellLabel,
  type Artifact,
  type Block,
  type CellValue,
  type RoomContent,
  type Shape,
  type ShapeColor,
  type TableState,
  type TrackerState,
  issuesOf,
  issueStatuses,
} from "@standard-artifacts/protocol"
import { AssigneeAvatar, StatusIcon } from "@standard-artifacts/tracker"
import { useWorkspace } from "../workspace"
import { KindIcon } from "./kind-icon"

/** Resolved previews survive remounts (tab switches, navigation back home) without a loading flash. */
const resolved = new Map<string, RoomContent>()

/**
 * An artifact's content, fetched once `ref`'s element scrolls into view, through the
 * workspace's short-lived cache, and again each time the artifact changes. The old
 * picture stays up until the new one arrives.
 */
export function useArtifactContent(artifact: Artifact) {
  const { loadContent } = useWorkspace()
  const ref = useRef<HTMLDivElement>(null)
  const [content, setContent] = useState<RoomContent | null>(() => resolved.get(artifact.id) ?? null)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: "120px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    loadContent(artifact.id, artifact.updatedAt)
      .then((c) => {
        resolved.set(artifact.id, c)
        if (cancelled) return
        setContent(c)
        setFailed(false)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [visible, artifact.id, artifact.updatedAt, loadContent])

  return { ref, content, failed }
}

/** A lightweight picture of an artifact for home cards. */
export function Preview({ artifact }: { artifact: Artifact }) {
  const { ref, content, failed } = useArtifactContent(artifact)

  return (
    <div ref={ref} className="relative h-full w-full overflow-hidden">
      {content ? (
        content.kind === "board" ? (
          <BoardPreview shapes={content.state.items} />
        ) : content.kind === "table" ? (
          <TablePreview state={content.state} />
        ) : content.kind === "tracker" ? (
          <TrackerPreview state={content.state} />
        ) : (
          <DocPreview blocks={content.state.items} />
        )
      ) : failed ? (
        <Placeholder artifact={artifact} />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-hover/40" />
      )}
    </div>
  )
}

function Placeholder({ artifact, label }: { artifact: Artifact; label?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="flex flex-col items-center gap-1.5 text-faint">
        <KindIcon kind={artifact.kind} size={28} className="opacity-50" />
        {label && <span className="text-[12px]">{label}</span>}
      </div>
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return <div className="absolute inset-0 grid place-items-center text-[12px] text-faint">{children}</div>
}

// --- Boards -----------------------------------------------------------------------

const fills: Record<ShapeColor, { fill: string; stroke: string }> = {
  yellow: { fill: "#fff3c4", stroke: "#e5a400" },
  blue: { fill: "#dbe8ff", stroke: "#2f6fed" },
  green: { fill: "#d6f5e3", stroke: "#1e9e6a" },
  pink: { fill: "#ffdcec", stroke: "#d6409f" },
  purple: { fill: "#eadcff", stroke: "#8e4ec6" },
  gray: { fill: "#eeeeec", stroke: "#8f8f8a" },
}

const MAX_SHAPES = 400

function BoardPreview({ shapes }: { shapes: ReadonlyArray<Shape> }) {
  const items = shapes.slice(0, MAX_SHAPES)
  const byId = new Map(items.map((s) => [s.id, s]))
  const boxes = items.filter((s) => s.kind !== "arrow")
  if (boxes.length === 0) return <Empty>Empty board</Empty>

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of boxes) {
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x + s.w)
    maxY = Math.max(maxY, s.y + s.h)
  }
  const w = Math.max(maxX - minX, 200)
  const h = Math.max(maxY - minY, 120)
  const pad = Math.max(w, h) * 0.08
  const viewBox = `${minX - pad - (w - (maxX - minX)) / 2} ${minY - pad - (h - (maxY - minY)) / 2} ${w + pad * 2} ${h + pad * 2}`
  const unit = Math.max(w, h) / 160 // ~1px at card size

  const center = (s: Shape) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 })
  // Frames at the back, then connectors, then everything else, so lines tuck under the shapes they join.
  const layer = (s: Shape) => (s.kind === "frame" ? 0 : s.kind === "arrow" ? 1 : 2)
  const ordered = [...items].sort((a, b) => layer(a) - layer(b))

  return (
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full dark:opacity-85" aria-hidden>
      {ordered.map((s) => {
        const c = fills[s.color ?? "gray"]
        switch (s.kind) {
          case "frame":
            return (
              <rect key={s.id} x={s.x} y={s.y} width={s.w} height={s.h} rx={unit * 2} fill="var(--bg)" stroke="var(--border)" strokeWidth={unit} />
            )
          case "note":
            return (
              <g key={s.id}>
                <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={unit} fill={c.fill} />
                {s.text && (
                  <>
                    <rect x={s.x + s.w * 0.12} y={s.y + s.h * 0.24} width={s.w * 0.7} height={Math.max(s.h * 0.08, unit)} rx={unit} fill={c.stroke} opacity={0.35} />
                    <rect x={s.x + s.w * 0.12} y={s.y + s.h * 0.42} width={s.w * 0.5} height={Math.max(s.h * 0.08, unit)} rx={unit} fill={c.stroke} opacity={0.35} />
                  </>
                )}
              </g>
            )
          case "rect":
            return <rect key={s.id} x={s.x} y={s.y} width={s.w} height={s.h} rx={unit * 1.5} fill={c.fill} stroke={c.stroke} strokeWidth={unit} />
          case "ellipse":
            return <ellipse key={s.id} cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={s.w / 2} ry={s.h / 2} fill={c.fill} stroke={c.stroke} strokeWidth={unit} />
          case "text":
            return <rect key={s.id} x={s.x} y={s.y + s.h * 0.3} width={s.w * 0.8} height={s.h * 0.4} rx={unit} fill="var(--faint)" opacity={0.6} />
          case "image":
            return <rect key={s.id} x={s.x} y={s.y} width={s.w} height={s.h} rx={unit} fill="var(--active)" />
          case "html":
          case "design":
          case "artifact":
            return (
              <g key={s.id}>
                <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={unit * 1.5} fill="var(--bg)" stroke="var(--faint)" strokeWidth={unit} />
                <rect x={s.x} y={s.y} width={s.w} height={Math.min(s.h * 0.12, unit * 8)} fill="var(--active)" />
              </g>
            )
          case "arrow": {
            const from = s.from ? byId.get(s.from) : undefined
            const to = s.to ? byId.get(s.to) : undefined
            const p1 = from ? center(from) : { x: s.x, y: s.y }
            const p2 = to ? center(to) : s.x2 !== undefined && s.y2 !== undefined ? { x: s.x2, y: s.y2 } : null
            if (!p2) return null
            return <line key={s.id} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--muted)" strokeWidth={unit} strokeLinecap="round" />
          }
          default:
            return null
        }
      })}
    </svg>
  )
}

// --- Tables -----------------------------------------------------------------------

const show = (v: CellValue | undefined): string => {
  if (v === undefined || v === null) return ""
  if (typeof v === "boolean") return v ? "✓" : ""
  if (Array.isArray(v)) return v.join(", ")
  if (typeof v === "string") return v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
  return String(v)
}

function TablePreview({ state }: { state: TableState }) {
  const { artifacts } = useWorkspace()
  const titleOf = (id: string) => artifacts.find((a) => a.id === id)?.title
  const cols = state.columns.slice(0, 3)
  const rows = state.rowIds.slice(0, 6)
  if (cols.length === 0) return <Empty>Empty table</Empty>
  return (
    <div className="absolute inset-x-3 top-3 bottom-0 overflow-hidden rounded-t-md border border-b-0 border-border bg-bg text-[11px] leading-none">
      <div className="flex border-b border-border bg-surface font-medium text-muted">
        {cols.map((c, i) => (
          <div key={c.id} className={`min-w-0 flex-1 truncate px-2 py-1.5 ${i > 0 ? "border-l border-border" : ""} ${i === 0 ? "flex-[1.4]" : ""}`}>
            {c.name}
          </div>
        ))}
      </div>
      {rows.map((rowId) => (
        <div key={rowId} className="flex border-b border-border last:border-b-0">
          {cols.map((c, i) => (
            <div
              key={c.id}
              className={`min-w-0 flex-1 truncate px-2 py-1.5 ${i > 0 ? "border-l border-border text-muted" : "text-text"} ${i === 0 ? "flex-[1.4]" : ""}`}
            >
              {(c.type === "artifact" ? cellLabel(c, state.cells[cellKey(rowId, c.id)]?.v, titleOf) : show(state.cells[cellKey(rowId, c.id)]?.v)) || " "}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// --- Docs -------------------------------------------------------------------------

function DocPreview({ blocks }: { blocks: ReadonlyArray<Block> }) {
  const lines = blocks.filter((b) => b.type === "divider" || (b.type === "image" && b.src) || (b.type === "embed" && b.ref) || b.text.trim()).slice(0, 9)
  if (lines.length === 0) return <Empty>Empty doc</Empty>
  return (
    <div className="absolute inset-x-5 top-4 bottom-0 overflow-hidden rounded-t-md border border-b-0 border-border bg-bg px-4 pt-3 text-[10.5px] leading-[1.45] text-muted">
      {lines.map((b) => {
        if (b.type === "divider") return <hr key={b.id} className="my-1.5 border-border" />
        // A placeholder, like image shapes in board previews: Home shouldn't fetch every doc's images.
        if (b.type === "image" || b.type === "embed") return <div key={b.id} className="my-1 h-10 rounded-sm bg-active" />
        const text = b.text.replace(/\s+/g, " ").slice(0, 160)
        if (b.type === "heading1") return <div key={b.id} className="mb-1 truncate text-[13px] font-semibold text-text">{text}</div>
        if (b.type === "heading2" || b.type === "heading3")
          return <div key={b.id} className="mt-1 truncate text-[11.5px] font-semibold text-text">{text}</div>
        const marker = b.type === "bullet" ? "•" : b.type === "numbered" ? "1." : b.type === "todo" ? "☐" : null
        return (
          <div key={b.id} className={`flex gap-1.5 ${b.type === "quote" ? "border-l-2 border-border pl-1.5" : ""} ${b.type === "code" ? "font-mono" : ""}`}>
            {marker && <span className="shrink-0 text-faint">{marker}</span>}
            <span className="line-clamp-2 min-w-0">{text}</span>
          </div>
        )
      })}
    </div>
  )
}

// --- Trackers ---------------------------------------------------------------------

function TrackerPreview({ state }: { state: TrackerState }) {
  const order = new Map(issueStatuses.map((s, i) => [s.id, i]))
  const issues = issuesOf(state)
    .filter((i) => issueStatuses.find((s) => s.id === i.status)?.open)
    .sort((a, b) => (order.get(a.status) ?? 0) - (order.get(b.status) ?? 0))
    .slice(0, 7)
  if (issues.length === 0) return <Empty>{issuesOf(state).length ? "All done" : "No issues yet"}</Empty>
  return (
    <div className="absolute inset-x-5 top-4 bottom-0 overflow-hidden rounded-t-md border border-b-0 border-border bg-bg py-1 text-[11px]">
      {issues.map((i) => (
        <div key={i.id} className="flex h-[22px] items-center gap-1.5 px-2.5">
          <StatusIcon status={i.status} size={11} />
          <span className="w-6 shrink-0 text-[10px] text-faint">#{i.number}</span>
          <span className="min-w-0 flex-1 truncate text-text">{i.title}</span>
          {(i.delegate ?? i.owner) && <AssigneeAvatar who={i.delegate ?? i.owner ?? null} size={13} />}
        </div>
      ))}
    </div>
  )
}
