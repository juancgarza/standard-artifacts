import { useState, type ReactNode } from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import type { Role } from "@standard-artifacts/protocol"

/** The settings page's building blocks, shared by its sections. */

export const roles: Record<Role, { label: string; help: string }> = {
  owner: { label: "Owner", help: "Edits everything, manages members and looks after the workspace." },
  editor: { label: "Editor", help: "Edits everything and turns share links on or off." },
  viewer: { label: "Viewer", help: "Opens everything but can't change it." },
}

export function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header>
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {children && <p className="mt-1 text-[13px] text-muted">{children}</p>}
    </header>
  )
}

/** A group of rows; `title` labels it when a section has more than one. */
export function Rows({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      {title && <h3 className="mb-2 text-[13px] font-medium">{title}</h3>}
      <div className="divide-y divide-border border-y border-border">{children}</div>
    </section>
  )
}

/** Text on the left, the value or control on the right; they stack when there's no room. */
export function Row({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5">
      <div className="min-w-0 flex-[1_1_220px]">
        <div className="font-medium">{label}</div>
        {help && <p className="mt-0.5 text-[13px] text-muted">{help}</p>}
      </div>
      <div className="min-w-0 text-muted">{children}</div>
    </div>
  )
}

export function ListSkeleton() {
  return (
    <div className="space-y-3 py-3" aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="size-8 animate-pulse rounded-full bg-active" />
          <span className="h-3 w-40 animate-pulse rounded bg-active" />
        </div>
      ))}
    </div>
  )
}

export function Snippet({ label, help, code }: { label: string; help?: string; code: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setState("copied")
    } catch {
      setState("failed")
    }
    setTimeout(() => setState("idle"), 1600)
  }
  return (
    <div className="py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{label}</span>
        {help && <span className="min-w-0 text-[13px] text-muted">{help}</span>}
      </div>
      <div className="mt-1.5 flex items-start gap-1 rounded-md bg-surface py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[12px] leading-5 whitespace-pre">{code}</code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label} setup`}
          title={state === "failed" ? "Couldn't copy. Select the text instead." : "Copy"}
          className="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-text"
        >
          {state === "copied" ? <CheckIcon size={14} weight="bold" className="text-table" /> : <CopyIcon size={14} />}
        </button>
      </div>
    </div>
  )
}
