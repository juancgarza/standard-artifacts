import { RobotIcon } from "@phosphor-icons/react"
import type { Member, TablePresence } from "@standard-artifacts/protocol"

/** Avatar stack: people as initials, agents with a robot glyph and a pulse while thinking. */
export function Avatars({ self, others }: { self: Member | null; others: ReadonlyArray<Member> }) {
  // One avatar per actor: the same person in two tabs (or one agent run reconnecting) shows once.
  const groups = new Map<string, { member: Member; count: number; isSelf: boolean }>()
  for (const m of self ? [self, ...others] : others) {
    const key = m.actor.type === "agent" ? m.connectionId : m.actor.id
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { member: m, count: 1, isSelf: m === self })
  }
  const everyone = [...groups.values()]
  if (!everyone.length) return null
  return (
    <div className="flex items-center -space-x-1.5">
      {everyone.slice(0, 6).map(({ member: m, count, isSelf }) => {
        const p = m.presence as TablePresence
        const label = m.actor.type === "agent" ? `${m.name}${p.status ? ` · ${p.status}` : ""}` : m.name
        const tabs = count > 1 ? ` · ${count} tabs` : ""
        return (
          <span
            key={m.connectionId}
            title={isSelf ? `${label} (you)${tabs}` : `${label}${tabs}`}
            className={`relative grid size-7 place-items-center rounded-full border-2 border-bg text-[11px] font-semibold text-white ${p.thinking ? "animate-pulse" : ""}`}
            style={{ background: m.color }}
          >
            {m.actor.type === "agent" ? <RobotIcon size={14} weight="bold" /> : m.name.charAt(0).toUpperCase()}
            {m.readOnly && m.actor.type !== "agent" && (
              <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border border-bg bg-faint" title="View only" />
            )}
          </span>
        )
      })}
      {everyone.length > 6 && <span className="pl-2.5 text-[12px] text-muted">+{everyone.length - 6}</span>}
    </div>
  )
}

/** Small name tag pinned to a cell or card someone else is on. */
export function PresenceTag({ members }: { members: ReadonlyArray<Member> }) {
  const first = members[0]
  if (!first) return null
  const thinking = members.some((m) => (m.presence as TablePresence).thinking)
  return (
    <span
      className="pointer-events-none absolute top-0 right-0 z-20 flex items-center gap-1 rounded-bl px-1 text-[10px] leading-4 font-medium whitespace-nowrap text-white"
      style={{ background: first.color }}
    >
      {first.actor.type === "agent" && <RobotIcon size={10} weight="bold" />}
      {first.name}
      {thinking && "…"}
      {members.length > 1 && ` +${members.length - 1}`}
    </span>
  )
}
