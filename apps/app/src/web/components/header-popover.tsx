import { useEffect, useState, type ReactNode, type RefObject } from "react"

/** Close on Escape or a pointer down outside `ref`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("pointerdown", onPointer, true)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("pointerdown", onPointer, true)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [ref, open, onClose])
}

/** True one frame after mount, so CSS transitions can run from the initial (hidden) styles. */
export function useEntered() {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return entered
}

/** A small panel anchored under its trigger, right-aligned. Fades and drops in from the trigger. */
export function Popover({ children, className = "", label }: { children: ReactNode; className?: string; label: string }) {
  const entered = useEntered()
  return (
    <div
      role="dialog"
      aria-label={label}
      className={`absolute top-full right-0 z-40 mt-1.5 origin-top-right rounded-lg border border-border bg-bg shadow-lg transition-[opacity,transform] duration-150 ease-out ${
        entered ? "translate-y-0 scale-100 opacity-100" : "-translate-y-1 scale-[0.98] opacity-0"
      } ${className}`}
    >
      {children}
    </div>
  )
}

