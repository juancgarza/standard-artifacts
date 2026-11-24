import { useCallback, useRef, useState } from "react"
import { ArchiveIcon, ArrowsLeftRightIcon, CheckIcon, DotsThreeIcon, LinkSimpleIcon, TrashIcon } from "@phosphor-icons/react"
import { Popover, useDismiss } from "./header-popover"

export const artifactDeleteMessage = (title: string) => `“${title}” and everything in it will be removed for everyone. This can't be undone.`

/**
 * The header's overflow menu. Archive is one click because it can be undone from
 * the Archived page. Delete asks once, inline, before it removes anything.
 */
export function HeaderMenu({
  kindLabel,
  title,
  onMove,
  onArchive,
  onDelete,
}: {
  kindLabel: string
  title: string
  onMove: () => void
  onArchive: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    setConfirming(false)
  }, [])
  useDismiss(ref, open, close)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
        close()
      }, 900)
    } catch {
      close()
    }
  }

  const item = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        className={`grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text ${open ? "bg-hover text-text" : ""}`}
      >
        <DotsThreeIcon size={20} weight="bold" />
      </button>
      {open && (
        <Popover label={`${kindLabel} actions`} className="w-60 p-1">
          {confirming ? (
            <div className="p-2">
              <div className="text-[13px] font-medium">Delete this {kindLabel.toLowerCase()}?</div>
              <p className="mt-1 text-[12px] leading-snug text-muted">
                {artifactDeleteMessage(title)}
              </p>
              <div className="mt-3 flex justify-end gap-1.5">
                <button type="button" onClick={() => setConfirming(false)} className="h-7 rounded-md px-2.5 text-[13px] text-muted hover:bg-hover hover:text-text">
                  Cancel
                </button>
                <button
                  type="button"
                  autoFocus
                  disabled={deleting}
                  onClick={async () => {
                    setDeleting(true)
                    await onDelete()
                    setDeleting(false)
                  }}
                  className="h-7 rounded-md bg-danger px-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-60"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          ) : (
            <div role="menu">
              <button type="button" role="menuitem" onClick={copy} className={item}>
                {copied ? <CheckIcon size={16} className="text-accent" /> : <LinkSimpleIcon size={16} className="text-muted" />}
                {copied ? "Copied" : "Copy link"}
                <span className="ml-auto text-[11px] text-faint">Members</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  onMove()
                }}
                className={item}
              >
                <ArrowsLeftRightIcon size={16} className="text-muted" />
                Move to folder…
              </button>
              <div className="my-1 h-px bg-border" />
              <button type="button" role="menuitem" onClick={() => void onArchive()} className={item}>
                <ArchiveIcon size={16} className="text-muted" />
                Archive {kindLabel.toLowerCase()}
              </button>
              <button type="button" role="menuitem" onClick={() => setConfirming(true)} className={`${item} text-danger`}>
                <TrashIcon size={16} />
                Delete {kindLabel.toLowerCase()}…
              </button>
            </div>
          )}
        </Popover>
      )}
    </div>
  )
}
