import { useState } from "react"
import { RobotIcon } from "@phosphor-icons/react"
import { BrandTile, brandOf } from "@standard-artifacts/room/brands"
import { colorFor } from "@standard-artifacts/protocol"

/**
 * An agent's app icon, as a rounded tile (agents are tiles, people are
 * circles): the well-known apps by their own mark, others by the logo they
 * registered (https only, loaded without a referrer), else their initial.
 */
export function AgentTile({ name, logoUri, size = 32 }: { name: string; logoUri?: string | null | undefined; size?: number }) {
  const [broken, setBroken] = useState(false)
  const brand = brandOf(name)
  const radius = Math.max(4, Math.round(size * 0.26))
  if (brand) return <BrandTile brand={brand} size={size} title={name} />
  if (logoUri?.startsWith("https://") && !broken) {
    return (
      <img
        src={logoUri}
        alt=""
        title={name}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        style={{ width: size, height: size, borderRadius: radius }}
        className="shrink-0 bg-surface object-contain ring-1 ring-border ring-inset"
      />
    )
  }
  const initial = name.trim().charAt(0).toUpperCase()
  return (
    <span role="img" aria-label={name} title={name} style={{ width: size, height: size, borderRadius: radius, background: colorFor(name) }} className="grid shrink-0 place-items-center font-semibold text-white">
      {initial && /[A-Z0-9]/.test(initial) ? <span style={{ fontSize: Math.round(size * 0.44) }}>{initial}</span> : <RobotIcon size={Math.round(size * 0.55)} weight="bold" />}
    </span>
  )
}

/** The Standard Artifacts mark: the four artifact kinds. */
export function AppMark({ size = 36 }: { size?: number }) {
  return (
    <svg viewBox="0 0 22 22" width={size} height={size} aria-hidden="true">
      <rect width="10" height="10" rx="2" fill="var(--table)" />
      <rect x="12" width="10" height="10" rx="2" fill="var(--board)" />
      <rect y="12" width="10" height="10" rx="2" fill="var(--doc)" />
      <rect x="12" y="12" width="10" height="10" rx="2" fill="var(--tracker)" />
    </svg>
  )
}
