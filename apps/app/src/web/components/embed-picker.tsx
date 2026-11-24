import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react"
import { issuesOf, kinds, type Artifact, type ArtifactRef, type RoomContent } from "@standard-artifacts/protocol"
import { StatusIcon } from "@standard-artifacts/tracker"
import { useWorkspace } from "../workspace"
import { filledRows, rowTitle } from "./artifact-embed"
import { KindIcon } from "./kind-icon"

const MAX_OPTIONS = 100

type Option = { key: string; label: string; hint?: string; icon: ReactNode; more?: boolean; run: () => void }

const shapeNames: Record<string, string> = { note: "Note", rect: "Rectangle", ellipse: "Ellipse", text: "Text", frame: "Frame", image: "Image", html: "HTML", design: "Design", artifact: "Link" }

/** What can be linked inside an artifact: board shapes, table rows, issues. */
function itemsOf(content: RoomContent): ReadonlyArray<{ item: string; label: string; hint?: string; icon?: ReactNode }> {
  switch (content.kind) {
    case "board":
      return content.state.items.filter((s) => s.kind !== "arrow").map((s) => ({ item: s.id, label: s.text?.trim().split("\n")[0] || shapeNames[s.kind] || s.kind, hint: shapeNames[s.kind] ?? s.kind }))
    case "table":
      return filledRows(content.state).map((rowId) => ({ item: rowId, label: rowTitle(content.state, rowId) }))
    case "tracker":
      return issuesOf(content.state).map((i) => ({ item: i.id, label: i.title, hint: `#${i.number}`, icon: <StatusIcon status={i.status} size={14} /> }))
    case "doc":
      return []
  }
}

/**
 * Choose what to link to: an artifact, then (for boards, tables and trackers)
 * the whole thing or one item in it. Lists only what this viewer can open.
 */
export function EmbedPicker({
  exclude,
  keepOpen = false,
  initialQuery = "",
  onPick,
  onBackspace,
  onClose,
}: {
  /** An artifact that can't link to itself. */
  exclude?: string
  /** For linking several: a pick goes back to the start instead of leaving it to the host to close. */
  keepOpen?: boolean
  initialQuery?: string
  onPick: (ref: ArtifactRef) => void
  /** Backspace at the start, with nothing to delete in the search. */
  onBackspace?: () => void
  onClose: (refocus: boolean) => void
}) {
  const { artifacts, loadContent } = useWorkspace()
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [content, setContent] = useState<RoomContent | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    input.current?.focus()
    // Near the bottom of the window, bring the whole list into view.
    input.current?.closest('[role="dialog"]')?.scrollIntoView({ block: "nearest" })
  }, [artifact])

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" })
  }, [active])

  const pick = (ref: ArtifactRef) => {
    onPick(ref)
    if (keepOpen) back()
  }

  const choose = (a: Artifact) => {
    if (a.kind === "doc") return pick({ artifactId: a.id })
    setArtifact(a)
    setContent(null)
    setFailed(false)
    setQuery("")
    setActive(0)
    loadContent(a.id).then(setContent, () => setFailed(true))
  }

  const back = () => {
    setArtifact(null)
    setQuery("")
    setActive(0)
  }

  const options = useMemo<ReadonlyArray<Option>>(() => {
    const q = query.trim().toLowerCase()
    const matches = (label: string) => !q || label.toLowerCase().includes(q)
    if (!artifact) {
      return artifacts
        .filter((a) => a.id !== exclude && matches(a.title))
        .slice(0, MAX_OPTIONS)
        .map((a) => ({ key: a.id, label: a.title, hint: kinds[a.kind].singular, icon: <KindIcon kind={a.kind} size={14} />, more: a.kind !== "doc", run: () => choose(a) }))
    }
    const whole = `Whole ${kinds[artifact.kind].singular.toLowerCase()}`
    return [
      ...(matches(whole) ? [{ key: "whole", label: whole, icon: <KindIcon kind={artifact.kind} size={14} />, run: () => pick({ artifactId: artifact.id }) }] : []),
      ...(content ? itemsOf(content) : [])
        .filter((i) => matches(i.label))
        .slice(0, MAX_OPTIONS)
        .map((i) => ({ key: i.item, label: i.label, ...(i.hint && { hint: i.hint }), icon: i.icon ?? <KindIcon kind={artifact.kind} size={14} />, run: () => pick({ artifactId: artifact.id, item: i.item }) })),
    ]
    // `choose` only reads setters and loadContent, which `artifacts` and `artifact` already track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts, artifact, content, exclude, query, onPick])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = options.length
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (n) setActive((active + (e.key === "ArrowDown" ? 1 : -1) + n) % n)
    } else if (e.key === "Enter") {
      e.preventDefault()
      options[active]?.run()
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      if (artifact) back()
      else onClose(true)
    } else if (e.key === "Backspace" && !query) {
      e.preventDefault()
      if (artifact) back()
      else onBackspace?.()
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Link an artifact"
      // Closes when focus leaves it, except to its own rows (which keep focus in the search box).
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onClose(false)
      }}
      className="w-80 max-w-[calc(100vw-48px)] overflow-hidden rounded-lg border border-border bg-bg shadow-lg"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        {artifact && (
          <button type="button" aria-label="Back" onMouseDown={(e) => e.preventDefault()} onClick={back} className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-hover">
            <CaretLeftIcon size={13} />
          </button>
        )}
        <input
          ref={input}
          value={query}
          aria-label="Search"
          placeholder={artifact ? `Search ${artifact.title}` : "Link a board, table, doc or tracker"}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-[13px] text-text outline-none placeholder:text-faint"
        />
      </div>
      <div ref={list} role="listbox" aria-label="What to link" className="max-h-72 overflow-y-auto p-1">
        {options.map((o, i) => (
          <div
            key={o.key}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== active && setActive(i)}
            onClick={o.run}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${i === active ? "bg-hover" : ""}`}
          >
            <span className="grid size-4 shrink-0 place-items-center">{o.icon}</span>
            <span className="min-w-0 flex-1 truncate text-text">{o.label}</span>
            {o.hint && <span className="shrink-0 text-[11px] text-faint">{o.hint}</span>}
            {o.more && <CaretRightIcon size={11} className="shrink-0 text-faint" />}
          </div>
        ))}
        {artifact && !content && !failed && <div className="px-2 py-1.5 text-[13px] text-muted">Loading…</div>}
        {failed && <div className="px-2 py-1.5 text-[13px] text-danger">Couldn’t load its items. You can still link the whole thing.</div>}
        {!options.length && (content || !artifact) && <div className="px-2 py-1.5 text-[13px] text-muted">No results</div>}
      </div>
    </div>
  )
}
