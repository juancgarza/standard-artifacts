import { useCallback, useEffect, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { ArrowSquareOutIcon, CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react"
import type { ConnectedAgent, Connections as ConnectionsData, Principal } from "@standard-artifacts/protocol"
import { AgentTile } from "../components/agent-tile"
import { Heading, ListSkeleton, Rows, Snippet } from "../components/settings-parts"
import { timeAgo } from "../time"
import { useWorkspace } from "../workspace"
import { Item, button, danger, useApi } from "./settings-account"

/**
 * Settings → Connections: connect an agent by URL, with ready-to-paste steps
 * for each app, then the agents that are connected, with Disconnect.
 *
 * With sign-in (Cloud), apps sign in through the browser (OAuth) and show up
 * in the list once approved. A dev server has no sign-in: agents on this
 * machine connect without one, so there's nothing to list.
 */

const NAME = "standard-artifacts"

type Tab = "claude" | "claude-code" | "chatgpt" | "codex" | "cursor" | "vscode" | "other"

const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "claude-code", label: "Claude Code" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "other", label: "Other" },
]

export function Connections({ principal }: { principal: Principal }) {
  const run = useApi()
  const { authMode } = useWorkspace()
  const [data, setData] = useState<ConnectionsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    () =>
      run((c) => c.connections.list()).then(
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

  const url = data?.mcpUrl ?? `${window.location.origin}/mcp`
  // Until the server answers, assume what the mode says: live servers sign agents in.
  const oauth = data ? data.oauth : authMode ? authMode === "live" : !import.meta.env.DEV

  return (
    <>
      <Heading title="Connections">
        {oauth
          ? `Connect Claude, ChatGPT, Codex, Cursor and other agents to ${principal.orgName}. They sign in with your account in the browser, then act for you with the access you give them.`
          : "Connect agents on this computer to this workspace. This server has no sign-in, so they connect without one."}
      </Heading>

      <section className="mt-5" aria-label="MCP server URL">
        <h3 className="mb-2 text-[13px] font-medium">MCP server URL</h3>
        <CopyField value={url} label="MCP server URL" />
        <p className="mt-1.5 text-[13px] text-muted">Every app takes this one address. Pick yours below for the exact steps.</p>
      </section>

      <Setup url={url} oauth={oauth} />

      {oauth && (
        <Rows title={data?.everyone ? `Connected agents in ${principal.orgName}` : "Your connected agents"}>
          {!data && !error && <ListSkeleton />}
          {error && (
            <p role="alert" className="py-3 text-[13px] text-danger">
              {error}
            </p>
          )}
          {data?.agents.length === 0 && (
            <p className="py-3 text-[13px] text-muted">No agents yet. Add one with the steps above: it shows up here once you approve it in the browser.</p>
          )}
          {data && data.agents.length > 0 && (
            <ul className="divide-y divide-border" aria-label="Connected agents">
              {data.agents.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  mine={principal.actor.type === "user" && principal.actor.id === a.connectedBy.id}
                  everyone={data.everyone}
                  onDisconnect={async () => {
                    await run((c) => c.connections.disconnect({ params: { id: a.id } }))
                    await load()
                  }}
                />
              ))}
            </ul>
          )}
        </Rows>
      )}
      {oauth && data?.everyone && <p className="mt-3 text-[13px] text-muted">As an owner you see everyone's agents here and can disconnect any of them. Others see only their own.</p>}
    </>
  )
}

function AgentRow({ agent, mine, everyone, onDisconnect }: { agent: ConnectedAgent; mine: boolean; everyone: boolean; onDisconnect: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const who = mine ? "you" : agent.connectedBy.name
  // Most useful first: the row truncates from the end on narrow screens.
  const parts = [
    agent.access === "write" ? "Read and write" : "Read only",
    everyone && !mine ? `for ${who}` : null,
    agent.lastUsedAt ? `used ${timeAgo(agent.lastUsedAt)}` : "not used yet",
    `connected ${timeAgo(agent.connectedAt)}`,
    `from ${agent.redirectHost}`,
  ].filter(Boolean)
  const extra = agent.clientName && !agent.clientName.startsWith(agent.agentName) ? agent.clientName : null
  return (
    <Item
      avatar={<AgentTile name={agent.agentName} logoUri={agent.logoUri} size={32} />}
      title={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{agent.agentName}</span>
          {extra && <span className="truncate font-normal text-muted">· {extra}</span>}
          {!agent.member && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-hover px-1.5 py-px text-[11px] font-medium text-danger" title={`${agent.connectedBy.name} isn't a member anymore, so this agent is refused.`}>
              <WarningCircleIcon size={12} weight="bold" /> Not a member
            </span>
          )}
        </span>
      }
      detail={failed ?? parts.join(" · ")}
    >
      {confirming ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setFailed(null)
              void onDisconnect()
                .catch((e: Error) => setFailed(e.message))
                .finally(() => setBusy(false))
            }}
            className={danger}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={button}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={danger} aria-label={`Disconnect ${agent.agentName}${everyone ? ` for ${who}` : ""}`}>
          Disconnect
        </button>
      )}
    </Item>
  )
}

// --- Setup, per app ------------------------------------------------------------------------------

function Setup({ url, oauth }: { url: string; oauth: boolean }) {
  const [tab, setTab] = useState<Tab>("claude")
  if (!oauth) return <LocalSetup url={url} />
  const select = (next: Tab) => {
    setTab(next)
    document.getElementById(`connect-tab-${next}`)?.focus()
  }
  return (
    <section className="mt-6" aria-label="Connect an agent">
      <h3 className="mb-2 text-[13px] font-medium">Connect an agent</h3>
      <div
        role="tablist"
        aria-label="Apps"
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-px"
        onKeyDown={(e) => {
          const i = tabs.findIndex((t) => t.id === tab)
          if (e.key === "ArrowRight") select(tabs[(i + 1) % tabs.length]!.id)
          else if (e.key === "ArrowLeft") select(tabs[(i - 1 + tabs.length) % tabs.length]!.id)
          else return
          e.preventDefault()
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`connect-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="connect-panel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={`h-7 shrink-0 rounded-md px-2.5 text-[13px] font-medium ${tab === t.id ? "bg-active text-text" : "text-muted hover:bg-hover hover:text-text"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="connect-panel" role="tabpanel" aria-labelledby={`connect-tab-${tab}`} className="mt-2 rounded-lg border border-border px-4 py-3">
        <Steps tab={tab} url={url} />
      </div>
    </section>
  )
}

function Steps({ tab, url }: { tab: Tab; url: string }) {
  switch (tab) {
    case "claude":
      return (
        <ol className="space-y-3">
          <Step n={1}>
            In Claude (claude.ai or Claude Desktop), open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>. On a Team or Enterprise plan, an owner adds it
            first under <b>Organization settings → Connectors</b>.
          </Step>
          <Step n={2}>
            Name it <b>Standard Artifacts</b> and paste the URL:
            <Snippet bare label="URL" code={url} />
          </Step>
          <Step n={3}>
            Choose <b>Add</b>, then <b>Connect</b>. Sign in here, pick a workspace and approve. Claude.ai and Claude Desktop share the connector.
          </Step>
        </ol>
      )
    case "claude-code":
      return (
        <ol className="space-y-3">
          <Step n={1}>
            Add the server for all your projects:
            <Snippet bare label="Claude Code" code={`claude mcp add --transport http --scope user ${NAME} ${url}`} />
          </Step>
          <Step n={2}>
            In Claude Code, run <Code>/mcp</Code>, pick <b>{NAME}</b> and choose <b>Authenticate</b>.
          </Step>
          <Step n={3}>Your browser opens: pick a workspace and approve. Claude Code keeps itself signed in from then on.</Step>
        </ol>
      )
    case "chatgpt":
      return (
        <ol className="space-y-3">
          <Step n={1}>
            In ChatGPT, open <b>Settings → Apps &amp; Connectors → Advanced settings</b> and turn on <b>Developer mode</b>. A workspace admin may need to allow custom
            connectors first.
          </Step>
          <Step n={2}>
            Choose <b>Create</b> (add a custom connector). Name it <b>Standard Artifacts</b>, paste the URL, and pick <b>OAuth</b> for authentication:
            <Snippet bare label="MCP server URL" code={url} />
          </Step>
          <Step n={3}>
            Create it, then <b>Connect</b>. Sign in here, pick a workspace and approve.
          </Step>
        </ol>
      )
    case "codex":
      return (
        <ol className="space-y-3">
          <Step n={1}>
            Add the server:
            <Snippet bare label="Codex" code={`codex mcp add ${NAME} --url ${url}`} />
          </Step>
          <Step n={2}>
            Sign in. Your browser opens; pick a workspace and approve:
            <Snippet bare label="Codex login" code={`codex mcp login ${NAME}`} />
          </Step>
          <Step n={3}>Start a new Codex session to load the tools.</Step>
        </ol>
      )
    case "cursor": {
      const config = { url }
      const deeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${NAME}&config=${btoa(JSON.stringify(config))}`
      return (
        <ol className="space-y-3">
          <Step n={1}>
            <span className="flex flex-wrap items-center gap-2">
              <a href={deeplink} className={button}>
                Add to Cursor <ArrowSquareOutIcon size={13} className="ml-1" />
              </a>
              <span className="text-muted">or add it to</span> <Code>~/.cursor/mcp.json</Code>:
            </span>
            <Snippet bare label="Cursor" code={JSON.stringify({ mcpServers: { [NAME]: config } }, null, 2)} />
          </Step>
          <Step n={2}>
            In <b>Cursor Settings → MCP</b>, Standard Artifacts says it needs to sign in: choose <b>Connect</b> and approve in the browser.
          </Step>
        </ol>
      )
    }
    case "vscode": {
      const server = { name: NAME, type: "http", url }
      const deeplink = `vscode:mcp/install?${encodeURIComponent(JSON.stringify(server))}`
      return (
        <ol className="space-y-3">
          <Step n={1}>
            <span className="flex flex-wrap items-center gap-2">
              <a href={deeplink} className={button}>
                Add to VS Code <ArrowSquareOutIcon size={13} className="ml-1" />
              </a>
              <span className="text-muted">or run:</span>
            </span>
            <Snippet bare label="VS Code" code={`code --add-mcp '${JSON.stringify(server)}'`} />
          </Step>
          <Step n={2}>
            Start the server from the <b>MCP Servers</b> list. VS Code asks to sign in: allow it and approve in the browser.
          </Step>
        </ol>
      )
    }
    case "other":
      return (
        <ol className="space-y-3">
          <Step n={1}>
            Most MCP clients take a Streamable HTTP URL and sign in with OAuth on first connect. If yours reads an <Code>mcpServers</Code> file, add:
            <Snippet bare label="mcpServers" code={JSON.stringify({ mcpServers: { [NAME]: { type: "http", url } } }, null, 2)} />
          </Step>
          <Step n={2}>
            Can't sign in from your client? Send an{" "}
            <Link to="/settings/{-$section}" params={{ section: "tokens" }} className="text-accent hover:underline">
              access token
            </Link>{" "}
            as a header instead:
            <Snippet bare label="Header" code={"Authorization: Bearer $STDARTIFACTS_TOKEN"} />
          </Step>
        </ol>
      )
  }
}

/** A dev server: no sign-in, so local agents connect as they are (stdio or HTTP). */
function LocalSetup({ url }: { url: string }) {
  const origin = new URL(url).origin
  return (
    <>
      <Rows title="Connect an agent">
        <Snippet label="Claude Code" code={`claude mcp add ${NAME} -e STDARTIFACTS_URL=${origin} -- npx stdartifacts mcp`} />
        <Snippet label="Claude Code over HTTP" code={`claude mcp add --transport http ${NAME} ${url}`} />
        <Snippet label="Codex" code={`codex mcp add ${NAME} --url ${url}`} />
      </Rows>
      <p className="mt-3 text-[13px] text-muted">This server has no sign-in, so agents on this machine connect without a token. It only answers requests from this machine.</p>
    </>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-[13px] leading-5">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-active text-[11px] font-semibold text-muted">{n}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  )
}

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-surface px-1 py-px font-mono text-[12px]">{children}</code>

/** One value, selectable, with a copy button: the MCP URL people paste into their apps. */
function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle")
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied("copied")
    } catch {
      setCopied("failed")
    }
    setTimeout(() => setCopied("idle"), 1600)
  }
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-surface py-1 pr-1 pl-3">
      <input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 bg-transparent py-1 font-mono text-[13px] text-text outline-none"
      />
      <button
        type="button"
        onClick={() => void copy()}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-bg px-2.5 text-[13px] font-medium text-text shadow-sm ring-1 ring-border hover:bg-hover"
        title={copied === "failed" ? "Couldn't copy. Select the text instead." : undefined}
      >
        {copied === "copied" ? <CheckIcon size={14} weight="bold" className="text-table" /> : <CopyIcon size={14} />}
        {copied === "copied" ? "Copied" : "Copy"}
      </button>
    </div>
  )
}
