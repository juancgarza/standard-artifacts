import { useMemo, type ReactNode } from "react"
import { ArrowSquareOutIcon, LinkSimpleIcon, PlusIcon, XIcon } from "@phosphor-icons/react"
import {
  issuesOf,
  kindOfId,
  kinds,
  sameRef,
  statusLabel,
  touchedByRuns,
  type Artifact,
  type ArtifactRef,
  type Issue,
  type TrackerState,
} from "@standard-artifacts/protocol"
import { StatusIcon } from "./icons"
import { PropertyMenu } from "./menu"

/**
 * What the host app gives the tracker so issues can point at the rest of the
 * workspace: the artifacts (for titles and the picker), a live preview of one
 * (the same thumbnails as Home), an icon per kind, and navigation.
 */
export interface Workspace {
  readonly artifacts: ReadonlyArray<Artifact>
  readonly preview?: (artifact: Artifact) => ReactNode
  readonly icon?: (kind: Artifact["kind"]) => ReactNode
  readonly open: (artifactId: string) => void
}

type Pick = { ref: ArtifactRef }

/**
 * Linked artifacts and issues on an issue, plus what its runs touched. Links
 * to issues in this same tracker open in place; everything else navigates.
 */
export function LinkedSection({
  issue,
  trackerId,
  state,
  workspace,
  readOnly,
  onChange,
  onOpenIssue,
  page,
}: {
  issue: Issue
  trackerId: string | undefined
  state: TrackerState
  workspace: Workspace | undefined
  readOnly: boolean
  onChange: (links: Array<ArtifactRef>) => void
  onOpenIssue: (issueId: string) => void
  page?: boolean
}) {
  const links = issue.links ?? []
  const byId = useMemo(() => new Map((workspace?.artifacts ?? []).map((a) => [a.id, a])), [workspace?.artifacts])
  const touched = touchedByRuns(state, issue.id, trackerId).filter((id) => !links.some((l) => l.artifactId === id && !l.item))
  if (!links.length && !touched.length && readOnly) return null

  const options = [
    ...(workspace?.artifacts ?? [])
      .filter((a) => !links.some((l) => sameRef(l, { artifactId: a.id })))
      .map((a) => ({ value: { ref: { artifactId: a.id } } as Pick | null, label: a.title, section: kinds[a.kind].label, icon: workspace?.icon?.(a.kind) })),
    ...(trackerId
      ? issuesOf(state)
          .filter((i) => i.id !== issue.id && !links.some((l) => sameRef(l, { artifactId: trackerId, item: i.id })))
          .map((i) => ({ value: { ref: { artifactId: trackerId, item: i.id } } as Pick | null, label: `#${i.number} ${i.title}`, section: "Issues here", icon: <StatusIcon status={i.status} /> }))
      : []),
  ]

  const remove = (ref: ArtifactRef) => onChange(links.filter((l) => !sameRef(l, ref)))

  return (
    <section aria-label="Linked" className={page ? "mt-8" : "px-5 pt-4"} data-linked>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-medium">Linked</h2>
        <span className="text-[12px] text-faint">{links.length || ""}</span>
        <div className="flex-1" />
        {!readOnly && workspace && (
          <PropertyMenu
            label="Link"
            value={null as Pick | null}
            onChange={(p) => p && onChange([...links, p.ref])}
            options={options}
            className="h-7 px-2 text-[12.5px] text-muted hover:text-text"
          >
            <PlusIcon size={13} /> Link
          </PropertyMenu>
        )}
      </div>

      {links.length > 0 ? (
        <ul className={`grid gap-2 ${page ? "grid-cols-2 md:grid-cols-3" : "grid-cols-2"}`}>
          {links.map((l) => {
            const key = `${l.artifactId}/${l.item ?? ""}`
            const sameTracker = l.item && l.artifactId === trackerId
            const target = sameTracker ? issuesOf(state).find((i) => i.id === l.item) : undefined
            return (
              <li key={key} className="group relative" data-link={key}>
                {sameTracker ? (
                  <IssueCard issue={target} onOpen={() => target && onOpenIssue(target.id)} />
                ) : (
                  <ArtifactCard artifact={byId.get(l.artifactId)} artifactId={l.artifactId} item={l.item} workspace={workspace} />
                )}
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="Remove link"
                    onClick={() => remove(l)}
                    className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md bg-bg/90 text-muted opacity-0 shadow-sm group-hover:opacity-100 hover:text-text focus-visible:opacity-100"
                  >
                    <XIcon size={12} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        !readOnly && (
          <p className="text-[12.5px] text-faint">Link the boards, tables, docs or issues this is about, so people and agents start from them.</p>
        )
      )}

      {touched.length > 0 && (
        <div className="mt-3" data-touched>
          <div className="mb-1.5 text-[12px] text-muted">Touched by runs</div>
          <div className="flex flex-wrap gap-1.5">
            {touched.map((id) => {
              const a = byId.get(id)
              return (
                <span key={id} className="flex h-7 items-center gap-1.5 rounded-md border border-border pr-1 pl-2 text-[12.5px]">
                  {a && workspace?.icon?.(a.kind)}
                  <button type="button" onClick={() => workspace?.open(id)} className="max-w-[180px] truncate hover:underline">
                    {a?.title ?? id}
                  </button>
                  {!readOnly && workspace && (
                    <button
                      type="button"
                      aria-label={`Link ${a?.title ?? id}`}
                      title="Link it"
                      onClick={() => onChange([...links, { artifactId: id }])}
                      className="grid size-5 place-items-center rounded text-faint hover:bg-hover hover:text-text"
                    >
                      <LinkSimpleIcon size={12} />
                    </button>
                  )}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

function ArtifactCard({ artifact, artifactId, item, workspace }: { artifact: Artifact | undefined; artifactId: string; item: string | undefined; workspace: Workspace | undefined }) {
  const kind = artifact?.kind ?? kindOfId(artifactId)
  return (
    <button
      type="button"
      onClick={() => workspace?.open(artifactId)}
      className="flex w-full flex-col overflow-hidden rounded-lg border border-border text-left transition-colors hover:border-faint/60"
    >
      <div className="relative h-[88px] w-full border-b border-border bg-surface">{artifact && workspace?.preview?.(artifact)}</div>
      <div className="flex w-full items-center gap-1.5 px-2.5 py-2 text-[12.5px]">
        {kind && workspace?.icon?.(kind)}
        <span className="min-w-0 flex-1 truncate font-medium">{artifact?.title ?? "Unavailable"}</span>
        {item && <span className="shrink-0 text-[11px] text-faint">{item}</span>}
        <ArrowSquareOutIcon size={12} className="shrink-0 text-faint" />
      </div>
    </button>
  )
}

function IssueCard({ issue, onOpen }: { issue: Issue | undefined; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!issue}
      className="flex h-full min-h-[44px] w-full items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-[12.5px] transition-colors enabled:hover:border-faint/60"
    >
      {issue ? (
        <>
          <StatusIcon status={issue.status} />
          <span className="shrink-0 text-faint">#{issue.number}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
          <span className="shrink-0 text-[11px] text-muted">{statusLabel(issue.status)}</span>
        </>
      ) : (
        <span className="text-faint">Deleted issue</span>
      )}
    </button>
  )
}
