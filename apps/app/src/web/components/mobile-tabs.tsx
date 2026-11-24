import { useEffect, useState } from "react"
import { PlusIcon, XIcon } from "@phosphor-icons/react"
import { useTabs } from "../tabs"
import { TabIcon } from "./tab-strip"

/** Small screens have no room for a strip: a count button in the top bar opens the list. */
export function MobileTabs() {
  const { enabled, tabs, activeId, meta, select, closeTab, openAndGo } = useTabs()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  if (!enabled) return null

  return (
    <>
      <button
        type="button"
        aria-label={`Open tabs: ${tabs.length}`}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="-mr-1 ml-auto grid size-8 place-items-center rounded-md hover:bg-hover"
      >
        <span className="grid size-[22px] place-items-center rounded-[6px] border-[1.5px] border-text text-[12px] font-semibold">{tabs.length}</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close tabs" tabIndex={-1} className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div role="dialog" aria-label="Open tabs" className="palette-in absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface px-2.5 pt-2 pb-4">
            <div aria-hidden className="mx-auto mt-0.5 mb-2 h-1 w-9 rounded-full bg-active" />
            <div className="px-2.5 pb-1 text-[12px] font-medium text-faint">Open tabs</div>
            <ul className="space-y-0.5">
              {tabs.map((tab) => {
                const info = meta(tab.href)
                return (
                  <li key={tab.id} className={`flex h-11 items-center rounded-lg ${tab.id === activeId ? "bg-active" : ""}`}>
                    <button
                      type="button"
                      onClick={() => {
                        select(tab.id)
                        setOpen(false)
                      }}
                      className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left"
                    >
                      <TabIcon kind={info.kind} size={16} />
                      <span className="truncate">{info.title}</span>
                    </button>
                    {tabs.length > 1 && (
                      <button type="button" aria-label={`Close ${info.title}`} onClick={() => closeTab(tab.id)} className="grid size-10 shrink-0 place-items-center text-muted">
                        <XIcon size={14} weight="bold" />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
            <button
              type="button"
              onClick={() => {
                openAndGo("/")
                setOpen(false)
              }}
              className="flex h-11 w-full items-center gap-2.5 px-2.5 text-muted"
            >
              <PlusIcon size={16} /> New tab
            </button>
          </div>
        </div>
      )}
    </>
  )
}
