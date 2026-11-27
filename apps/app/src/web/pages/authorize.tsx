import { useEffect, useId, useState, type ReactNode } from "react"
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  DesktopIcon,
  GlobeSimpleIcon,
  PlugsConnectedIcon,
  SealCheckIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react"
import type { ConsentInfo, ConsentOrg, ConsentProblem, ConsentResult, GrantAccess } from "@standard-artifacts/protocol"
import { AgentTile, AppMark } from "../components/agent-tile"
import { Avatar } from "../components/account-menu"
import { roles } from "../components/settings-parts"
import { rememberAfterSignIn, signIn, signOut } from "../session"

/**
 * The consent page for remote MCP sign-in (`/authorize?request=…`). An app
 * like Claude or ChatGPT sent the person here through /api/oauth/authorize;
 * they pick a workspace and how much the agent may do, then approve or deny,
 * and the browser goes back to the app with the answer.
 *
 * It renders on its own, outside the app shell, and refuses to render inside
 * a frame: a page that grants access must never be clickable through someone
 * else's site.
 */

type State =
  | { readonly step: "loading" }
  | { readonly step: "ready"; readonly info: ConsentInfo }
  | { readonly step: "sending"; readonly info: ConsentInfo; readonly decision: "approve" | "deny" }
  | { readonly step: "done"; readonly result: ConsentResult; readonly info: ConsentInfo }
  | { readonly step: "problem"; readonly reason: ConsentProblem; readonly message: string | null }

const problems: Record<ConsentProblem, { readonly title: string; readonly body: string }> = {
  "signed-out": { title: "Sign in to continue", body: "Taking you to sign in…" },
  expired: { title: "This request expired", body: "Requests to connect last 15 minutes and work once. Go back to the app you were connecting and start again." },
  "unknown-client": {
    title: "We don't recognize this app",
    body: "The app that sent you here isn't registered with Standard Artifacts, or its details couldn't be loaded. Go back to it and add Standard Artifacts again.",
  },
  "redirect-mismatch": {
    title: "This app's return address doesn't match",
    body: "The app asked to send you somewhere it didn't register, so we stopped here. Remove Standard Artifacts from the app and add it again. If you didn't start this, close this tab.",
  },
  "bad-request": { title: "This link is incomplete", body: "Go back to the app you were connecting and start again." },
  "no-membership": { title: "No workspace to connect", body: "You aren't a member of that workspace. Pick another, or ask an owner to invite you." },
  forbidden: { title: "Can't connect this", body: "This sign-in isn't allowed. Reload the page and try again." },
  unavailable: { title: "Something's not answering", body: "We couldn't reach the account service. Try again in a moment." },
  "not-enabled": { title: "Sign-in isn't available here", body: "This server doesn't sign agents in. Connect your agent with an access token from Settings instead." },
}

const knownProblem = (s: string | null): ConsentProblem | null => (s && s in problems ? (s as ConsentProblem) : null)

export function AuthorizePage() {
  const framed = (() => {
    try {
      return window.top !== window.self
    } catch {
      return true
    }
  })()
  const params = new URLSearchParams(window.location.search)
  const request = params.get("request")
  const [state, setState] = useState<State>(() => {
    const problem = knownProblem(params.get("error"))
    if (problem) return { step: "problem", reason: problem, message: null }
    if (!request) return { step: "problem", reason: "bad-request", message: null }
    return { step: "loading" }
  })

  useEffect(() => {
    document.title = "Connect an agent · Standard Artifacts"
    if (framed || state.step !== "loading" || !request) return
    let cancelled = false
    fetch(`/api/oauth/consent?request=${encodeURIComponent(request)}`, { credentials: "same-origin" })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null)
        if (cancelled) return
        if (res.ok) return setState({ step: "ready", info: body as ConsentInfo })
        const failure = body as { reason?: string; message?: string } | null
        const reason = knownProblem(failure?.reason ?? null) ?? "unavailable"
        // The session ended (or never was): sign in, then come straight back here.
        if (reason === "signed-out") return signIn({ returnTo: `${window.location.pathname}${window.location.search}` })
        setState({ step: "problem", reason, message: failure?.message ?? null })
      })
      .catch(() => !cancelled && setState({ step: "problem", reason: "unavailable", message: null }))
    return () => {
      cancelled = true
    }
  }, [framed, request, state.step])

  if (framed) {
    return (
      <Frame>
        <Problem title="Open this in its own window" body="For your safety, approving an app only works in a full browser tab, not inside another page.">
          <a href={window.location.href} target="_blank" rel="noopener" className={secondary}>
            Open in a new tab <ArrowSquareOutIcon size={14} />
          </a>
        </Problem>
      </Frame>
    )
  }

  switch (state.step) {
    case "loading":
      return (
        <Frame>
          <div aria-busy="true" className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="size-11 animate-pulse rounded-xl bg-active" />
              <span className="size-11 animate-pulse rounded-xl bg-active" />
            </div>
            <span className="block h-5 w-64 animate-pulse rounded bg-active" />
            <span className="block h-4 w-52 animate-pulse rounded bg-active" />
            <span className="block h-24 w-full animate-pulse rounded-lg bg-active" />
          </div>
        </Frame>
      )
    case "problem": {
      const p = problems[state.reason]
      return (
        <Frame>
          <Problem title={p.title} body={state.message && state.reason !== "forbidden" ? state.message : p.body} />
        </Frame>
      )
    }
    case "done":
      return (
        <Frame>
          <Done result={state.result} info={state.info} />
        </Frame>
      )
    case "ready":
    case "sending":
      return (
        <Frame>
          <Consent
            info={state.info}
            sending={state.step === "sending" ? state.decision : null}
            onAnswer={async (decision, orgId, access) => {
              setState({ step: "sending", info: state.info, decision })
              try {
                const res = await fetch("/api/oauth/consent", {
                  method: "POST",
                  credentials: "same-origin",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ request: state.info.request, csrf: state.info.csrf, decision, orgId, access }),
                })
                const body: unknown = await res.json().catch(() => null)
                if (!res.ok) {
                  const failure = body as { reason?: string; message?: string } | null
                  const reason = knownProblem(failure?.reason ?? null) ?? "unavailable"
                  if (reason === "signed-out") return signIn({ returnTo: `${window.location.pathname}${window.location.search}` })
                  return setState({ step: "problem", reason, message: failure?.message ?? null })
                }
                const result = body as ConsentResult
                setState({ step: "done", result, info: state.info })
                // Back to the app. A web or loopback page replaces this one; an app's own link opens the app and leaves this page up.
                setTimeout(() => window.location.assign(result.redirect), state.info.client.redirectKind === "app" ? 0 : 700)
              } catch {
                setState({ step: "problem", reason: "unavailable", message: null })
              }
            }}
          />
        </Frame>
      )
  }
}

// --- The form -----------------------------------------------------------------------------------

function Consent({
  info,
  sending,
  onAnswer,
}: {
  info: ConsentInfo
  sending: "approve" | "deny" | null
  onAnswer: (decision: "approve" | "deny", orgId?: string, access?: GrantAccess) => void
}) {
  const { client, user, orgs } = info
  const [orgId, setOrgId] = useState(() => (orgs.find((o) => o.current) ?? orgs[0])?.id ?? "")
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0]
  const [access, setAccess] = useState<GrantAccess>(org?.maxAccess ?? "read")
  // A workspace where they can only give read access takes the choice down with it.
  const effective: GrantAccess = org?.maxAccess === "read" ? "read" : access
  const busy = sending !== null
  const name = client.agentName
  const orgLabel = useId()
  const accessLabel = useId()

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onAnswer("approve", org?.id, effective)
      }}
    >
      <div className="flex items-center gap-2.5" aria-hidden="true">
        <AgentTile name={name} logoUri={client.logoUri} size={44} />
        <span className="flex items-center gap-1 text-faint">
          <span className="size-1 rounded-full bg-current" />
          <span className="size-1 rounded-full bg-current" />
          <span className="size-1 rounded-full bg-current" />
        </span>
        <span className="grid size-11 place-items-center rounded-xl border border-border bg-bg">
          <AppMark size={26} />
        </span>
      </div>

      <h1 className="mt-5 text-[20px] leading-snug font-semibold tracking-tight">Connect {name} to Standard Artifacts</h1>
      <p className="mt-1.5 text-muted">
        {name} will act for you in the workspace you pick: {effective === "write" ? "reading and editing" : "reading"} boards, tables, docs and issues. People will see its work as{" "}
        <span className="text-text">
          {name} via {user.name.split(" ")[0]}
        </span>
        .
      </p>

      <ClientFacts info={info} />

      {client.warning && (
        <div role="alert" className="mt-4 flex gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--danger)_35%,var(--border))] bg-[color-mix(in_srgb,var(--danger)_6%,var(--bg))] p-3 text-[13px]">
          <WarningIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-danger" />
          <p className="text-text">{client.warning}</p>
        </div>
      )}

      <fieldset className="mt-6" aria-labelledby={orgLabel}>
        <legend id={orgLabel} className="mb-2 text-[13px] font-medium">
          Workspace
        </legend>
        <div className="space-y-1.5">
          {orgs.map((o) => (
            <OrgOption key={o.id} org={o} checked={o.id === org?.id} onChange={() => setOrgId(o.id)} disabled={busy} />
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5" aria-labelledby={accessLabel}>
        <legend id={accessLabel} className="mb-2 text-[13px] font-medium">
          Access
        </legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <AccessOption
            value="write"
            checked={effective === "write"}
            disabled={busy || org?.maxAccess !== "write"}
            onChange={() => setAccess("write")}
            title="Read and write"
            detail={org?.role === "owner" ? "Edits like an Editor; never manages the workspace" : `As your role: ${roles[org?.role ?? "editor"].label}`}
          />
          <AccessOption value="read" checked={effective === "read"} disabled={busy} onChange={() => setAccess("read")} title="Read only" detail="Can look, can't change anything" />
        </div>
        {org?.limit && <p className="mt-2 text-[13px] text-muted">{org.limit}</p>}
      </fieldset>

      <div className="mt-6 flex items-center gap-3 rounded-lg bg-surface px-3 py-2.5 text-[13px]">
        <Avatar name={user.name} id={user.id} url={user.avatarUrl} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate">
            Signed in as <span className="font-medium">{user.name}</span>
          </div>
          <div className="truncate text-muted">{user.email}</div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            rememberAfterSignIn(`${window.location.pathname}${window.location.search}`)
            void signOut()
          }}
          className="shrink-0 font-medium text-accent hover:underline disabled:opacity-50"
        >
          Not you?
        </button>
      </div>

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" disabled={busy} onClick={() => onAnswer("deny")} className={`${secondary} sm:w-auto`}>
          {sending === "deny" ? "Denying…" : "Deny"}
        </button>
        <button type="submit" disabled={busy || !org} className={`${primary} sm:w-auto`}>
          {sending === "approve" ? "Connecting…" : `Approve`}
        </button>
      </div>
      <p className="mt-4 text-center text-[12px] text-faint sm:text-right">You can disconnect it anytime in Settings → Connections.</p>
    </form>
  )
}

/** Who's asking and where the answer goes. */
function ClientFacts({ info }: { info: ConsentInfo }) {
  const { client } = info
  const site = client.uri ? hostOf(client.uri) : null
  const where =
    client.redirectKind === "loopback" ? (
      <>
        <DesktopIcon size={14} className="shrink-0" /> Returns to an app on this computer
      </>
    ) : client.redirectKind === "app" ? (
      <>
        <PlugsConnectedIcon size={14} className="shrink-0" /> Returns to the app that opens <span className="font-mono text-[12px]">{client.redirectHost}</span> links
      </>
    ) : (
      <>
        <GlobeSimpleIcon size={14} className="shrink-0" /> Returns to <span className="font-medium text-text">{client.redirectHost}</span>
        {client.verified && <SealCheckIcon size={14} weight="fill" className="shrink-0 text-accent" aria-label="Verified" />}
      </>
    )
  return (
    <dl className="mt-4 divide-y divide-border rounded-lg border border-border text-[13px]">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <dt className="text-muted">App</dt>
        <dd className="min-w-0 truncate text-right">
          {client.name ?? client.agentName}
          {site && (
            <>
              {" · "}
              <a href={client.uri!} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                {site}
              </a>
            </>
          )}
        </dd>
      </div>
      <div className="flex items-center gap-1.5 px-3 py-2 text-muted">{where}</div>
    </dl>
  )
}

function OrgOption({ org, checked, onChange, disabled }: { org: ConsentOrg; checked: boolean; onChange: () => void; disabled: boolean }) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 has-focus-visible:outline-2 has-focus-visible:outline-accent ${
        checked ? "border-accent bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg))]" : "border-border hover:bg-hover"
      } ${disabled ? "cursor-default opacity-70" : ""}`}
    >
      <input type="radio" name="org" value={org.id} checked={checked} onChange={onChange} disabled={disabled} className="sr-only" />
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-active text-[12px] font-semibold text-muted">{org.name.charAt(0).toUpperCase()}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{org.name}</span>
        <span className="block truncate text-[12px] text-muted">
          {roles[org.role].label}
          {org.current ? " · current workspace" : ""}
        </span>
      </span>
      <Radio checked={checked} />
    </label>
  )
}

function AccessOption(props: { value: GrantAccess; checked: boolean; disabled: boolean; onChange: () => void; title: string; detail: string }) {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 has-focus-visible:outline-2 has-focus-visible:outline-accent ${
        props.checked ? "border-accent bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg))]" : "border-border"
      } ${props.disabled && !props.checked ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-hover"}`}
    >
      <input type="radio" name="access" value={props.value} checked={props.checked} onChange={props.onChange} disabled={props.disabled} className="sr-only" />
      <span className="mt-0.5">
        <Radio checked={props.checked} />
      </span>
      <span className="min-w-0">
        <span className="block font-medium">{props.title}</span>
        <span className="block text-[12px] text-muted">{props.detail}</span>
      </span>
    </label>
  )
}

function Radio({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" className={`grid size-4 shrink-0 place-items-center rounded-full border ${checked ? "border-accent" : "border-faint"}`}>
      {checked && <span className="size-2 rounded-full bg-accent" />}
    </span>
  )
}

// --- After the answer ----------------------------------------------------------------------------

function Done({ result, info }: { result: ConsentResult; info: ConsentInfo }) {
  const name = result.clientName
  const appLink = info.client.redirectKind === "app"
  return (
    <div role="status" className="text-center">
      <div className="flex justify-center">
        {result.approved ? <CheckCircleIcon size={44} weight="fill" className="text-table" /> : <XCircleIcon size={44} weight="fill" className="text-faint" />}
      </div>
      <h1 className="mt-4 text-[20px] font-semibold tracking-tight">{result.approved ? "Connected" : "Not connected"}</h1>
      <p className="mt-1.5 text-muted">{result.approved ? `You can return to ${name}.` : `You declined, so ${name} has no access. You can return to it.`}</p>
      <p className="mt-1 text-[13px] text-faint">{appLink ? `If ${name} didn't open, use the button below.` : "Taking you back…"}</p>
      <div className="mt-6 flex justify-center">
        <a href={result.redirect} className={secondary}>
          Return to {name}
        </a>
      </div>
      {result.approved && <p className="mt-6 text-[12px] text-faint">Disconnect it anytime in Settings → Connections. You can close this tab.</p>}
    </div>
  )
}

// --- Frame -----------------------------------------------------------------------------------------

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-full place-items-center bg-bg px-4 py-10 sm:bg-surface">
      <div className="w-full max-w-[440px] sm:rounded-2xl sm:border sm:border-border sm:bg-bg sm:p-8 sm:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.04)]">{children}</div>
    </main>
  )
}

function Problem({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div role="alert">
      <AppMark size={32} />
      <h1 className="mt-5 text-[20px] font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-muted">{body}</p>
      {children && <div className="mt-6 flex">{children}</div>}
    </div>
  )
}

const hostOf = (uri: string) => {
  try {
    return new URL(uri).hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

const primary =
  "flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-accent px-4 font-medium text-accent-text hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
const secondary =
  "flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-border px-4 font-medium text-text hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 sm:w-auto"
