import { useEffect, useState } from "react"
import { kinds, type Artifact } from "@standard-artifacts/protocol"
import { useWorkspace } from "../workspace"
import { KindIcon } from "../components/kind-icon"
import { SidebarToggle } from "../components/sidebar-collapse"
import { timeAgo } from "../time"

/** Archived artifacts: hidden everywhere else, content intact. Restore them, or delete them for good. */
export function ArchivedPage() {
  const { loadArchived, restore, remove, editable, status } = useWorkspace()
  const [items, setItems] = useState<ReadonlyArray<Artifact> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (status !== "ready" || !editable) return
    let cancelled = false
    loadArchived()
      .then((list) => !cancelled && setItems(list))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [status, editable, loadArchived])

  const act = async (id: string, run: (id: string) => Promise<boolean>) => {
    setBusy(id)
    if (await run(id)) setItems((list) => list?.filter((a) => a.id !== id) ?? null)
    setBusy(null)
    setConfirming(null)
  }

  return (
    <div className="mx-auto max-w-[800px] px-4 py-8 md:px-10 md:py-10">
      <div className="flex items-center gap-2">
        <SidebarToggle placement="page" className="-ml-1.5" />
        <h1 className="text-[22px] font-semibold tracking-tight">Archived</h1>
      </div>
      <p className="mt-1 text-[13px] text-muted">Hidden from the workspace, agents and share links. Restoring brings everything back.</p>

      {error && <p className="mt-6 text-[13px] text-danger">{error}</p>}
      {!editable && status === "ready" && <p className="mt-6 text-[13px] text-muted">Only people who can edit can see archived items.</p>}
      {items?.length === 0 && <p className="mt-6 text-[13px] text-muted">Nothing archived.</p>}

      {items && items.length > 0 && (
        <ul className="mt-5 divide-y divide-border border-y border-border">
          {items.map((a) => (
            <li key={a.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
              <KindIcon kind={a.kind} size={16} />
              <span className="min-w-0 flex-1 truncate">{a.title}</span>
              <span className="text-[12px] text-faint">
                {kinds[a.kind].singular} · archived {timeAgo(a.archivedAt ?? a.updatedAt)}
              </span>
              <div className="flex items-center gap-1">
                {confirming === a.id ? (
                  <>
                    <button type="button" onClick={() => setConfirming(null)} className="h-7 rounded-md px-2.5 text-[13px] text-muted hover:bg-hover hover:text-text">
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy === a.id}
                      onClick={() => void act(a.id, remove)}
                      className="h-7 rounded-md bg-danger px-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-60"
                    >
                      Delete for good
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy === a.id}
                      onClick={() => void act(a.id, restore)}
                      className="h-7 rounded-md px-2.5 text-[13px] font-medium hover:bg-hover disabled:opacity-60"
                    >
                      Restore
                    </button>
                    <button type="button" onClick={() => setConfirming(a.id)} className="h-7 rounded-md px-2.5 text-[13px] text-danger hover:bg-hover">
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
