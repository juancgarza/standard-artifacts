import { useState, type KeyboardEvent, type ReactNode } from "react"
import { ImageIcon, TrashIcon } from "@phosphor-icons/react"
import { isImageSrc } from "@standard-artifacts/protocol"

/** An image block's upload as this tab sees it: running, or the reason it failed. */
export type ImageUpload = { readonly status: "uploading" } | { readonly status: "failed"; readonly message: string }

/**
 * What images and linked artifacts share: focusable so they can be deleted from the
 * keyboard (`data-doc-figure` is how the editor moves focus here), and a remove button.
 * Their caption is the block's ordinary editable, rendered below this.
 */
export function Figure({
  readOnly,
  onRemove,
  onCaption,
  className,
  children,
}: {
  readOnly: boolean
  onRemove: () => void
  onCaption: () => void
  className: string
  children: ReactNode
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly || e.target !== e.currentTarget) return
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault()
      onRemove()
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault()
      onCaption()
    }
  }
  return (
    <div data-doc-figure tabIndex={readOnly ? -1 : 0} onKeyDown={onKeyDown} className={`group/figure relative mb-1 rounded outline-none focus:ring-2 focus:ring-accent/40 ${className}`}>
      {children}
      {!readOnly && (
        <button
          type="button"
          aria-label="Remove"
          title="Remove"
          onClick={onRemove}
          className="absolute top-2 right-2 z-10 grid size-7 place-items-center rounded-md border border-border bg-bg text-muted opacity-0 shadow-sm group-focus-within/figure:opacity-100 group-hover/figure:opacity-100 hover:text-text focus:opacity-100"
        >
          <TrashIcon size={15} />
        </button>
      )}
    </div>
  )
}

/** The picture half of an image block, or its placeholder until it has one. */
export function DocImage({
  src,
  alt,
  readOnly,
  upload,
  canUpload,
  onPick,
  onLink,
  onRemove,
  onCaption,
}: {
  src: string | undefined
  alt: string
  readOnly: boolean
  upload: ImageUpload | undefined
  canUpload: boolean
  onPick: () => void
  onLink: (src: string) => void
  onRemove: () => void
  onCaption: () => void
}) {
  const [link, setLink] = useState("")
  const [linkError, setLinkError] = useState(false)
  /** The src that failed to load, so a new src gets a fresh try. */
  const [broken, setBroken] = useState<string | null>(null)

  const commitLink = () => {
    const url = link.trim()
    if (!url) return
    // Same check the server makes; uploaded asset paths don't come through here, so only https counts.
    if (url.startsWith("https://") && isImageSrc(url)) onLink(url)
    else setLinkError(true)
  }

  const figure = { readOnly, onRemove, onCaption }

  if (src) {
    return (
      <Figure {...figure} className="w-fit max-w-full">
        {broken === src ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-3 pr-11 text-[13px] text-muted">
            <ImageIcon size={16} className="shrink-0" /> Couldn’t load this image
          </div>
        ) : (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setBroken(src)}
            className="block max-h-[640px] max-w-full rounded"
          />
        )}
      </Figure>
    )
  }

  // Someone else's upload still in flight, as far as a viewer is concerned, is nothing to show yet.
  if (readOnly) return null

  return (
    <Figure {...figure} className="border border-dashed border-border bg-surface px-3 py-3 pr-11 text-[13px] text-muted">
      <div className="flex flex-wrap items-center gap-2">
        <ImageIcon size={16} className="shrink-0" />
        {upload?.status === "uploading" ? (
          <span>Uploading…</span>
        ) : (
          <>
            {canUpload && (
              <button type="button" onClick={onPick} className="rounded border border-border bg-bg px-2 py-0.5 font-medium text-text hover:bg-hover">
                Upload an image
              </button>
            )}
            <input
              type="url"
              value={link}
              aria-label="Image link"
              placeholder={canUpload ? "or paste an image link" : "Paste an image link"}
              onChange={(e) => {
                setLink(e.target.value)
                setLinkError(false)
              }}
              onBlur={commitLink}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitLink()
                }
              }}
              className="min-w-40 flex-1 bg-transparent text-text outline-none placeholder:text-faint"
            />
          </>
        )}
      </div>
      {upload?.status === "failed" && (
        <div role="alert" className="mt-1.5 text-[12px] text-danger">
          {upload.message}
        </div>
      )}
      {linkError && (
        <div role="alert" className="mt-1.5 text-[12px] text-danger">
          Use an https:// link to an image.
        </div>
      )}
    </Figure>
  )
}
