import { StarIcon } from "@phosphor-icons/react"
import { useWorkspace } from "../workspace"

/**
 * Star/unstar toggle shown as a hover action on artifact rows and cards.
 * Starred items keep a visible filled star; unstarred ones reveal it on hover
 * (the parent needs `group`).
 */
export function StarButton({
  id,
  title,
  pinned = true,
  className = "",
}: {
  id: string
  title: string
  /** Keep the filled star visible when starred (cards and home rows); the sidebar shows it on hover only. */
  pinned?: boolean
  className?: string
}) {
  const { starred, toggleStar } = useWorkspace()
  const on = starred.includes(id)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        toggleStar(id)
      }}
      // A plain toggle name: the row gives context, and titles in labels would collide with other buttons' names.
      aria-label="Star"
      aria-pressed={on}
      title={on ? `Unstar ${title}` : `Star ${title}`}
      className={`grid size-6 place-items-center rounded transition-opacity hover:bg-active focus-visible:opacity-100 max-md:opacity-100 ${
        on ? `text-star ${pinned ? "" : "opacity-0 group-hover:opacity-100"}` : "text-faint opacity-0 group-hover:opacity-100 hover:text-text"
      } ${pinned ? "" : "max-md:hidden"} ${className}`}
    >
      <StarIcon size={14} weight={on ? "fill" : "bold"} />
    </button>
  )
}
