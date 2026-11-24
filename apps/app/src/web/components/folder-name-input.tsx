import { useEffect, useRef, useState } from "react"
import { FolderIcon } from "@phosphor-icons/react"

/**
 * Naming a folder in place, for new ones and renames: opens with the name
 * selected. Enter saves and Escape cancels. A refused name (taken, too deep)
 * stays open with the reason underneath so it can be fixed.
 */
export function FolderNameInput({
  initial,
  label,
  className = "",
  onSubmit,
  onCancel,
}: {
  initial: string
  label: string
  className?: string
  onSubmit: (name: string) => Promise<unknown>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const submit = async () => {
    if (busy.current) return
    const next = name.trim()
    if (!next) return onCancel()
    if (next.includes("/")) return setError("Folder names can't contain a slash")
    busy.current = true
    try {
      await onSubmit(next)
    } catch (e) {
      setError((e as Error).message)
      input.current?.focus()
    } finally {
      busy.current = false
    }
  }

  return (
    <div>
      <div className={`flex items-center gap-2 ${className}`}>
        <FolderIcon size={16} weight="duotone" className="shrink-0 text-muted" />
        <input
          ref={input}
          value={name}
          aria-label={label}
          aria-invalid={!!error}
          maxLength={80}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              e.stopPropagation()
              void submit()
            }
            if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }
          }}
          onBlur={() => {
            // Clicking away saves, or gives up on a name that was already refused.
            if (error) onCancel()
            else void submit()
          }}
          className="min-w-0 flex-1 bg-transparent font-medium outline-none"
        />
      </div>
      {error && (
        <p role="alert" className="px-2 pt-0.5 pb-1 text-[12px] leading-snug text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
