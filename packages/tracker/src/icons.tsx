import { RobotIcon } from "@phosphor-icons/react"
import type { Assignee, IssuePerson, IssuePriority, IssueStatus } from "@standard-artifacts/protocol"
import { BrandTile, brandOf } from "@standard-artifacts/room/brands"

/** Linear-style status glyphs: a ring that fills as the work moves along. */
export function StatusIcon({ status, size = 14 }: { status: IssueStatus; size?: number }) {
  const r = 5.5
  const c = 2 * Math.PI * 2.75
  const common = { width: size, height: size, viewBox: "0 0 14 14", "aria-hidden": true, className: "shrink-0" } as const
  switch (status) {
    case "backlog":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r={r} fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeDasharray="2 2.1" />
        </svg>
      )
    case "todo":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r={r} fill="none" stroke="var(--muted)" strokeWidth="1.5" />
        </svg>
      )
    case "in_progress":
    case "in_review": {
      const color = status === "in_progress" ? "#e5a400" : "#1e9e6a"
      const part = status === "in_progress" ? 0.5 : 0.75
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" />
          <circle cx="7" cy="7" r="2.75" fill="none" stroke={color} strokeWidth="5.5" strokeDasharray={`${c * part} ${c}`} transform="rotate(-90 7 7)" />
        </svg>
      )
    }
    case "done":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6.25" fill="var(--accent)" />
          <path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="var(--accent-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case "canceled":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6.25" fill="var(--faint)" />
          <path d="M5 5l4 4M9 5l-4 4" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
  }
}

/** Bars for high/medium/low, a filled square for urgent, a dash for none. */
export function PriorityIcon({ priority, size = 14 }: { priority: IssuePriority; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 14 14", "aria-hidden": true, className: "shrink-0" } as const
  if (priority === "urgent")
    return (
      <svg {...common}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#e0692a" />
        <path d="M7 3.8v4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="10.1" r="0.95" fill="#fff" />
      </svg>
    )
  if (priority === "none")
    return (
      <svg {...common}>
        {[2, 6, 10].map((x) => (
          <rect key={x} x={x} y="6.25" width="2.4" height="1.5" rx="0.6" fill="var(--faint)" />
        ))}
      </svg>
    )
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : 1
  return (
    <svg {...common}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1.5 + i * 4} y={9 - i * 3} width="3" height={4 + i * 3} rx="0.8" fill={i < filled ? "var(--muted)" : "var(--hover)"} />
      ))}
    </svg>
  )
}

/** Agents without a known mark get a tint; anything else gets the accent. */
const agentTint: Record<string, string> = {}

/** A person's initial on a circle, or an agent's robot on a rounded square (agents never look like people). */
export function AssigneeAvatar({ who, size = 20 }: { who: Assignee | (IssuePerson & { type?: "user" }) | null | undefined; size?: number }) {
  if (!who)
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full border border-dashed border-faint"
        style={{ width: size, height: size }}
        aria-hidden
      />
    )
  if (who.type === "agent") {
    const brand = brandOf(who.id) ?? brandOf(who.name)
    if (brand) return <BrandTile brand={brand} size={size} title={`${who.name} (agent)`} />
    return (
      <span
        className="grid shrink-0 place-items-center rounded-[5px] text-white"
        style={{ width: size, height: size, background: agentTint[who.id] ?? "var(--accent)" }}
        title={`${who.name} (agent)`}
        aria-hidden
      >
        <RobotIcon size={Math.round(size * 0.68)} weight="fill" />
      </span>
    )
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-active font-medium text-text"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}
      title={who.name}
      aria-hidden
    >
      {who.name.charAt(0).toUpperCase()}
    </span>
  )
}
