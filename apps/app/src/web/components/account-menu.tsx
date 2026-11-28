import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { CaretUpDownIcon, CheckIcon, PlusIcon, SignOutIcon, SpinnerGapIcon } from "@phosphor-icons/react"
import { colorFor, type SessionOrgChoice } from "@standard-artifacts/protocol"
import { createOrg, listOrgs, signOut, switchOrg, type SignedIn } from "../session"
import { OtherDesktopWorkspaces, useDesktopWorkspaces } from "./desktop-workspaces"
import { useDismiss, useEntered } from "./header-popover"

/** Their picture from the account, else their initial on their color. */
export function Avatar({ name, id, url, size = 24 }: { name: string; id: string; url: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size, fontSize: Math.round(size * 0.44) }
  if (url && !broken) {
    return <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={style} className="shrink-0 rounded-full object-cover" />
  }
  return (
    <span style={{ ...style, background: colorFor(id) }} className="grid shrink-0 place-items-center rounded-full font-semibold text-white">
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

const roleLabel = { owner: "Owner", editor: "Editor", viewer: "Viewer" } as const

/**
 * Who's signed in, which workspace they're in, and the way out. Switching
 * workspace re-scopes the session to that org and starts the app over there.
 */
export function AccountMenu({ account }: { account: SignedIn }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-hover ${open ? "bg-hover" : ""}`}
      >
        <Avatar name={account.user.name} id={account.user.id} url={account.user.avatarUrl} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{account.user.name}</span>
        <CaretUpDownIcon size={13} className="shrink-0 text-faint" />
      </button>
      {open && <Menu account={account} />}
    </div>
  )
}

function Menu({ account }: { account: SignedIn }) {
  const entered = useEntered()
  const [orgs, setOrgs] = useState<ReadonlyArray<SessionOrgChoice> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  // In the desktop app: the other places it can switch to, like this computer.
  const desktop = useDesktopWorkspaces()
  const onCloud = desktop?.workspaces.find((w) => w.id === desktop.current)?.kind === "cloud"

  useEffect(() => {
    let cancelled = false
    listOrgs().then(
      (list) => !cancelled && setOrgs(list),
      (e: Error) => !cancelled && setError(e.message),
    )
    return () => {
      cancelled = true
    }
  }, [])

  const go = async (key: string, run: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await run()
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }

  const item = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover disabled:opacity-60"
  // While the list loads, the current org stands in for it.
  const shown = orgs ?? [{ id: account.org.id, name: account.org.name, role: account.role, current: true }]

  return (
    <div
      role="menu"
      aria-label="Account"
      className={`absolute bottom-full left-0 z-40 mb-1.5 w-[224px] origin-bottom-left rounded-lg border border-border bg-bg p-1 shadow-lg transition-[opacity,transform] duration-150 ease-out ${
        entered ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[0.98] opacity-0"
      }`}
    >
      <div className="px-2 pt-1.5 pb-2">
        <div className="truncate text-[13px] font-medium">{account.user.name}</div>
        <div className="truncate text-[12px] text-muted">{account.user.email}</div>
      </div>
      <div className="border-t border-border pt-1">
        <div className="px-2 pt-1 pb-1 text-[12px] font-medium text-faint">{onCloud ? "Cloud workspaces" : "Workspaces"}</div>
        <ul aria-busy={!orgs && !error} className="max-h-[240px] overflow-y-auto">
          {shown.map((org) => (
            <li key={org.id}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={org.current}
                disabled={busy !== null}
                onClick={() => (org.current ? undefined : void go(org.id, () => switchOrg(org.id)))}
                className={item}
              >
                <span className="grid size-5 shrink-0 place-items-center rounded bg-accent text-[11px] font-semibold text-accent-text">{org.name.charAt(0).toUpperCase()}</span>
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                {busy === org.id ? (
                  <SpinnerGapIcon size={14} className="animate-spin text-muted" />
                ) : org.current ? (
                  <CheckIcon size={14} weight="bold" className="text-accent" />
                ) : (
                  <span className="text-[12px] text-faint">{roleLabel[org.role]}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {naming ? (
          <NewWorkspace busy={busy === "new"} onCancel={() => setNaming(false)} onCreate={(name) => void go("new", () => createOrg(name))} />
        ) : (
          <button type="button" role="menuitem" onClick={() => setNaming(true)} disabled={busy !== null} className={`${item} text-muted`}>
            <PlusIcon size={14} className="mx-[3px]" /> {onCloud ? "New Cloud workspace" : "New workspace"}
          </button>
        )}
        {error && <p className="px-2 py-1 text-[12px] text-danger">{error}</p>}
      </div>
      {desktop && <OtherDesktopWorkspaces list={desktop} />}
      <div className="mt-1 border-t border-border pt-1">
        <button type="button" role="menuitem" onClick={() => void go("out", signOut)} disabled={busy !== null} className={item}>
          <SignOutIcon size={15} className="text-muted" /> Sign out
        </button>
      </div>
    </div>
  )
}

function NewWorkspace({ busy, onCreate, onCancel }: { busy: boolean; onCreate: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) onCreate(name.trim())
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-1 px-1 py-1">
      <input
        autoFocus
        aria-label="Workspace name"
        placeholder="Workspace name"
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-[13px] outline-none focus:border-accent"
      />
      <button type="submit" disabled={busy || !name.trim()} className="h-7 shrink-0 rounded-md bg-accent px-2.5 text-[13px] font-medium text-accent-text disabled:opacity-50">
        {busy ? "Creating…" : "Create"}
      </button>
    </form>
  )
}
