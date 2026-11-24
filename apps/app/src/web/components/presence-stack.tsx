import { useCallback, useRef, useState } from "react"
import { EyeIcon, RobotIcon } from "@phosphor-icons/react"
import { BrandTile, brandOf } from "@standard-artifacts/tracker"
import type { Actor, Member } from "@standard-artifacts/protocol"
import type { RoomStatus } from "@standard-artifacts/room"
import { Popover, useDismiss } from "./header-popover"

/** What the artifact page knows about who is in the room (lifted from the view's room snapshot). */
export type LivePresence = { self: Member | null; others: ReadonlyArray<Member>; status: RoomStatus | null }

type Entry = { member: Member; count: number; isSelf: boolean }

/** Agents carry a display name in newer tickets; older ones read as "Agent". */
export const memberName = (m: Member) => (m.actor.type === "agent" ? (m.actor.name ?? m.name) : m.name)

/**
 * One entry per person (the same person in two tabs shows once) and one per
 * agent run. You first, then people, then agents.
 */
function entries(self: Member | null, others: ReadonlyArray<Member>): Entry[] {
  const groups = new Map<string, Entry>()
  for (const m of self ? [self, ...others] : others) {
    const key = m.actor.type === "agent" ? m.connectionId : m.actor.id
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { member: m, count: 1, isSelf: m === self })
  }
  const rank = (e: Entry) => (e.isSelf ? 0 : e.member.actor.type === "agent" ? 2 : 1)
  return [...groups.values()].sort((a, b) => rank(a) - rank(b))
}

const thinking = (m: Member) => m.presence["thinking"] === true
const agentStatus = (m: Member) => (typeof m.presence["status"] === "string" ? (m.presence["status"] as string) : null)

export function Avatar({ member, size = 28, ring = true }: { member: Member; size?: number; ring?: boolean }) {
  const agent = member.actor.type === "agent"
  // Known agents show their app's mark (Claude, ChatGPT, Codex); others keep the robot on their color.
  const brand = agent ? brandOf(memberName(member)) : null
  if (brand)
    return (
      <span className={`relative grid shrink-0 rounded-[8px] ${ring ? "ring-2 ring-bg" : ""}`} data-agent-brand={brand}>
        <BrandTile brand={brand} size={size} title={memberName(member)} />
        {thinking(member) && <span aria-hidden className="absolute -inset-[3px] animate-pulse rounded-[10px] border-2" style={{ borderColor: member.color }} />}
      </span>
    )
  return (
    <span
      className={`relative grid shrink-0 place-items-center font-semibold text-white ${agent ? "rounded-[8px]" : "rounded-full"} ${ring ? "ring-2 ring-bg" : ""}`}
      style={{ background: member.color, width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {agent ? <RobotIcon size={Math.round(size * 0.55)} weight="bold" /> : memberName(member).charAt(0).toUpperCase()}
      {thinking(member) && (
        <span aria-hidden className={`absolute -inset-[3px] animate-pulse border-2 ${agent ? "rounded-[10px]" : "rounded-full"}`} style={{ borderColor: member.color }} />
      )}
    </span>
  )
}

/** "acts for JC" when the person it acts for is here too (we only know ids otherwise). */
function actsFor(actor: Extract<Actor, { type: "agent" }>, everyone: ReadonlyArray<Entry>, self: Member | null) {
  if (self && self.actor.id === actor.onBehalfOf) return "acts for you"
  const person = everyone.find((e) => e.member.actor.type === "user" && e.member.actor.id === actor.onBehalfOf)
  return person ? `acts for ${person.member.name}` : null
}

const MAX = 4
const MOBILE_MAX = 2

const More = ({ n, className }: { n: number; className: string }) => (
  <span className={`ml-1 grid h-7 min-w-7 place-items-center rounded-full bg-active px-1.5 text-[11px] font-medium text-muted ${className}`}>+{n}</span>
)

export function PresenceStack({ live, kindLabel }: { live: LivePresence; kindLabel: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)

  const everyone = entries(live.self, live.others)
  if (!everyone.length) return null
  const shown = everyone.slice(0, MAX)
  const extra = everyone.length - shown.length
  const agents = everyone.filter((e) => e.member.actor.type === "agent").length
  const people = everyone.length - agents
  const summary = [people && `${people} ${people === 1 ? "person" : "people"}`, agents && `${agents} ${agents === 1 ? "agent" : "agents"}`].filter(Boolean).join(" and ")

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`In this ${kindLabel.toLowerCase()}: ${summary}`}
        title={everyone.map((e) => memberName(e.member) + (e.isSelf ? " (you)" : "")).join(", ")}
        className="flex items-center rounded-full p-0.5 transition-colors hover:bg-hover"
      >
        <span className="flex items-center -space-x-1.5">
          {shown.map((e, i) => (
            <span key={e.member.connectionId} className={i >= MOBILE_MAX ? "max-sm:hidden" : ""}>
              <Avatar member={e.member} />
            </span>
          ))}
        </span>
        {/* Phones show fewer faces, so the overflow count differs by breakpoint. */}
        {everyone.length > MOBILE_MAX && <More n={everyone.length - MOBILE_MAX} className="sm:hidden" />}
        {extra > 0 && <More n={extra} className="max-sm:hidden" />}
      </button>

      {open && (
        <Popover label="Who's here" className="w-72 p-1.5">
          <div className="px-2 pt-1 pb-1.5 text-[12px] font-medium text-muted">In this {kindLabel.toLowerCase()} now</div>
          <ul>
            {everyone.map((e) => {
              const m = e.member
              const agent = m.actor.type === "agent" ? m.actor : null
              const detail = agent
                ? [agentStatus(m) ?? (thinking(m) ? "thinking" : null), actsFor(agent, everyone, live.self)].filter(Boolean).join(" · ")
                : m.readOnly
                  ? "Viewing"
                  : "Can edit"
              return (
                <li key={m.connectionId} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                  <Avatar member={m} size={26} ring={false} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                      {memberName(m)}
                      {e.isSelf && <span className="font-normal text-muted">(you)</span>}
                      {agent && <span className="rounded bg-active px-1 py-px text-[10px] font-medium tracking-wide text-muted uppercase">Agent</span>}
                    </div>
                    <div className="truncate text-[12px] text-muted">
                      {detail || "Agent"}
                      {e.count > 1 && ` · ${e.count} tabs`}
                    </div>
                  </div>
                  {m.readOnly && !agent && <EyeIcon size={14} className="shrink-0 text-faint" aria-label="View only" />}
                </li>
              )
            })}
          </ul>
        </Popover>
      )}
    </div>
  )
}

/** A key that changes only when the header's view of the room changes (not on every cursor move). */
export function presenceKey(live: LivePresence) {
  const one = (m: Member) => `${m.connectionId}|${memberName(m)}|${m.readOnly}|${thinking(m)}|${agentStatus(m) ?? ""}`
  return `${live.status}#${live.self ? one(live.self) : ""}#${live.others.map(one).join(",")}`
}
