import { useCallback, useEffect, useState, type ReactNode } from "react"
import { Effect } from "effect"
import { CheckIcon, GlobeHemisphereWestIcon, LinkSimpleIcon, LockSimpleIcon, RobotIcon, SparkleIcon, UsersThreeIcon, XIcon } from "@phosphor-icons/react"
import { colorFor, kinds, type Artifact, type ArtifactAccess, type Principal, type Role } from "@standard-artifacts/protocol"
import { api, errorMessage } from "../api"
import { useEntered } from "./header-popover"

const roleLabel: Record<Role, string> = { owner: "Owner", editor: "Can edit", viewer: "Can view" }

type Props = { artifact: Artifact; principal: Principal; devAs: string; onClose: () => void }

/**
 * Share an artifact: who can open it (org people, agents acting for them) and
 * its read-only link. Access is org-wide and roles come from the org account,
 * so rows show roles rather than editing them; email invites aren't wired yet,
 * and the dialog says so instead of pretending to send.
 */
export function ShareDialog({ artifact, principal, devAs, onClose }: Props) {
  const entered = useEntered()
  const [access, setAccess] = useState<ArtifactAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [email, setEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<"viewer" | "editor">("viewer")
  const kind = kinds[artifact.kind].singular

  const run = useCallback(
    <A,>(f: (c: Effect.Success<ReturnType<typeof api>>) => Effect.Effect<A, unknown>) =>
      Effect.runPromise(api(devAs).pipe(Effect.flatMap(f), Effect.mapError(errorMessage), Effect.mapError((m) => new Error(m)))),
    [devAs],
  )

  useEffect(() => {
    let cancelled = false
    run((c) => c.sharing.access({ params: { id: artifact.id } }))
      .then((a) => !cancelled && setAccess(a))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [run, artifact.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const setLink = async (on: boolean) => {
    if (!access) return
    setBusy(true)
    setError(null)
    try {
      if (on) {
        const link = await run((c) => c.sharing.createLink({ params: { id: artifact.id } }))
        setAccess({ ...access, link })
      } else {
        await run((c) => c.sharing.deleteLink({ params: { id: artifact.id } }))
        setAccess({ ...access, link: null })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const shareUrl = access?.link ? new URL(access.link.path, window.location.origin).toString() : window.location.href
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError("Couldn't copy. Select the link and copy it instead.")
    }
  }

  const canManage = access?.canManage ?? false
  const free = principal.plan === "free"
  const self = principal.actor
  const nameOf = (id: string) => access?.people.find((p) => p.id === id)?.name

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="presentation">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 cursor-default bg-black/25 transition-opacity duration-150 dark:bg-black/50 ${entered ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className={`relative w-full max-w-[480px] overflow-hidden rounded-xl border border-border bg-bg shadow-2xl transition-[opacity,transform] duration-200 ease-out ${
          entered ? "translate-y-0 scale-100 opacity-100" : "translate-y-1.5 scale-[0.98] opacity-0"
        }`}
      >
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-1">
          <h2 id="share-title" className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            Share {kind.toLowerCase()}
            <span className="font-normal text-muted"> · {artifact.title}</span>
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1.5 grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text">
            <XIcon size={16} />
          </button>
        </div>

        {canManage && (
          <div className="px-4 pt-2">
            <form
              onSubmit={(e) => e.preventDefault()}
              className="flex items-center rounded-lg border border-border bg-bg pr-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20"
            >
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Add people by email"
                aria-label="Email"
                autoFocus
                className="h-9 min-w-0 flex-1 bg-transparent px-3 text-[13px] outline-none placeholder:text-faint"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "viewer" | "editor")}
                aria-label="Role for new people"
                className="field-sizing-content h-7 shrink-0 rounded-md bg-transparent px-1.5 text-[13px] text-muted outline-none hover:bg-hover hover:text-text"
              >
                <option value="viewer">Can view</option>
                <option value="editor">Can edit</option>
              </select>
              <button
                type="submit"
                disabled
                title="Email invites aren't available yet"
                className="ml-1 h-7 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                Invite
              </button>
            </form>
            {free && inviteRole === "editor" ? (
              <p className="mt-2 flex items-start gap-1.5 rounded-md bg-accent/8 px-2.5 py-2 text-[12px] leading-snug text-text">
                <SparkleIcon size={14} weight="fill" className="mt-px shrink-0 text-accent" />
                <span>
                  <span className="font-medium">Multiplayer is on Team.</span>{" "}
                  <span className="text-muted">On Free, only you and your agents edit. Others can view through the link below.</span>
                </span>
              </p>
            ) : (
              <p className="mt-1.5 text-[12px] text-faint">Email invites aren't available yet. Share a view-only link below instead.</p>
            )}
          </div>
        )}

        <section className="px-4 pt-4">
          <h3 className="text-[12px] font-medium text-muted">Who has access</h3>
          {!access && !error && <Skeleton />}
          {access && (
            <ul className="mt-1.5 -mx-2">
              {access.people.map((p) => (
                <Row
                  key={p.id}
                  avatar={<Initial name={p.name} color={colorFor(p.id)} />}
                  name={
                    <>
                      {p.name}
                      {self.type === "user" && self.id === p.id && <span className="font-normal text-muted"> (you)</span>}
                    </>
                  }
                  detail={p.id === access.createdBy ? `Created this ${kind.toLowerCase()}` : `${access.orgName} member`}
                  role={roleLabel[p.role]}
                />
              ))}
              {!free && (
                <Row
                  avatar={
                    <span className="grid size-8 place-items-center rounded-full bg-active text-muted">
                      <UsersThreeIcon size={16} />
                    </span>
                  }
                  name={`Everyone at ${access.orgName}`}
                  detail="Members open it with their org role"
                  role="By org role"
                />
              )}
              {access.agents.map((a) => (
                <Row
                  key={a.key}
                  avatar={
                    <span className="grid size-8 place-items-center rounded-[9px] text-white" style={{ background: colorFor(a.key) }}>
                      <RobotIcon size={17} weight="bold" />
                    </span>
                  }
                  name={
                    <>
                      {a.name}
                      <span className="ml-1.5 rounded bg-active px-1 py-px align-[1px] text-[10px] font-medium tracking-wide text-muted uppercase">Agent</span>
                    </>
                  }
                  detail={`Acts for ${self.type === "user" && self.id === a.onBehalfOf ? "you" : (a.onBehalfOfName ?? nameOf(a.onBehalfOf) ?? "a teammate")} · no seat`}
                  role={roleLabel[a.role === "owner" ? "editor" : a.role]}
                />
              ))}
              {access.agents.length === 0 && (
                <li className="flex items-center gap-3 px-2 py-2 text-[12px] text-faint">
                  <span className="grid size-8 place-items-center rounded-[9px] border border-dashed border-border">
                    <RobotIcon size={15} />
                  </span>
                  Agents you run (@claude, the stdartifacts CLI, MCP) show up here once they act. They use your access and don't take a seat.
                </li>
              )}
            </ul>
          )}
        </section>

        <section className="mt-3 border-t border-border px-4 pt-3 pb-4">
          <h3 className="text-[12px] font-medium text-muted">General access</h3>
          {access ? (
            <div className="mt-1.5 -mx-2 flex items-center gap-3 rounded-md px-2 py-1.5">
              <span className={`grid size-8 shrink-0 place-items-center rounded-full ${access.link ? "bg-accent/12 text-accent" : "bg-active text-muted"}`}>
                {access.link ? <GlobeHemisphereWestIcon size={17} /> : <LockSimpleIcon size={16} />}
              </span>
              <div className="min-w-0 flex-1">
                {canManage ? (
                  <select
                    value={access.link ? "link" : "org"}
                    disabled={busy}
                    onChange={(e) => void setLink(e.target.value === "link")}
                    aria-label="General access"
                    className="field-sizing-content -ml-1 h-7 max-w-full rounded-md bg-transparent px-1 text-[13px] font-medium outline-none hover:bg-hover disabled:opacity-60"
                  >
                    <option value="org">Only people at {access.orgName}</option>
                    <option value="link">Anyone with the link</option>
                  </select>
                ) : (
                  <div className="text-[13px] font-medium">{access.link ? "Anyone with the link" : `Only people at ${access.orgName}`}</div>
                )}
                <div className="text-[12px] leading-snug text-muted">
                  {access.link ? "No sign-in needed. They see live changes but can't edit." : "Only members of your org can open it."}
                </div>
              </div>
              {access.link && <span className="shrink-0 text-[13px] text-muted">Can view</span>}
            </div>
          ) : (
            !error && <Skeleton rows={1} />
          )}
          {!canManage && access && <p className="mt-2 text-[12px] text-faint">Only editors can change sharing.</p>}
          {error && (
            <p role="alert" className="mt-2 text-[12px] text-danger">
              {error}
            </p>
          )}
        </section>

        <div className="flex items-center gap-2 border-t border-border bg-surface px-4 py-2.5">
          <button
            type="button"
            onClick={copy}
            disabled={!access}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg px-2.5 text-[13px] font-medium hover:bg-hover disabled:opacity-50"
          >
            {copied ? <CheckIcon size={15} className="text-accent" /> : <LinkSimpleIcon size={15} />}
            {copied ? "Copied" : "Copy link"}
          </button>
          <span className="min-w-0 flex-1 truncate text-[12px] text-faint">
            {access && (access.link ? "View-only link" : `Works for people at ${access.orgName}`)}
          </span>
          <button type="button" onClick={onClose} className="h-8 rounded-md px-3 text-[13px] font-medium hover:bg-hover">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ avatar, name, detail, role }: { avatar: ReactNode; name: ReactNode; detail: string; role: string }) {
  return (
    <li className="flex items-center gap-3 rounded-md px-2 py-1.5">
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{name}</div>
        <div className="truncate text-[12px] text-muted">{detail}</div>
      </div>
      <span className="shrink-0 text-[13px] text-muted" title="Roles come from your org account">
        {role}
      </span>
    </li>
  )
}

export function Initial({ name, color }: { name: string; color: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white" style={{ background: color }}>
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

function Skeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="mt-2 space-y-3" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="size-8 animate-pulse rounded-full bg-active" />
          <span className="h-3 w-40 animate-pulse rounded bg-active" />
        </div>
      ))}
    </div>
  )
}
