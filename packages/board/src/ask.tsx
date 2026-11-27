import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  ArrowUpIcon,
  ChatCircleTextIcon,
  CheckIcon,
  CircleNotchIcon,
  ListBulletsIcon,
  LightbulbIcon,
  MagnifyingGlassIcon,
  SparkleIcon,
  SquaresFourIcon,
  StopIcon,
  WarningCircleIcon,
  XIcon,
  LayoutIcon,
  type Icon,
} from "@phosphor-icons/react"
import { isActive, summaryOf } from "@standard-artifacts/room/react"
import type { Mention, MentionTarget } from "@standard-artifacts/protocol"

/**
 * Asking Claude on a board, the way tldraw's agent and comment work does it:
 * you ask from where the thing is (the selection, or the view), the request
 * becomes a thread pinned there — not a note on the canvas — and Claude answers
 * in the thread, changing the canvas only when the request is canvas work.
 * Follow-ups continue the thread; Resolve takes the pin away.
 */

export type Thread = {
  readonly key: string
  readonly target: MentionTarget
  /** Oldest first. */
  readonly mentions: ReadonlyArray<Mention>
}

export const threadStatus = (t: Thread) => {
  const last = t.mentions.at(-1)
  return !last ? "done" : isActive(last) ? last.status : last.status === "error" ? "error" : "done"
}

type QuickAction = { id: string; label: string; icon: Icon; prompt: string }

const actions: ReadonlyArray<QuickAction> = [
  { id: "summarize", label: "Summarize", icon: ListBulletsIcon, prompt: "Summarize this in a few bullets." },
  { id: "brainstorm", label: "Brainstorm more", icon: LightbulbIcon, prompt: "Brainstorm more ideas that build on these, and add them to the board as notes next to them." },
  { id: "organize", label: "Organize into groups", icon: SquaresFourIcon, prompt: "Group these into themes and arrange them on the board: one labeled frame per theme, shapes moved into their frame." },
  { id: "critique", label: "Critique", icon: MagnifyingGlassIcon, prompt: "Critique this: what's unclear, missing or risky? Be specific." },
  { id: "design", label: "Make a design", icon: LayoutIcon, prompt: "Turn this into a polished design frame (HTML/CSS) next to it." },
]

export type AskContextChip = { readonly label: string; readonly icon?: Icon }

/**
 * The prompt bar, anchored above (or below) a selection or in the view. Enter
 * sends what's typed; with nothing typed, Enter runs the highlighted action.
 */
export function AskComposer({
  rect,
  viewport,
  context,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  /** What it's about, in canvas px. */
  rect: { left: number; top: number; right: number; bottom: number }
  viewport: { w: number; h: number }
  context: AskContextChip
  busy: boolean
  error: string | null
  onSubmit: (prompt: string) => void
  onClose: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) onClose()
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [onClose])

  const q = query.trim().toLowerCase()
  const items = q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === "Escape") {
      e.preventDefault()
      return onClose()
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length && !query.includes("\n")) {
      e.preventDefault()
      const floor = q ? -1 : 0
      const span = items.length - floor
      return setActive(((active - floor + (e.key === "ArrowDown" ? 1 : -1) + span) % span) + floor)
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (busy) return
      const item = active >= 0 ? items[active] : undefined
      if (item) return onSubmit(item.prompt)
      if (query.trim()) onSubmit(query.trim())
    }
  }

  const W = 400
  const below = rect.bottom + 12
  const top = below + 240 <= viewport.h ? below : Math.max(12, rect.top - 12 - 240)
  const left = Math.max(12, Math.min(viewport.w - W - 12, (rect.left + rect.right) / 2 - W / 2))

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Ask Claude"
      className="absolute z-40"
      style={{ left, top, width: W }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="rounded-xl border border-accent/40 bg-bg shadow-lg ring-4 ring-accent/10">
        <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
          <SparkleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-accent" />
          <textarea
            ref={input}
            rows={1}
            value={query}
            disabled={busy}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(e.target.value.trim() ? -1 : 0)
              e.target.style.height = "auto"
              e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`
            }}
            onKeyDown={onKeyDown}
            placeholder="Ask Claude about this…"
            aria-label="Ask Claude"
            className="min-w-0 flex-1 resize-none bg-transparent text-[14px] leading-5 outline-none placeholder:text-faint"
          />
          <button
            type="button"
            aria-label="Send"
            title="Send (↵)"
            disabled={busy || !query.trim()}
            onClick={() => query.trim() && onSubmit(query.trim())}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-accent-text transition-opacity disabled:opacity-30"
          >
            {busy ? <CircleNotchIcon size={14} className="animate-spin" /> : <ArrowUpIcon size={14} weight="bold" />}
          </button>
        </div>
        <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5">
          <span className="text-[11px] text-faint">Context</span>
          <span data-ask-context className="flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
            {context.icon && <context.icon size={11} />}
            {context.label}
          </span>
          <span className="ml-auto text-[11px] text-faint">⇧↵ new line · Esc</span>
        </div>
      </div>
      {error && <div className="mt-1 rounded-md bg-bg px-3 py-1.5 text-[12px] text-danger shadow">{error}</div>}
      {items.length > 0 && !busy && (
        <div role="listbox" aria-label="Claude actions" className="mt-1 w-60 rounded-lg border border-border bg-bg p-1 shadow-lg">
          {items.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => onSubmit(a.prompt)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${i === active ? "bg-hover text-text" : "text-muted"}`}
            >
              <a.icon size={14} className="text-accent" />
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A thread's pin on the canvas: Claude's mark, with what it's doing. */
export function ThreadPin({ thread, left, top, open, onToggle }: { thread: Thread; left: number; top: number; open: boolean; onToggle: () => void }) {
  const status = threadStatus(thread)
  const n = thread.mentions.length
  const label = status === "running" ? "Claude is working" : status === "queued" ? "Waiting for Claude" : status === "error" ? "Claude couldn't finish" : "Claude replied"
  return (
    <button
      type="button"
      data-thread-pin={thread.key}
      data-status={status}
      aria-label={`${label} (${n} request${n === 1 ? "" : "s"})`}
      aria-expanded={open}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={onToggle}
      className={`absolute z-20 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full rounded-bl-sm border-2 shadow-md transition-transform hover:scale-110 ${
        status === "error" ? "border-danger bg-bg text-danger" : open ? "border-accent bg-accent text-accent-text" : "border-accent bg-bg text-accent"
      }`}
      style={{ left, top }}
    >
      {status === "running" || status === "queued" ? (
        <CircleNotchIcon size={14} weight="bold" className={status === "running" ? "animate-spin" : "opacity-50"} />
      ) : status === "error" ? (
        <WarningCircleIcon size={14} weight="bold" />
      ) : (
        <SparkleIcon size={13} weight="fill" />
      )}
      {n > 1 && <span className="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-text px-1 text-[9px] leading-4 font-semibold text-bg">{n}</span>}
    </button>
  )
}

/** Light formatting for replies: paragraphs, bullets, **bold** and `code`. */
function Reply({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith("`") && part.endsWith("`") ? <code key={i} className="rounded bg-surface px-1 text-[12px]">{part.slice(1, -1)}</code> : part,
    )
  const blocks = text.split(/\n{2,}/)
  return (
    <div className="space-y-1.5 text-[13px] leading-5 text-text">
      {blocks.map((b, i) => {
        const lines = b.split("\n")
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)))
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-4">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>)}
            </ul>
          )
        const heading = /^#{1,4}\s+/.test(b)
        return heading ? <p key={i} className="font-semibold">{inline(b.replace(/^#{1,4}\s+/, ""))}</p> : <p key={i} className="whitespace-pre-wrap">{inline(b)}</p>
      })}
    </div>
  )
}

const requestText = (m: Mention) => m.text.replace(/(^|\s)@(claude|agent)\b\s*/gi, "$1").trim() || m.text

/** An open thread: each request with Claude's reply, a reply box, and Resolve. */
export function ThreadCard({
  thread,
  left,
  top,
  viewport,
  agentStatus,
  readOnly,
  onReply,
  onStop,
  onResolve,
  onClose,
}: {
  thread: Thread
  left: number
  top: number
  viewport: { w: number; h: number }
  /** What the agent's presence says it's doing right now. */
  agentStatus: string | undefined
  readOnly: boolean
  onReply: (text: string) => Promise<void>
  onStop: (m: Mention) => void
  onResolve: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const last = thread.mentions.at(-1)
  const active = !!last && isActive(last)

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [thread.mentions.length, last?.status])

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      await onReply(text)
      setDraft("")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const W = 340
  // Beside the pin, never over it: to its right, or its left when the right has no room.
  const x = left + 20 + W <= viewport.w - 12 ? left + 20 : Math.max(12, left - 20 - W)
  const y = Math.max(12, Math.min(viewport.h - 380, top - 14))

  return (
    <div
      role="dialog"
      aria-label="Claude thread"
      data-thread-card={thread.key}
      className="absolute z-40 flex max-h-[360px] flex-col rounded-xl border border-border bg-bg shadow-xl"
      style={{ left: x, top: y, width: W }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") onClose()
      }}
    >
      <div className="flex items-center gap-1 border-b border-border py-1.5 pr-1.5 pl-3">
        <ChatCircleTextIcon size={14} className="text-accent" />
        <span className="text-[12px] font-medium text-muted">Claude</span>
        <span className="flex-1" />
        {!readOnly && (
          <button type="button" onClick={onResolve} title="Resolve: done with this thread" className="flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-muted hover:bg-hover hover:text-text">
            <CheckIcon size={13} weight="bold" /> Resolve
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-6 place-items-center rounded text-muted hover:bg-hover hover:text-text">
          <XIcon size={13} />
        </button>
      </div>
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        {thread.mentions.map((m) => (
          <div key={m.id} data-mention={m.id} data-status={m.status} className="space-y-1.5">
            <div>
              <div className="text-[11px] font-medium text-faint">{m.requestedByName}</div>
              <div className="text-[13px] leading-5 whitespace-pre-wrap text-text">{requestText(m)}</div>
            </div>
            <div className="border-l-2 border-accent/50 pl-2.5">
              <div className="flex items-center gap-1 text-[11px] font-medium text-accent">
                <SparkleIcon size={10} weight="fill" /> Claude
              </div>
              {m.status === "queued" && m.unhosted ? (
                // Billing: the hosted runner won't take it. It stays filed for the person's own agent.
                <div data-unhosted={m.unhosted.reason} className="space-y-1 py-0.5 text-[13px] text-muted">
                  <p>{m.unhosted.message}</p>
                  <div className="flex items-center gap-2">
                    <a href="/settings/billing" className="font-medium text-accent hover:underline">
                      See plans
                    </a>
                    {!readOnly && (
                      <button type="button" onClick={() => onStop(m)} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] hover:bg-hover hover:text-text">
                        <StopIcon size={11} weight="fill" /> Stop
                      </button>
                    )}
                  </div>
                </div>
              ) : isActive(m) ? (
                <div className="flex items-center gap-2 py-0.5 text-[13px] text-muted">
                  <CircleNotchIcon size={13} className={m.status === "running" ? "animate-spin" : "opacity-50"} />
                  <span className="flex-1">{m.status === "queued" ? "Waiting for a runner…" : (agentStatus ?? "Working…")}</span>
                  {!readOnly && (
                    <button type="button" onClick={() => onStop(m)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] hover:bg-hover hover:text-text">
                      <StopIcon size={11} weight="fill" /> Stop
                    </button>
                  )}
                </div>
              ) : m.status === "cancelled" ? (
                <div className="text-[13px] text-faint">Stopped</div>
              ) : m.status === "error" ? (
                <div className="text-[13px] text-danger">{summaryOf(m) || "Couldn't finish"}</div>
              ) : (
                <Reply text={summaryOf(m) || "Done."} />
              )}
            </div>
          </div>
        ))}
      </div>
      {!readOnly && (
        <div className="border-t border-border p-2">
          <div className="flex items-end gap-2 rounded-lg border border-border px-2 py-1.5 focus-within:border-accent/50">
            <textarea
              rows={1}
              value={draft}
              disabled={sending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={active ? "Claude is still working…" : "Reply to Claude…"}
              aria-label="Reply to Claude"
              className="max-h-24 min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-5 outline-none placeholder:text-faint"
            />
            <button
              type="button"
              aria-label="Send reply"
              disabled={sending || !draft.trim()}
              onClick={() => void send()}
              className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-accent-text disabled:opacity-30"
            >
              {sending ? <CircleNotchIcon size={12} className="animate-spin" /> : <ArrowUpIcon size={12} weight="bold" />}
            </button>
          </div>
          {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
        </div>
      )}
    </div>
  )
}
