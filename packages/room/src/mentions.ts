import { useCallback, useEffect, useState } from "react"
import type { CreateMention, Mention } from "@standard-artifacts/protocol"

/**
 * What a surface needs from the host to talk to the agent runner. Requests are
 * mentions in the org's inbox; the host adds auth (and `x-dev-as` in dev).
 */
export interface AgentRequests {
  /** File a request about `target` (and the items in `blocks`). */
  ask(request: Omit<CreateMention, "artifactId">): Promise<Mention>
  /** Stop a queued or running request (the runner polls for this and aborts). */
  cancel(id: string): Promise<Mention>
  /** Resolve a request's whole thread. */
  resolve?(id: string): Promise<ReadonlyArray<Mention>>
  /** This artifact's recent requests, newest first. */
  mentions(): Promise<ReadonlyArray<Mention>>
}

export const isActive = (m: Mention) => m.status === "queued" || m.status === "running"

/** The runner's reply, without its trailing "(cost $…)". */
export const summaryOf = (m: Mention | undefined) => (m?.result ?? "").replace(/\s*\(cost \$[\d.]+\)\s*$/, "").trim()

const POLL_MS = 1500

/**
 * An artifact's requests. Polls only while one is queued or running; `wake`
 * changes (an agent starting to work, a new suggestion) trigger a one-off
 * refresh, so requests filed elsewhere (another tab, "@claude" typed in place)
 * show up without polling an idle artifact.
 */
export function useMentions(ai: AgentRequests | undefined, wake: string) {
  const [mentions, setMentions] = useState<ReadonlyArray<Mention>>([])

  const refresh = useCallback(async () => {
    if (!ai) return
    try {
      const fresh = await ai.mentions()
      setMentions((prev) => {
        // Keep requests we filed that the list hasn't caught up with yet.
        const known = new Set(fresh.map((m) => m.id))
        return [...prev.filter((m) => !known.has(m.id) && isActive(m)), ...fresh]
      })
    } catch {
      // A failed poll just means stale status; the next one catches up.
    }
  }, [ai])

  useEffect(() => {
    void refresh()
  }, [refresh, wake])

  const active = mentions.some(isActive)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [active, refresh])

  /** Put mentions we just filed or changed into the list now, ahead of the next poll. */
  const track = useCallback((...ms: ReadonlyArray<Mention>) => {
    const ids = new Set(ms.map((m) => m.id))
    setMentions((prev) => [...ms, ...prev.filter((x) => !ids.has(x.id))])
  }, [])

  return { mentions, track, refresh }
}
