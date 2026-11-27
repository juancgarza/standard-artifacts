import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import {
  ArrowCounterClockwiseIcon,
  ArrowElbowDownLeftIcon,
  CheckIcon,
  SparkleIcon,
  StopIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react"
import type { Block, DocPresence, Member, Mention } from "@standard-artifacts/protocol"
import { isActive, summaryOf } from "./ai"
import { wordDiff } from "./diff"

/** How long a request may sit unclaimed before we suggest starting a runner. */
export const QUEUED_HINT_MS = 8000

export type Vote = "up" | "down"

/**
 * One request's bar, in the doc flow under the block it concerns. It shows the
 * request's whole life: thinking (with Stop), then the review of its pending
 * suggestions (Accept / Discard / Try again / Insert below), an error, or just
 * the agent's summary when it changed nothing.
 */
export function MentionBar({
  mention,
  group,
  agent,
  readOnly,
  claimFocus,
  vote,
  onStop,
  onAccept,
  onDiscard,
  onRetry,
  onInsertBelow,
  onDismiss,
  onVote,
}: {
  mention: Mention | undefined
  /** This request's blocks that are still pending review, in doc order. */
  group: ReadonlyArray<Block>
  /** The runner's presence in the doc, for its live status line. */
  agent: Member | undefined
  readOnly: boolean
  /** Take keyboard focus when nothing else has it (this tab asked, so it's what the person is waiting on). */
  claimFocus: boolean
  vote: Vote | undefined
  onStop: () => void
  onAccept: () => void
  onDiscard: () => void
  onRetry: () => void
  onInsertBelow: () => void
  onDismiss: () => void
  onVote: (vote: Vote) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const active = !!mention && isActive(mention)
  const state = active ? "working" : group.length ? "review" : mention?.status === "error" ? "error" : "result"

  useEffect(() => {
    const el = root.current
    const idle = !document.activeElement || document.activeElement === document.body
    if (claimFocus && el && idle) el.focus({ preventScroll: true })
  }, [claimFocus, state])

  // Measured from when this tab first saw the request (not the server's createdAt, so clock skew can't fake it).
  const [queuedSince] = useState(() => Date.now())
  // Re-render once the request has waited long enough to deserve the runner hint.
  const [, tick] = useState(0)
  const waiting = mention?.status === "queued"
  const late = waiting && Date.now() - queuedSince >= QUEUED_HINT_MS
  useEffect(() => {
    if (!waiting || late) return
    const timer = setTimeout(() => tick((n) => n + 1), QUEUED_HINT_MS - (Date.now() - queuedSince) + 50)
    return () => clearTimeout(timer)
  }, [waiting, late, queuedSince])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return
    if (e.key === "Escape") {
      e.preventDefault()
      if (state === "working") onStop()
      else if (state === "review") onDiscard()
      else onDismiss()
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && state === "review") {
      e.preventDefault()
      onAccept()
    }
  }

  const status = (agent?.presence as DocPresence | undefined)?.status
  const summary = mention?.status === "done" ? summaryOf(mention) : ""
  const changes = `${group.length} change${group.length === 1 ? "" : "s"}`
  const edit = mention?.mode === "edit" && group.some((b) => b.suggestion?.kind === "replace")

  return (
    <div
      ref={root}
      tabIndex={-1}
      role={state === "working" ? "status" : "group"}
      aria-label={state === "working" ? "Claude is working" : state === "review" ? "Review Claude's changes" : "Claude's answer"}
      data-mention-bar={mention?.id ?? ""}
      data-state={state}
      onKeyDown={onKeyDown}
      // Not part of the doc's text: keep it out of selections and copies that span the blocks around it.
      className="my-2 ml-3 rounded-lg border border-border bg-bg px-3 py-2 text-[13px] shadow-sm outline-none select-none focus:border-accent/50 focus:ring-4 focus:ring-accent/10"
    >
      {state === "working" && (
        <div className="flex items-center gap-2">
          <SparkleIcon size={15} weight="fill" className="shrink-0 animate-pulse text-accent" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{status ? `Claude · ${status}` : "Claude is thinking"}</span>
            {!status && <Dots />}
            {group.length > 0 && <span className="text-muted"> · {changes} so far</span>}
          </span>
          {!readOnly && (
            <button type="button" onClick={onStop} title="Stop (esc)" className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-text">
              <StopIcon size={13} weight="fill" /> Stop
            </button>
          )}
        </div>
      )}
      {state === "working" && mention?.status === "queued" && mention.unhosted ? (
        // Billing: the hosted runner won't take it. Said right away, not after the runner hint's wait.
        <div data-unhosted={mention.unhosted.reason} className="mt-1.5 text-[12px] text-muted">
          {mention.unhosted.message}.{" "}
          <a href="/settings/billing" className="font-medium text-accent hover:underline">
            See plans
          </a>
        </div>
      ) : state === "working" && late && (
        <div data-queued-hint className="mt-1.5 text-[12px] text-muted">
          Waiting for an agent runner. Start one with <code className="rounded bg-surface px-1 font-mono text-[11px]">stdartifacts agent serve</code>.
        </div>
      )}

      {state === "review" && (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <SparkleIcon size={15} weight="fill" className="shrink-0 text-accent" />
            {/* Basis 0: the request's label shrinks (and truncates) before the buttons wrap to a new line. */}
            <span className="min-w-[8rem] flex-1 basis-0 truncate" title={mention?.text}>
              <span className="font-medium">Claude suggested {changes}</span>
              {mention?.text && <span className="text-faint"> · {promptLabel(mention.text)}</span>}
            </span>
            {!readOnly && (
              <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1">
                {/* A rewrite reads as a choice of where Claude's text goes: over the original, or below it. */}
                <button type="button" onClick={onAccept} title={edit ? "Replace the original with Claude's version (⌘↵)" : "Accept (⌘↵)"} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-medium text-accent-text hover:opacity-90">
                  <CheckIcon size={13} weight="bold" /> {edit ? "Replace" : "Accept"}
                </button>
                {edit && (
                  <button type="button" onClick={onInsertBelow} title="Keep the original and add Claude's version below it" className="flex items-center gap-1 rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-text">
                    <ArrowElbowDownLeftIcon size={13} /> Insert below
                  </button>
                )}
                <button type="button" onClick={onDiscard} title="Discard (esc)" className="flex items-center gap-1 rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-text">
                  <XIcon size={13} /> Discard
                </button>
                {mention && (
                  <button type="button" onClick={onRetry} title="Discard and ask again" aria-label="Try again" className="grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text">
                    <ArrowCounterClockwiseIcon size={13} />
                  </button>
                )}
              </span>
            )}
          </div>
          {summary && <Summary text={summary} vote={vote} onVote={readOnly ? undefined : onVote} />}
        </>
      )}

      {state === "error" && (
        <div className="flex items-start gap-2">
          <WarningIcon size={15} className="mt-0.5 shrink-0 text-danger" />
          <span data-mention-error className="min-w-0 flex-1 break-words text-danger">
            Claude couldn't finish: {summaryOf(mention) || "unknown error"}
          </span>
          {!readOnly && (
            <span className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={onRetry} className="flex items-center gap-1 rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-text">
                <ArrowCounterClockwiseIcon size={13} /> Try again
              </button>
              <button type="button" onClick={onDismiss} aria-label="Dismiss" className="grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text">
                <XIcon size={13} />
              </button>
            </span>
          )}
        </div>
      )}

      {state === "result" && (
        <div className="flex items-start gap-2">
          <SparkleIcon size={15} weight="fill" className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{mention?.status === "cancelled" ? "Stopped" : "Claude is done"}</div>
            {summary && <Summary text={summary} vote={vote} onVote={readOnly ? undefined : onVote} />}
          </div>
          {!readOnly && (
            <button type="button" onClick={onDismiss} aria-label="Dismiss" title="Dismiss (esc)" className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-text">
              <XIcon size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The request as a short label: quick actions are long prompts, so show their first clause. */
const promptLabel = (text: string) => text.split(/\n/)[0]!.replace(/[.:]\s.*$/, "").replace(/\.$/, "")

function Dots() {
  return (
    <span aria-hidden className="ml-1 inline-flex gap-0.5 align-middle">
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="size-1 animate-pulse rounded-full bg-muted" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  )
}

/** The agent's own words about what it did, with local thumbs up/down. */
function Summary({ text, vote, onVote }: { text: string; vote: Vote | undefined; onVote: ((vote: Vote) => void) | undefined }) {
  return (
    <div className="mt-1.5 flex items-start gap-2 text-muted">
      <p data-mention-summary className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        {text}
      </p>
      {onVote && (
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label="Good response"
            aria-pressed={vote === "up"}
            onClick={() => onVote("up")}
            className={`grid size-6 place-items-center rounded hover:bg-hover ${vote === "up" ? "text-accent" : "text-faint"}`}
          >
            <ThumbsUpIcon size={13} weight={vote === "up" ? "fill" : "regular"} />
          </button>
          <button
            type="button"
            aria-label="Bad response"
            aria-pressed={vote === "down"}
            onClick={() => onVote("down")}
            className={`grid size-6 place-items-center rounded hover:bg-hover ${vote === "down" ? "text-danger" : "text-faint"}`}
          >
            <ThumbsDownIcon size={13} weight={vote === "down" ? "fill" : "regular"} />
          </button>
        </span>
      )}
    </div>
  )
}

/** A pending rewrite as tracked changes: removed words struck through, new words in the accent color. */
export function DiffText({ before, after, className, onMouseDown }: { before: string; after: string; className: string; onMouseDown?: (e: MouseEvent<HTMLDivElement>) => void }) {
  const parts = useMemo(() => wordDiff(before, after), [before, after])
  return (
    <div data-diff className={`${className} break-words whitespace-pre-wrap`} onMouseDown={onMouseDown}>
      {parts.map((p, i) =>
        p.kind === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === "del" ? (
          // A gap before the replacement keeps "~~old~~new" from reading as one word.
          <del key={i} data-diff-del className={`text-muted decoration-danger/70 ${parts[i + 1]?.kind === "add" ? "mr-1" : ""}`}>
            {p.text}
          </del>
        ) : (
          <ins key={i} data-diff-add className="rounded-sm bg-accent/10 text-accent no-underline">
            {p.text}
          </ins>
        ),
      )}
    </div>
  )
}

/** Hover controls on one pending block: accept or discard just this one. */
export function BlockReview({ onAccept, onDiscard }: { onAccept: () => void; onDiscard: () => void }) {
  return (
    <span className="absolute top-0.5 right-0 z-10 hidden items-center select-none gap-0.5 rounded-md border border-border bg-bg p-0.5 shadow-sm group-hover:flex lg:-right-2 lg:translate-x-full">
      <button type="button" aria-label="Accept this block" title="Accept" onClick={onAccept} className="grid size-6 place-items-center rounded text-accent hover:bg-hover">
        <CheckIcon size={13} weight="bold" />
      </button>
      <button type="button" aria-label="Discard this block" title="Discard" onClick={onDiscard} className="grid size-6 place-items-center rounded text-muted hover:bg-hover hover:text-text">
        <XIcon size={13} />
      </button>
    </span>
  )
}
