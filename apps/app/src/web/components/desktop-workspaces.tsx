import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { CaretUpDownIcon, CheckIcon, CloudIcon, HardDrivesIcon, LaptopIcon, PlusIcon, SpinnerGapIcon } from "@phosphor-icons/react"
import type { DesktopBridge, DesktopWorkspace, DesktopWorkspaces } from "@standard-artifacts/protocol"
import { useDismiss, useEntered } from "./header-popover"

/**
 * The desktop app's workspaces: Standard Artifacts Cloud, this computer (Solo), and
 * servers someone hosts. Only the desktop app knows them, so in a browser all of
 * this renders nothing. The page only ever passes back an id from the app's list.
 */
const bridge = (window as { standardArtifactsDesktop?: DesktopBridge }).standardArtifactsDesktop
const desktop = bridge?.workspaces && bridge.openWorkspace && bridge.addWorkspace ? bridge : null

/** The desktop app's workspace list, or null in a browser (or an older desktop build). */
export function useDesktopWorkspaces(): DesktopWorkspaces | null {
  const [list, setList] = useState<DesktopWorkspaces | null>(null)
  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.workspaces!().then(
      (next) => !cancelled && setList(next),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [])
  return list
}

export const openDesktopWorkspace = (id: string) => desktop?.openWorkspace?.(id) ?? Promise.resolve()
export const addDesktopWorkspace = () => desktop?.addWorkspace?.() ?? Promise.resolve()

const kindLabel = { cloud: "Cloud", local: "Local", server: "Server" } as const

export function WorkspaceKindIcon({ kind, size = 14 }: { kind: DesktopWorkspace["kind"]; size?: number }) {
  const Icon = kind === "cloud" ? CloudIcon : kind === "local" ? LaptopIcon : HardDrivesIcon
  return <Icon size={size} weight="duotone" className="shrink-0 text-accent" />
}

const item = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover disabled:opacity-60"

/**
 * Rows for the desktop app's other workspaces, inside a menu that already shows the current
 * one (the account menu lists Cloud's orgs itself). Nothing in a browser.
 */
export function OtherDesktopWorkspaces({ list }: { list: DesktopWorkspaces }) {
  const [busy, setBusy] = useState<string | null>(null)
  const others = list.workspaces.filter((w) => w.id !== list.current)
  const go = (key: string, run: () => Promise<void>) => {
    setBusy(key)
    run().finally(() => setBusy(null))
  }
  return (
    <div className="mt-1 border-t border-border pt-1">
      <div className="px-2 pt-1 pb-1 text-[12px] font-medium text-faint">Other places</div>
      {others.map((w) => (
        <button key={w.id} type="button" role="menuitem" disabled={busy !== null} onClick={() => go(w.id, () => openDesktopWorkspace(w.id))} className={item}>
          <span className="grid size-5 shrink-0 place-items-center">
            <WorkspaceKindIcon kind={w.kind} />
          </span>
          <span className="min-w-0 flex-1 truncate">{w.label}</span>
          {busy === w.id ? <SpinnerGapIcon size={14} className="animate-spin text-muted" /> : <span className="text-[12px] text-faint">{kindLabel[w.kind]}</span>}
        </button>
      ))}
      <button type="button" role="menuitem" disabled={busy !== null} onClick={() => go("add", addDesktopWorkspace)} className={`${item} text-muted`}>
        <PlusIcon size={14} className="mx-[3px]" /> Add a workspace…
      </button>
    </div>
  )
}

/**
 * The sidebar's switcher where there's no account to hang it on: the Solo server on this
 * computer, or a server without sign-in, inside the desktop app. Elsewhere, `fallback`.
 */
export function DesktopWorkspaceSwitcher({ fallback }: { fallback: ReactNode }) {
  const list = useDesktopWorkspaces()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const current = list?.workspaces.find((w) => w.id === list.current)
  if (!list || !current) return <>{fallback}</>

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Workspace"
        className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-hover ${open ? "bg-hover" : ""}`}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-active">
          <WorkspaceKindIcon kind={current.kind} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">{current.label}</span>
        <CaretUpDownIcon size={13} className="shrink-0 text-faint" />
      </button>
      {open && <SwitcherMenu list={list} current={current} />}
    </div>
  )
}

function SwitcherMenu({ list, current }: { list: DesktopWorkspaces; current: DesktopWorkspace }) {
  const entered = useEntered()
  return (
    <div
      role="menu"
      aria-label="Workspace"
      className={`absolute bottom-full left-0 z-40 mb-1.5 w-[224px] origin-bottom-left rounded-lg border border-border bg-bg p-1 shadow-lg transition-[opacity,transform] duration-150 ease-out ${
        entered ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[0.98] opacity-0"
      }`}
    >
      <div className="px-2 pt-1.5 pb-2">
        <div className="truncate text-[13px] font-medium">{current.label}</div>
        <div className="truncate text-[12px] text-muted">
          {current.kind === "local" ? "Solo. Your work stays on this computer." : current.kind === "server" ? (current.detail ?? "A self-hosted server") : "Standard Artifacts Cloud"}
        </div>
      </div>
      <div className="border-t border-border pt-1">
        <button type="button" role="menuitemradio" aria-checked className={item}>
          <span className="grid size-5 shrink-0 place-items-center">
            <WorkspaceKindIcon kind={current.kind} />
          </span>
          <span className="min-w-0 flex-1 truncate">{current.label}</span>
          <CheckIcon size={14} weight="bold" className="text-accent" />
        </button>
      </div>
      <OtherDesktopWorkspaces list={list} />
    </div>
  )
}
