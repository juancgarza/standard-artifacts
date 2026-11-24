import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { RoomClient, type RoomOptions, type RoomSnapshot } from "./index"

/** How long a closing room waits for the cell to acknowledge what was just sent. */
const DRAIN_MS = 1500
const DRAIN_STEP_MS = 100

/**
 * Connect to a room while the component is mounted and visible (or until `url`
 * changes) and re-render on every state, presence, or status change.
 *
 * The client outlives its connection. Effects clean up when an <Activity> hides
 * the component, so a hidden tab holds no socket and shows no presence; coming
 * back reconnects the same client, so the page keeps its content meanwhile.
 *
 * Closing waits a tick, so a child's cleanup can still flush through the open
 * socket, then until those ops are acknowledged: their echoes would otherwise be
 * lost, and the ops sent twice on the way back.
 */
export function useRoom<S, O>(options: RoomOptions<S, O>): { room: RoomClient<S, O>; snapshot: RoomSnapshot<S> } {
  const key = `${options.url}\n${options.actorKey}`
  const [held, setHeld] = useState(() => ({ key, room: new RoomClient(options) }))
  if (held.key !== key) setHeld({ key, room: new RoomClient(options) })
  const room = held.room

  const closing = useRef<{ room: RoomClient<S, O>; timer: ReturnType<typeof setTimeout> } | null>(null)

  useEffect(() => {
    // Back before the close happened (React's dev double-mount, a quick tab switch): it never needs to.
    if (closing.current?.room === room) clearTimeout(closing.current.timer)
    closing.current = null
    // Connect on the next tick: React's dev double-mount would otherwise open and immediately close a socket.
    const connecting = setTimeout(() => room.connect(), 0)
    return () => {
      clearTimeout(connecting)
      let waited = 0
      const attempt = () => {
        if (room.unacknowledged > 0 && waited < DRAIN_MS) {
          waited += DRAIN_STEP_MS
          closing.current = { room, timer: setTimeout(attempt, DRAIN_STEP_MS) }
        } else room.close()
      }
      closing.current = { room, timer: setTimeout(attempt, 0) }
    }
  }, [room])

  const snapshot = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot)
  return { room, snapshot }
}
export { isActive, summaryOf, useMentions, type AgentRequests } from "./mentions"
