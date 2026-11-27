import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react"
import { Effect } from "effect"
import { Link } from "@tanstack/react-router"
import { EnvelopeSimpleIcon, KeyIcon } from "@phosphor-icons/react"
import type { ApiToken, CreatedApiToken, OrgInvitation, OrgMember, OrgMembers, Principal, Role } from "@standard-artifacts/protocol"
import { api, errorMessage } from "../api"
import { Avatar } from "../components/account-menu"
import { Heading, ListSkeleton, Rows, Snippet, roles } from "../components/settings-parts"
import { timeAgo } from "../time"
import { useWorkspace } from "../workspace"

/**
 * Settings for a signed-in workspace: its members (from the account service,
 * WorkOS in Cloud) and your access tokens for the CLI and MCP.
 */

export type Client = Effect.Success<ReturnType<typeof api>>

/** A failed API call: a readable message, and the error's tag (`UpgradeRequired`…) when it had one. */
export class ApiFailure extends Error {
  readonly tag: string | undefined
  constructor(e: unknown) {
    super(errorMessage(e))
    this.tag = typeof e === "object" && e !== null && "_tag" in e && typeof e._tag === "string" ? e._tag : undefined
  }
}

/** Run a typed API call; failures reject with an ApiFailure. */
export function useApi() {
  const { devAs } = useWorkspace()
  return useCallback(
    <A,>(f: (client: Client) => Effect.Effect<A, unknown>) => Effect.runPromise(api(devAs).pipe(Effect.flatMap(f), Effect.mapError((e) => new ApiFailure(e)))),
    [devAs],
  )
}

/** The plan doesn't cover an Editor or Owner: say why, and where to upgrade. */
function UpgradePrompt({ message }: { message: string }) {
  return (
    <div role="alert" className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px]">
      <p className="text-text">{message}</p>
      <Link to="/settings/{-$section}" params={{ section: "billing" }} className="mt-1.5 inline-flex font-medium text-accent hover:underline">
        See plans and upgrade
      </Link>
    </div>
  )
}

const isUpgrade = (e: unknown) => e instanceof ApiFailure && e.tag === "UpgradeRequired"

const button = "flex h-7 shrink-0 items-center rounded-md border border-border px-2.5 text-[13px] font-medium text-text hover:bg-hover disabled:opacity-50"
const danger = "flex h-7 shrink-0 items-center rounded-md px-2.5 text-[13px] font-medium text-danger hover:bg-hover disabled:opacity-50"
const input = "h-8 min-w-0 rounded-md border border-border bg-bg px-2.5 text-[13px] text-text outline-none placeholder:text-faint focus:border-accent"

function RoleSelect({ value, onChange, disabled, label }: { value: Role; onChange: (r: Role) => void; disabled?: boolean; label: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Role)}
      className="h-7 rounded-md border border-border bg-bg px-1.5 text-[13px] text-text disabled:opacity-60"
    >
      {(["owner", "editor", "viewer"] as const).map((r) => (
        <option key={r} value={r}>
          {roles[r].label}
        </option>
      ))}
    </select>
  )
}

/** A row in a settings list: picture, two lines, then whatever goes on the right. */
function Item({ avatar, title, detail, children }: { avatar: ReactNode; title: ReactNode; detail: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex min-h-13 flex-wrap items-center gap-x-3 gap-y-2 py-2">
      {avatar}
      <div className="min-w-0 flex-[1_1_160px]">
        <div className="truncate font-medium">{title}</div>
        <div className="truncate text-[13px] text-muted">{detail}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted">{children}</div>
    </li>
  )
}

// --- Members ------------------------------------------------------------------------------

export function LiveMembers({ principal }: { principal: Principal }) {
  const run = useApi()
  const [data, setData] = useState<OrgMembers | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    () =>
      run((c) => c.org.members()).then(
        (d) => {
          setData(d)
          setError(null)
        },
        (e: Error) => setError(e.message),
      ),
    [run],
  )
  useEffect(() => {
    void load()
  }, [load])

  const self = principal.actor.id
  const owners = data?.members.filter((m) => m.role === "owner").length ?? 0

  return (
    <>
      <Heading title="Members">
        People in {principal.orgName}. {data?.canManage ? "As an owner, you invite people and choose their roles." : "Owners invite people and choose their roles."} Agents act for
        one of them and don't take a seat.
      </Heading>
      {data?.canManage && <Invite onInvited={load} />}
      {error && (
        <p role="alert" className="mt-4 text-[13px] text-danger">
          {error}
        </p>
      )}
      <Rows title={data ? `${data.members.length} ${data.members.length === 1 ? "member" : "members"}` : "Members"}>
        {!data && !error && <ListSkeleton />}
        {data && (
          <ul className="divide-y divide-border">
            {data.members.map((m) => (
              <MemberRow key={m.id} member={m} you={m.userId === self} canManage={data.canManage} lastOwner={m.role === "owner" && owners <= 1} onChanged={load} />
            ))}
          </ul>
        )}
      </Rows>
      {data && data.invitations.length > 0 && (
        <Rows title="Invited">
          <ul className="divide-y divide-border">
            {data.invitations.map((i) => (
              <InvitationRow key={i.id} invitation={i} canManage={data.canManage} onChanged={load} />
            ))}
          </ul>
        </Rows>
      )}
    </>
  )
}

function Invite({ onInvited }: { onInvited: () => Promise<void> }) {
  const run = useApi()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string; upgrade?: boolean } | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setNote(null)
    try {
      const sent = await run((c) => c.org.invite({ payload: { email: email.trim(), role } }))
      setEmail("")
      setNote({ ok: true, text: `Invitation sent to ${sent.email}.` })
      await onInvited()
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message, upgrade: isUpgrade(err) })
    }
    setBusy(false)
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-5 flex flex-wrap items-center gap-2" aria-label="Invite someone">
      <input
        type="email"
        required
        aria-label="Email"
        placeholder="name@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={`${input} flex-[1_1_200px]`}
      />
      <RoleSelect label="Role for the invitation" value={role} onChange={setRole} />
      <button type="submit" disabled={busy || !email.trim()} className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-text disabled:opacity-50">
        <EnvelopeSimpleIcon size={14} /> {busy ? "Sending…" : "Invite"}
      </button>
      {note?.upgrade ? (
        <UpgradePrompt message={note.text} />
      ) : (
        note && (
          <p role={note.ok ? "status" : "alert"} className={`w-full text-[13px] ${note.ok ? "text-muted" : "text-danger"}`}>
            {note.text}
          </p>
        )
      )}
    </form>
  )
}

function MemberRow({ member, you, canManage, lastOwner, onChanged }: { member: OrgMember; you: boolean; canManage: boolean; lastOwner: boolean; onChanged: () => Promise<void> }) {
  const run = useApi()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<{ text: string; upgrade: boolean } | null>(null)

  const act = async (f: (c: Client) => Effect.Effect<unknown, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await run(f)
      // Leaving the workspace yourself: start over wherever the session lands.
      if (you && confirming) return window.location.assign("/")
      await onChanged()
    } catch (e) {
      setError({ text: (e as Error).message, upgrade: isUpgrade(e) })
    }
    setBusy(false)
    setConfirming(false)
  }

  return (
    <>
      <Item
        avatar={<Avatar name={member.name} id={member.userId} url={member.avatarUrl} size={32} />}
        title={
          <>
            {member.name}
            {you && <span className="font-normal text-muted"> (you)</span>}
          </>
        }
        detail={member.email}
      >
        {confirming ? (
          <>
            <span className="text-text">{you ? "Leave this workspace?" : `Remove ${member.name}?`}</span>
            <button type="button" disabled={busy} onClick={() => void act((c) => c.org.removeMember({ params: { id: member.id } }))} className={danger}>
              {you ? "Leave" : "Remove"}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={button}>
              Cancel
            </button>
          </>
        ) : canManage ? (
          <>
            <RoleSelect
              label={`Role for ${member.name}`}
              value={member.role}
              disabled={busy || lastOwner}
              onChange={(role) => void act((c) => c.org.updateMember({ params: { id: member.id }, payload: { role } }))}
            />
            <button
              type="button"
              disabled={busy || lastOwner}
              title={lastOwner ? "The only owner can't be removed. Make someone else an owner first." : undefined}
              onClick={() => setConfirming(true)}
              className={danger}
            >
              {you ? "Leave" : "Remove"}
            </button>
          </>
        ) : (
          <span title="Owners choose roles">{roles[member.role].label}</span>
        )}
      </Item>
      {error &&
        (error.upgrade ? (
          <div className="pb-2">
            <UpgradePrompt message={error.text} />
          </div>
        ) : (
          <p role="alert" className="pb-2 text-[13px] text-danger">
            {error.text}
          </p>
        ))}
    </>
  )
}

function InvitationRow({ invitation, canManage, onChanged }: { invitation: OrgInvitation; canManage: boolean; onChanged: () => Promise<void> }) {
  const run = useApi()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const act = async (f: (c: Client) => Effect.Effect<unknown, unknown>, done: string | null) => {
    setBusy(true)
    setNote(null)
    try {
      await run(f)
      if (done) setNote(done)
      else await onChanged()
    } catch (e) {
      setNote((e as Error).message)
    }
    setBusy(false)
  }

  return (
    <>
      <Item
        avatar={
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-active text-muted">
            <EnvelopeSimpleIcon size={15} />
          </span>
        }
        title={invitation.email}
        detail={`${roles[invitation.role].label} · expires ${timeAgo(invitation.expiresAt)}`}
      >
        {canManage && (
          <>
            <button type="button" disabled={busy} onClick={() => void act((c) => c.org.resendInvitation({ params: { id: invitation.id } }), "Sent again.")} className={button}>
              Resend
            </button>
            <button type="button" disabled={busy} onClick={() => void act((c) => c.org.revokeInvitation({ params: { id: invitation.id } }), null)} className={danger}>
              Revoke
            </button>
          </>
        )}
      </Item>
      {note && <p className="pb-2 text-[13px] text-muted">{note}</p>}
    </>
  )
}

// --- Access tokens ----------------------------------------------------------------------------

export function AccessTokens({ principal }: { principal: Principal }) {
  const run = useApi()
  const [tokens, setTokens] = useState<ReadonlyArray<ApiToken> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedApiToken | null>(null)

  const load = useCallback(() => run((c) => c.tokens.list()).then(setTokens, (e: Error) => setError(e.message)), [run])
  useEffect(() => {
    void load()
  }, [load])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const token = await run((c) => c.tokens.create({ payload: { name: name.trim() } }))
      setCreated(token)
      setName("")
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }

  const revoke = async (id: string) => {
    setError(null)
    try {
      await run((c) => c.tokens.revoke({ params: { id } }))
      if (created?.id === id) setCreated(null)
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const origin = window.location.origin
  return (
    <>
      <Heading title="Access tokens">
        For the CLI, MCP and scripts. A token acts as you in {principal.orgName}, with your role, until you revoke it or leave the workspace.
      </Heading>
      <form onSubmit={(e) => void create(e)} className="mt-5 flex flex-wrap items-center gap-2" aria-label="Create a token">
        <input aria-label="Token name" placeholder="What it's for, like Claude Code" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={`${input} flex-[1_1_220px]`} />
        <button type="submit" disabled={busy || !name.trim()} className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-text disabled:opacity-50">
          <KeyIcon size={14} /> {busy ? "Creating…" : "Create token"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      )}
      {created && (
        <div className="mt-4 rounded-lg border border-border px-3 pb-1">
          <Snippet label={created.name} help="Copy it now. You won't see it again." code={created.token} />
          <Snippet label="Use it" code={`export STDARTIFACTS_URL=${origin}\nexport STDARTIFACTS_TOKEN=${created.token}`} />
        </div>
      )}
      <Rows title="Your tokens">
        {!tokens && !error && <ListSkeleton />}
        {tokens?.length === 0 && <p className="py-3 text-[13px] text-muted">No tokens yet.</p>}
        {tokens && tokens.length > 0 && (
          <ul className="divide-y divide-border">
            {tokens.map((t) => (
              <TokenRow key={t.id} token={t} onRevoke={() => revoke(t.id)} />
            ))}
          </ul>
        )}
      </Rows>
    </>
  )
}

function TokenRow({ token, onRevoke }: { token: ApiToken; onRevoke: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <Item
      avatar={
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-active text-muted">
          <KeyIcon size={15} />
        </span>
      }
      title={token.name}
      detail={`Created ${timeAgo(token.createdAt)} · ${token.lastUsedAt ? `last used ${timeAgo(token.lastUsedAt)}` : "never used"}`}
    >
      {confirming ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void onRevoke().finally(() => setBusy(false))
            }}
            className={danger}
          >
            Revoke
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={button}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={danger}>
          Revoke
        </button>
      )}
    </Item>
  )
}
