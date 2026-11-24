import { FileTextIcon, ListChecksIcon, ShapesIcon, TableIcon, type IconProps } from "@phosphor-icons/react"
import type { ArtifactKind } from "@standard-artifacts/protocol"

const icons = { board: ShapesIcon, table: TableIcon, doc: FileTextIcon, tracker: ListChecksIcon }
const colors = { board: "text-board", table: "text-table", doc: "text-doc", tracker: "text-tracker" }
const tiles = { board: "bg-board/12", table: "bg-table/12", doc: "bg-doc/12", tracker: "bg-tracker/12" }

export function KindIcon({ kind, className = "", ...props }: { kind: ArtifactKind } & IconProps) {
  const Icon = icons[kind]
  return <Icon weight="duotone" className={`shrink-0 ${colors[kind]} ${className}`} {...props} />
}

/** The kind icon on a tinted square, for lists and cards where the icon needs more presence. */
export function KindTile({ kind, size = 28, className = "" }: { kind: ArtifactKind; size?: number; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-md ${tiles[kind]} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <KindIcon kind={kind} size={Math.round(size * 0.6)} />
    </span>
  )
}
