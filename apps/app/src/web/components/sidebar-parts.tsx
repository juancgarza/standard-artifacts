import type { ReactNode } from "react"
import { Link, useParams } from "@tanstack/react-router"
import { CaretRightIcon } from "@phosphor-icons/react"
import { kinds, type Artifact } from "@standard-artifacts/protocol"
import { useTabs } from "../tabs"
import { KindIcon } from "./kind-icon"
import { StarButton } from "./sidebar-star"
import { useDragItem } from "./folder-dnd"

/** What the sidebar's sections and its folder tree share. */

export function useActiveId() {
  return useParams({ strict: false, select: (p) => (p as { id?: string }).id })
}

export function Row({ artifact, onNavigate }: { artifact: Artifact; onNavigate?: () => void }) {
  const drag = useDragItem()
  const { isOpen } = useTabs()
  const activeId = useActiveId()
  const inAnotherTab = artifact.id !== activeId && isOpen(`/${kinds[artifact.kind].slug}/${artifact.id}`)
  return (
    <li className="group relative" {...drag({ type: "artifact", id: artifact.id })}>
      <Link
        to="/$kind/$id/{-$item}"
        params={{ kind: kinds[artifact.kind].slug, id: artifact.id, item: undefined }}
        onClick={onNavigate}
        className="flex h-8 items-center gap-2 rounded-md px-2 group-hover:pr-8 group-focus-within:pr-8 hover:bg-hover"
        activeProps={{ className: "bg-active font-medium" }}
      >
        <KindIcon kind={artifact.kind} size={16} />
        <span className="truncate">{artifact.title}</span>
        {inAnotherTab && <span data-open-in-tab title="Open in a tab" className="ml-auto size-[5px] shrink-0 rounded-full bg-faint group-hover:hidden group-focus-within:hidden" />}
      </Link>
      <StarButton id={artifact.id} title={artifact.title} pinned={false} className="absolute top-1 right-1" />
    </li>
  )
}

export function SectionHeader({
  open,
  onToggle,
  label,
  count,
  children,
}: {
  open: boolean
  onToggle: () => void
  label: ReactNode
  count?: number
  children?: ReactNode
}) {
  return (
    <div className="group flex h-7 items-center rounded-md pr-1 pl-1 hover:bg-hover">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex h-full flex-1 items-center gap-1 text-[12px] font-medium text-muted"
      >
        <CaretRightIcon size={11} weight="bold" className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        {label}
        {count !== undefined && count > 0 && <span className="ml-0.5 text-faint">{count}</span>}
      </button>
      {children}
    </div>
  )
}
