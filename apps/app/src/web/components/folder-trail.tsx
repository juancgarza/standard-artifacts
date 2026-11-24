import { Fragment } from "react"
import { Link } from "@tanstack/react-router"
import { folderPath, folderTrail } from "@standard-artifacts/protocol"
import { useWorkspace } from "../workspace"

/** Crumbs shown before the middle collapses to "…". The tooltip keeps the whole path. */
const SHOWN = 2

/** A folder's path as links, for a page header: "… / Launch / Assets". */
export function FolderTrail({ folderId }: { folderId: string }) {
  const { folders } = useWorkspace()
  const trail = folderTrail(folders, folderId)
  const shown = trail.slice(-SHOWN)
  return (
    <span className="hidden min-w-0 items-center gap-2 sm:flex" title={folderPath(folders, folderId)}>
      {trail.length > SHOWN && (
        <>
          <span className="text-muted">…</span>
          <span className="text-faint">/</span>
        </>
      )}
      {shown.map((f, i) => (
        <Fragment key={f.id}>
          {i > 0 && <span className="text-faint">/</span>}
          <Link to="/folders/$id" params={{ id: f.id }} className="max-w-[160px] truncate rounded px-0.5 text-muted hover:text-text">
            {f.name}
          </Link>
        </Fragment>
      ))}
    </span>
  )
}
