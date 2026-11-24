import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

/** A step before something that can't be undone. The menu stays open, showing this, until `run` settles. */
export type MenuConfirm = {
  readonly title: string
  readonly message: string
  readonly action: string
  readonly run: () => Promise<void>
}

export type MenuEntry =
  | "-"
  | ({
      readonly label: string
      readonly icon?: ReactNode
      /** Muted, at the row's end: a shortcut, or "Current". */
      readonly hint?: string
      readonly disabled?: boolean
      readonly danger?: boolean
    } & ({ readonly run: () => void } | { readonly confirm: MenuConfirm }))

/** A menu at a point. In a portal, like FolderMenu's, because the sidebar's peek would capture fixed positioning. */
export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: ReadonlyArray<MenuEntry>; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const [confirming, setConfirming] = useState<MenuConfirm | null>(null)
  const [busy, setBusy] = useState(false)

  useLayoutEffect(() => {
    if (!panel.current) return
    const p = panel.current.getBoundingClientRect()
    const margin = 8
    setAt({
      left: Math.max(margin, Math.min(x, window.innerWidth - p.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - p.height - margin)),
    })
  }, [x, y, confirming])

  // Hand focus back to wherever it was, so closing with Escape doesn't strand the keyboard.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  // The first item, or the confirm step's action, as with the header's Delete.
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>(confirming ? "[data-menu-confirm]" : "button:not(:disabled)")?.focus({ preventScroll: true })
  }, [confirming])

  const confirm = async () => {
    if (!confirming) return
    setBusy(true)
    try {
      await confirming.run()
    } finally {
      onClose()
    }
  }

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("pointerdown", onPointer, true)
    document.addEventListener("keydown", onKey, true)
    window.addEventListener("blur", onClose)
    window.addEventListener("resize", onClose)
    return () => {
      document.removeEventListener("pointerdown", onPointer, true)
      document.removeEventListener("keydown", onKey, true)
      window.removeEventListener("blur", onClose)
      window.removeEventListener("resize", onClose)
    }
  }, [onClose])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
    const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus()
  }

  return createPortal(
    <div
      ref={panel}
      role={confirming ? "alertdialog" : "menu"}
      aria-label={confirming?.title}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={at ? { top: at.top, left: at.left } : { top: 0, left: 0, visibility: "hidden" }}
      className="palette-in fixed z-50 max-h-[min(420px,80vh)] w-60 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-lg"
    >
      {confirming ? (
        <div className="p-2">
          <div className="text-[13px] font-medium">{confirming.title}</div>
          <p className="mt-1 text-[12px] leading-snug text-muted">{confirming.message}</p>
          <div className="mt-3 flex justify-end gap-1.5">
            <button type="button" onClick={() => setConfirming(null)} className="h-7 rounded-md px-2.5 text-[13px] text-muted hover:bg-hover hover:text-text">
              Cancel
            </button>
            <button
              type="button"
              data-menu-confirm
              disabled={busy}
              onClick={() => void confirm()}
              className="h-7 rounded-md bg-danger px-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Deleting…" : confirming.action}
            </button>
          </div>
        </div>
      ) : (
        entries.map((entry, i) =>
          entry === "-" ? (
            <div key={i} className="my-1 h-px bg-border" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onClick={() => {
                if ("confirm" in entry) return setConfirming(entry.confirm)
                onClose()
                entry.run()
              }}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover disabled:pointer-events-none disabled:text-faint ${entry.danger ? "text-danger" : ""}`}
            >
              {entry.icon}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.hint && <span className="shrink-0 text-[11px] text-faint">{entry.hint}</span>}
            </button>
          ),
        )
      )}
    </div>,
    document.body,
  )
}
