import { useState, type DragEvent } from "react"
import { useWorkspace } from "../workspace"

/** Drag an artifact or folder onto a folder to move it. The custom type keeps other drags (links, files) out. */
const TYPE = "application/x-standard-artifacts-item"

export type DragItem = { type: "artifact" | "folder"; id: string }

/** Props for a row or card people can drag. Empty when they can't edit. */
export function useDragItem() {
  const { editable } = useWorkspace()
  return (item: DragItem) =>
    editable
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData(TYPE, JSON.stringify(item))
            e.dataTransfer.effectAllowed = "move"
          },
        }
      : {}
}

/** Props for a folder (or, with null, the workspace root) that takes drops, and whether a drag is over it. */
export function useDropTarget(folderId: string | null) {
  const { editable, moveArtifact, updateFolder, fail } = useWorkspace()
  const [over, setOver] = useState(false)
  if (!editable) return { over: false, props: {} }

  const carries = (e: DragEvent) => e.dataTransfer.types.includes(TYPE)
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carries(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = "move"
        setOver(true)
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (e: DragEvent) => {
        if (!carries(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const item = JSON.parse(e.dataTransfer.getData(TYPE)) as DragItem
        if (item.type === "folder" && item.id === folderId) return
        const move = item.type === "artifact" ? moveArtifact(item.id, folderId) : updateFolder(item.id, { parentId: folderId })
        move.catch((err: Error) => fail(err.message))
      },
    },
  }
}
