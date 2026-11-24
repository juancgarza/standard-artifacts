import { memo, useEffect, useMemo, useRef, useState } from "react"
import { CodeIcon, XIcon } from "@phosphor-icons/react"
import { maxHtmlLength, type Shape } from "@standard-artifacts/protocol"
import { htmlSandbox, srcdoc } from "./html"

/**
 * The live snippet. Memoized on its inputs so panning and zooming (which
 * re-render every shape) never touch the iframe, and it only reloads when the
 * source changes. Pointer events are off unless the shape is in interact mode,
 * so the canvas can select, drag and resize it like any other shape.
 */
export const HtmlFrame = memo(function HtmlFrame({ html, title, interactive }: { html: string; title: string; interactive: boolean }) {
  const doc = useMemo(() => srcdoc(html), [html])
  /** The document the frame last loaded. A second load of the same one means the snippet navigated itself. */
  const loaded = useRef<string | null>(null)
  const [navigatedFrom, setNavigatedFrom] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  if (navigatedFrom === doc)
    return (
      <div className="grid h-full w-full place-items-center bg-surface p-4 text-center text-[13px] text-muted">
        <div>
          This embed tried to open another page, so it was stopped.
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              loaded.current = null
              setNavigatedFrom(null)
              setAttempt((n) => n + 1)
            }}
            className="mt-2 block w-full rounded-md border border-border bg-bg px-2 py-1 text-text hover:bg-hover"
          >
            Reload
          </button>
        </div>
      </div>
    )

  return (
    <iframe
      key={attempt}
      srcDoc={doc}
      sandbox={htmlSandbox}
      // No powerful features (camera, geolocation, …) and no referrer for the https images it may load.
      allow=""
      referrerPolicy="no-referrer"
      title={title}
      data-interactive={interactive || undefined}
      onLoad={() => {
        if (loaded.current === doc) setNavigatedFrom(doc)
        else loaded.current = doc
      }}
      className="block h-full w-full border-0 bg-white"
      style={{ pointerEvents: interactive ? "auto" : "none" }}
    />
  )
})

/**
 * Stand-in for a snippet that is off-screen, too small to read, or beyond the
 * live-frame budget. Its label is counter-scaled so it stays readable when
 * zoomed out, which is exactly when placeholders show.
 */
export function HtmlPlaceholder({ title, zoom }: { title: string; zoom: number }) {
  const scale = Math.min(4, 1 / zoom)
  return (
    <div data-html-placeholder className="grid h-full w-full place-items-center overflow-hidden bg-surface text-muted">
      <div className="flex flex-col items-center gap-1 text-center" style={{ transform: `scale(${scale})`, width: `${100 / scale}%` }}>
        <CodeIcon size={28} />
        <span className="line-clamp-2 text-[13px]">{title}</span>
      </div>
    </div>
  )
}

/**
 * Side panel for editing a snippet's source and title. If someone else saves
 * while it is open, an untouched draft follows their version; a draft with
 * changes keeps them and says the source moved underneath.
 */
export function HtmlEditorPanel({ shape, onSave, onClose }: { shape: Shape; onSave: (patch: { html: string; text: string }) => void; onClose: () => void }) {
  const current = shape.html ?? ""
  const currentTitle = shape.text ?? ""
  const [base, setBase] = useState({ html: current, title: currentTitle })
  const [html, setHtml] = useState(current)
  const [title, setTitle] = useState(currentTitle)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const dirty = html !== base.html || title !== base.title
  const tooLong = html.length > maxHtmlLength

  useEffect(() => {
    if (dirty || (current === base.html && currentTitle === base.title)) return
    setBase({ html: current, title: currentTitle })
    setHtml(current)
    setTitle(currentTitle)
    // Only follow remote changes; local typing is what `dirty` tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, currentTitle])

  useEffect(() => area.current?.focus(), [])

  const save = () => {
    if (tooLong) return
    onSave({ html, text: title })
    setBase({ html, title })
  }
  const close = () => {
    // Escape twice to throw away unsaved work, so one stray key press doesn't.
    if (dirty && !confirmDiscard) return setConfirmDiscard(true)
    onClose()
  }

  return (
    <div
      data-board-panel
      role="dialog"
      aria-label="Edit HTML"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Canvas shortcuts (delete, tools, arrows) must not fire while typing here.
        e.stopPropagation()
        if (e.key === "Escape") {
          e.preventDefault()
          close()
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          save()
        } else setConfirmDiscard(false)
      }}
      className="absolute top-3 right-3 bottom-20 z-40 flex w-[min(460px,calc(100%-24px))] cursor-default flex-col gap-2 rounded-xl border border-border bg-bg p-3 shadow-lg select-text"
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-text">
        <CodeIcon size={16} />
        Edit HTML
        <button type="button" aria-label="Close" title="Close (Esc)" onClick={close} className="ml-auto grid size-7 place-items-center rounded text-muted hover:bg-hover hover:text-text">
          <XIcon size={15} />
        </button>
      </div>
      <input
        aria-label="Title"
        value={title}
        maxLength={200}
        placeholder="Title"
        onChange={(e) => setTitle(e.target.value)}
        className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-text outline-none focus:border-accent"
      />
      <textarea
        ref={area}
        aria-label="HTML source"
        value={html}
        spellCheck={false}
        // Code reads line by line: no soft wrapping, scroll sideways instead.
        wrap="off"
        onChange={(e) => setHtml(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
          // Tab indents (two spaces) instead of leaving the editor; Esc then Tab still moves focus on.
          e.preventDefault()
          const el = e.currentTarget
          el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end")
          setHtml(el.value)
        }}
        className="min-h-0 flex-1 resize-none rounded-md border border-border bg-surface p-2 font-mono text-[12px] leading-[1.5] text-text outline-none focus:border-accent"
        style={{ tabSize: 2 }}
      />
      {dirty && current !== base.html && <div className="text-[12px] text-danger">Someone else changed this embed since you opened it. Saving replaces their version.</div>}
      <div className="flex items-center gap-2 text-[12px]">
        <span className={tooLong ? "text-danger" : "text-faint"}>
          {html.length.toLocaleString()} / {maxHtmlLength.toLocaleString()} characters
        </span>
        <span className="ml-auto text-faint">{confirmDiscard ? "Esc again to discard" : "⌘↵ to save"}</span>
        <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1 text-muted hover:bg-hover hover:text-text">
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || tooLong}
          className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-text disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  )
}
