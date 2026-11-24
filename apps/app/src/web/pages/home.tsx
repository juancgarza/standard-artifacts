import { useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"
import { FolderIcon, RowsIcon, SquaresFourIcon, StarIcon } from "@phosphor-icons/react"
import { kindOrder, kinds, uniqueFolderName, type Artifact, type ArtifactKind } from "@standard-artifacts/protocol"
import { recency, useWorkspace } from "../workspace"
import { KindIcon, KindTile } from "../components/kind-icon"
import { ArtifactCard, ArtifactList, FolderGrid, LayoutButton, PAGE, useLayout } from "../components/artifact-list"
import { FolderNameInput } from "../components/folder-name-input"

const blurbs: Record<ArtifactKind, string> = {
  board: "Map ideas with agents on a canvas",
  table: "Find and enrich people and companies",
  doc: "Write and edit with an agent alongside",
  tracker: "Track work for people and agents",
}

type Tab = "recent" | "starred" | "folders" | ArtifactKind

export function HomePage() {
  const { principal, artifacts, folders, editable, create, status, starred, visits } = useWorkspace()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<ArtifactKind | null>(null)
  const [tab, setTab] = useState<Tab>("recent")
  const [layout, setLayoutState] = useLayout()
  const [limit, setLimit] = useState<number | null>(null)

  const setLayout = (l: typeof layout) => {
    setLayoutState(l)
    setLimit(null)
  }

  const onCreate = async (kind: ArtifactKind) => {
    setBusy(kind)
    const a = await create(kind)
    setBusy(null)
    if (a) navigate({ to: "/$kind/$id/{-$item}", params: { kind: kinds[kind].slug, id: a.id, item: undefined } })
  }

  const lists = useMemo(() => {
    const byId = new Map(artifacts.map((a) => [a.id, a]))
    const recent = [...artifacts].sort((a, b) => recency(b, visits) - recency(a, visits))
    return {
      recent,
      starred: starred.flatMap((id) => byId.get(id) ?? []),
      folders: [],
      board: recent.filter((a) => a.kind === "board"),
      table: recent.filter((a) => a.kind === "table"),
      doc: recent.filter((a) => a.kind === "doc"),
      tracker: recent.filter((a) => a.kind === "tracker"),
    } satisfies Record<Tab, Artifact[]>
  }, [artifacts, starred, visits])

  const rootFolders = folders.filter((f) => f.parentId === null)
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "recent", label: "Recent" },
    { id: "starred", label: "Starred" },
    // Share-link guests see one artifact and nothing of how the org files it.
    ...(principal?.scope ? [] : [{ id: "folders" as const, label: "Folders" }]),
    ...kindOrder.map((k) => ({ id: k, label: kinds[k].label })),
  ]

  const items = lists[tab]
  const shown = items.slice(0, limit ?? PAGE[layout])
  const timeFor = (a: Artifact) => (tab === "recent" ? new Date(recency(a, visits)).toISOString() : a.updatedAt)
  // The overview leads with where things live. The other tabs are filters, so they list artifacts only.
  const leading = tab === "recent" ? rootFolders : []

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-8 md:px-10 md:py-10">
      <h1 className="text-[22px] font-semibold tracking-tight">{principal?.orgName ?? " "}</h1>

      {editable && (
        <div className="mt-5 grid grid-cols-2 gap-2 sm:gap-2.5 lg:grid-cols-4">
          {kindOrder.map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={busy !== null}
              onClick={() => onCreate(kind)}
              className="group flex flex-col items-start gap-2 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-faint/60 hover:bg-surface disabled:opacity-60 sm:flex-row sm:items-center sm:gap-3"
            >
              <KindTile kind={kind} size={34} />
              <div className="min-w-0">
                <div className="font-medium">New {kinds[kind].singular.toLowerCase()}</div>
                <div className="hidden truncate text-[12px] text-muted sm:block">{blurbs[kind]}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="mt-9 flex items-end justify-between gap-3 border-b border-border">
        <div role="tablist" aria-label="Browse" className="-mb-px flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((t) => {
            const selected = tab === t.id
            const count = t.id === "folders" ? rootFolders.length : lists[t.id].length
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`home-tab-${t.id}`}
                aria-selected={selected}
                aria-controls="home-panel"
                onClick={() => {
                  setTab(t.id)
                  setLimit(null)
                }}
                className={`flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2 text-[13px] transition-colors ${
                  selected ? "border-text font-medium text-text" : "border-transparent text-muted hover:text-text"
                }`}
              >
                {t.id === "starred" && <StarIcon size={13} weight={selected ? "fill" : "regular"} className={selected ? "text-star" : ""} />}
                {t.label}
                {t.id !== "recent" && count > 0 && <span className="text-[12px] font-normal text-faint">{count}</span>}
              </button>
            )
          })}
        </div>
        <div className="mb-1.5 flex shrink-0 rounded-md border border-border p-0.5">
          <LayoutButton active={layout === "grid"} onClick={() => setLayout("grid")} label="Grid view">
            <SquaresFourIcon size={15} />
          </LayoutButton>
          <LayoutButton active={layout === "list"} onClick={() => setLayout("list")} label="List view">
            <RowsIcon size={15} />
          </LayoutButton>
        </div>
      </div>

      <div id="home-panel" role="tabpanel" aria-labelledby={`home-tab-${tab}`} className="pt-4">
        {status === "loading" ? null : tab === "folders" ? (
          <FoldersTab layout={layout} />
        ) : items.length === 0 && leading.length === 0 ? (
          <EmptyTab tab={tab} editable={editable} onCreate={onCreate} />
        ) : layout === "grid" ? (
          <div className="space-y-4">
            {leading.length > 0 && <FolderGrid folders={leading} layout="grid" />}
            {shown.length > 0 && (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))] sm:gap-4">
                {shown.map((a) => (
                  <li key={a.id}>
                    <ArtifactCard artifact={a} principal={principal} time={timeFor(a)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <ArtifactList items={shown} folders={leading} principal={principal} timeFor={timeFor} timeLabel={tab === "recent" ? "Last activity" : "Updated"} showLocation />
        )}

        {items.length > shown.length && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => setLimit(shown.length + PAGE[layout])}
              className="rounded-md px-3 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-text"
            >
              Show more <span className="text-faint">· {items.length - shown.length} left</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Top-level folders. What's in them is a click away, or in the sidebar tree. */
function FoldersTab({ layout }: { layout: "grid" | "list" }) {
  const { folders, editable, createFolder } = useWorkspace()
  const [adding, setAdding] = useState(false)
  const roots = folders.filter((f) => f.parentId === null)
  const input = adding && (
    <FolderNameInput
      initial={uniqueFolderName(folders, "New folder", null)}
      label="New folder name"
      className="mb-3 h-10 max-w-sm rounded-lg border border-accent px-3"
      onCancel={() => setAdding(false)}
      onSubmit={async (name) => {
        await createFolder(name, null)
        setAdding(false)
      }}
    />
  )
  if (roots.length === 0 && !adding) {
    return (
      <Empty icon={<FolderIcon size={22} weight="duotone" className="text-faint" />} title="No folders yet">
        {editable ? (
          <button type="button" onClick={() => setAdding(true)} className="text-accent hover:underline">
            New folder
          </button>
        ) : (
          "Folders people make show up here."
        )}
      </Empty>
    )
  }
  return (
    <>
      {input}
      {editable && !adding && (
        <button type="button" onClick={() => setAdding(true)} className="mb-3 h-8 rounded-md border border-border px-3 text-[13px] hover:bg-hover">
          New folder
        </button>
      )}
      <FolderGrid folders={roots} layout={layout} />
    </>
  )
}

function EmptyTab({ tab, editable, onCreate }: { tab: Exclude<Tab, "folders">; editable: boolean; onCreate: (kind: ArtifactKind) => void }) {
  if (tab === "starred") {
    return (
      <Empty icon={<StarIcon size={22} className="text-faint" />} title="Nothing starred yet">
        Star a board, table or doc from its row or card to keep it here and in the sidebar.
      </Empty>
    )
  }
  if (tab === "recent") {
    return (
      <Empty icon={null} title="Nothing here yet">
        {editable ? "Create a board, table or doc to get started." : "Boards, tables and docs shared with you show up here."}
      </Empty>
    )
  }
  const meta = kinds[tab]
  return (
    <Empty icon={<KindIcon kind={tab} size={22} />} title={`No ${meta.label.toLowerCase()} yet`}>
      {editable ? (
        <button type="button" onClick={() => onCreate(tab)} className="text-accent hover:underline">
          New {meta.singular.toLowerCase()}
        </button>
      ) : null}
    </Empty>
  )
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-14 text-center">
      {icon}
      <div className="font-medium">{title}</div>
      {children && <div className="max-w-sm text-[13px] text-muted">{children}</div>}
    </div>
  )
}
