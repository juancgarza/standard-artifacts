import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react"
import { Link, useParams } from "@tanstack/react-router"
import {
  BuildingsIcon,
  CheckIcon,
  CopyIcon,
  DesktopIcon,
  MoonIcon,
  PaletteIcon,
  RobotIcon,
  SunIcon,
  UserIcon,
  UsersThreeIcon,
  type IconProps,
} from "@phosphor-icons/react"
import { BrandTile, brandOf } from "@standard-artifacts/room/brands"
import { colorFor, type OrgDirectory, type Principal, type Role } from "@standard-artifacts/protocol"
import { Initial } from "../components/share-dialog"
import { SidebarToggle } from "../components/sidebar-collapse"
import { setTheme, useTheme, type Theme } from "../theme"
import { timeAgo } from "../time"
import { useWorkspace, type DevAs } from "../workspace"

type SectionId = "profile" | "appearance" | "general" | "members" | "agents"
type NavGroup = { label: string; items: ReadonlyArray<{ id: SectionId; label: string; icon: ComponentType<IconProps> }> }

const groups: ReadonlyArray<NavGroup> = [
  {
    label: "Personal",
    items: [
      { id: "profile", label: "Profile", icon: UserIcon },
      { id: "appearance", label: "Appearance", icon: PaletteIcon },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "general", label: "General", icon: BuildingsIcon },
      { id: "members", label: "Members", icon: UsersThreeIcon },
      { id: "agents", label: "Agents", icon: RobotIcon },
    ],
  },
]

/** A guest has no account and isn't a member, so all that's theirs to set is how the page looks. */
const guestGroups: ReadonlyArray<NavGroup> = [{ label: "Personal", items: groups[0]!.items.filter((s) => s.id === "appearance") }]

const roles: Record<Role, { label: string; help: string }> = {
  owner: { label: "Owner", help: "Edits everything and looks after the workspace." },
  editor: { label: "Editor", help: "Edits everything and turns share links on or off." },
  viewer: { label: "Viewer", help: "Opens everything but can't change it." },
}

/** Personal and workspace settings. A normal page, so it takes a tab like any other and links can point at a section. */
export function SettingsPage() {
  const { principal } = useWorkspace()
  const { section } = useParams({ from: "/settings/{-$section}" })
  const visible = principal?.actor.type === "guest" ? guestGroups : groups
  const items = visible.flatMap((g) => g.items)
  const active = items.find((s) => s.id === section) ?? items[0]!

  return (
    <div className="mx-auto max-w-[920px] px-4 py-8 md:px-10 md:py-10">
      <div className="flex items-center gap-2">
        <SidebarToggle placement="page" className="-ml-1.5" />
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
      </div>

      {principal && (
        <div className="mt-5 flex flex-col gap-5 lg:mt-7 lg:flex-row lg:gap-10">
          <SectionNav groups={visible} active={active.id} />
          <div className="min-w-0 flex-1 lg:max-w-[640px]">
            <Section id={active.id} principal={principal} />
            {import.meta.env.DEV && <DevViewAs />}
          </div>
        </div>
      )}
    </div>
  )
}

function SectionNav({ groups, active }: { groups: ReadonlyArray<NavGroup>; active: SectionId }) {
  // On small screens the nav is a row that scrolls: keep the current section in view.
  const current = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active])

  return (
    <nav aria-label="Settings" className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 lg:mx-0 lg:w-[176px] lg:flex-col lg:gap-4 lg:overflow-visible lg:px-0">
      {groups.map((group) => (
        <div key={group.label} className="flex shrink-0 gap-1 lg:flex-col lg:gap-px">
          <div className="hidden px-2 pb-1 text-[12px] font-medium text-faint lg:block">{group.label}</div>
          {group.items.map(({ id, label, icon: Icon }) => (
            <Link
              key={id}
              ref={id === active ? current : undefined}
              to="/settings/{-$section}"
              params={{ section: id }}
              aria-current={id === active ? "page" : undefined}
              className={`flex h-8 shrink-0 items-center gap-2 rounded-md px-2 hover:bg-hover hover:text-text ${id === active ? "bg-active text-text" : "text-muted"}`}
            >
              <Icon size={16} /> {label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}

function Section({ id, principal }: { id: SectionId; principal: Principal }) {
  switch (id) {
    case "profile":
      return <Profile principal={principal} />
    case "appearance":
      return <Appearance />
    case "general":
      return <General principal={principal} />
    case "members":
      return <Members principal={principal} />
    case "agents":
      return <Agents principal={principal} />
  }
}

// --- Layout -------------------------------------------------------------------------

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header>
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {children && <p className="mt-1 text-[13px] text-muted">{children}</p>}
    </header>
  )
}

/** A group of rows; `title` labels it when a section has more than one. */
function Rows({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      {title && <h3 className="mb-2 text-[13px] font-medium">{title}</h3>}
      <div className="divide-y divide-border border-y border-border">{children}</div>
    </section>
  )
}

/** Text on the left, the value or control on the right; they stack when there's no room. */
function Row({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5">
      <div className="min-w-0 flex-[1_1_220px]">
        <div className="font-medium">{label}</div>
        {help && <p className="mt-0.5 text-[13px] text-muted">{help}</p>}
      </div>
      <div className="min-w-0 text-muted">{children}</div>
    </div>
  )
}

/**
 * Dev only: who the local server treats you as. It sits under every section,
 * not in one, because a guest only sees Appearance and still has to switch back.
 */
function DevViewAs() {
  const { devAs, setDevAs } = useWorkspace()
  return (
    <Rows title="Development">
      <Row label="View as" help="Only in dev. Try the app as a viewer or a guest without a second account.">
        <select
          aria-label="View as"
          value={devAs}
          onChange={(e) => setDevAs(e.target.value as DevAs)}
          className="h-7 rounded-md border border-border bg-bg px-1.5 text-[13px] text-text"
        >
          <option value="owner">Owner</option>
          <option value="viewer">Viewer</option>
          <option value="guest">Guest</option>
        </select>
      </Row>
    </Rows>
  )
}

// --- Sections -----------------------------------------------------------------------

function Profile({ principal }: { principal: Principal }) {
  const { actor, role } = principal
  const name = actor.type === "user" ? actor.name : actor.type === "agent" ? (actor.name ?? "Agent") : "Guest"
  return (
    <>
      <Heading title="Profile">Your name and role come from your account.</Heading>
      <Rows>
        <Row label="Name">
          <span className="flex items-center gap-2.5 text-text">
            <Initial name={name} color={colorFor(actor.id)} />
            {name}
          </span>
        </Row>
        <Row label="Role" help={roles[role].help}>
          {roles[role].label}
        </Row>
      </Rows>
    </>
  )
}

const themes: ReadonlyArray<{ id: Theme; label: string; icon: ComponentType<IconProps> }> = [
  { id: "light", label: "Light", icon: SunIcon },
  { id: "dark", label: "Dark", icon: MoonIcon },
  { id: "system", label: "System", icon: DesktopIcon },
]

function Appearance() {
  const theme = useTheme()
  return (
    <>
      <Heading title="Appearance" />
      <Rows>
        <Row label="Theme" help="Saved in this browser. System follows your device.">
          <div role="radiogroup" aria-label="Theme" className="flex rounded-lg bg-hover p-0.5">
            {themes.map(({ id, label, icon: Icon }) => (
              <label
                key={id}
                className={`flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] has-focus-visible:outline-2 has-focus-visible:outline-accent ${
                  theme === id ? "bg-bg font-medium text-text shadow-sm" : "text-muted hover:text-text"
                }`}
              >
                <input type="radio" name="theme" value={id} checked={theme === id} onChange={() => setTheme(id)} className="sr-only" />
                <Icon size={14} /> {label}
              </label>
            ))}
          </div>
        </Row>
      </Rows>
    </>
  )
}

function General({ principal }: { principal: Principal }) {
  const { editable } = useWorkspace()
  return (
    <>
      <Heading title="General" />
      <Rows>
        <Row label="Name" help="Comes from your organization's account.">
          <span className="text-text">{principal.orgName}</span>
        </Row>
        <Row
          label="Plan"
          help={
            principal.plan === "team"
              ? "Everyone in the workspace works together, each with their own role."
              : "Only you and your agents edit. Others can view through a share link."
          }
        >
          <span className="text-text">{principal.plan === "team" ? "Team" : "Free"}</span>
        </Row>
        {editable && (
          <Row label="Archived" help="Hidden from the workspace, agents and share links until restored.">
            <Link to="/archived" className="flex h-7 items-center rounded-md border border-border px-2.5 text-[13px] font-medium text-text hover:bg-hover">
              Open
            </Link>
          </Row>
        )}
      </Rows>
    </>
  )
}

/** Who has shown up in the org, for the sections that list them. */
function useDirectory() {
  const { loadDirectory } = useWorkspace()
  const [directory, setDirectory] = useState<OrgDirectory | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    loadDirectory()
      .then((d) => !cancelled && setDirectory(d))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [loadDirectory])
  return { directory, error }
}

function ListSkeleton() {
  return (
    <div className="space-y-3 py-3" aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="size-8 animate-pulse rounded-full bg-active" />
          <span className="h-3 w-40 animate-pulse rounded bg-active" />
        </div>
      ))}
    </div>
  )
}

function ListRow({ avatar, name, detail, role }: { avatar: ReactNode; name: ReactNode; detail: string; role: string }) {
  return (
    <li className="flex min-h-13 items-center gap-3 py-2">
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className="truncate text-[13px] text-muted">{detail}</div>
      </div>
      <span className="shrink-0 text-[13px] text-muted" title="Roles come from your org account">
        {role}
      </span>
    </li>
  )
}

function Members({ principal }: { principal: Principal }) {
  const { directory, error } = useDirectory()
  const self = principal.actor
  return (
    <>
      <Heading title="Members">People at {principal.orgName} who have opened this workspace.</Heading>
      {error && <p className="mt-5 text-[13px] text-danger">{error}</p>}
      <Rows>
        {!directory && !error && <ListSkeleton />}
        {directory && (
          <ul className="divide-y divide-border">
            {directory.people.map((p) => (
              <ListRow
                key={p.id}
                avatar={<Initial name={p.name} color={colorFor(p.id)} />}
                name={
                  <>
                    {p.name}
                    {self.type === "user" && self.id === p.id && <span className="font-normal text-muted"> (you)</span>}
                  </>
                }
                detail={`Active ${timeAgo(p.lastSeenAt)}`}
                role={roles[p.role].label}
              />
            ))}
          </ul>
        )}
      </Rows>
      <p className="mt-3 text-[13px] text-muted">Email invites and role changes aren't available yet. To show someone your work, share a view-only link from any artifact.</p>
    </>
  )
}

function Agents({ principal }: { principal: Principal }) {
  const { directory, error } = useDirectory()
  const self = principal.actor
  const nameOf = (id: string) => directory?.people.find((p) => p.id === id)?.name
  return (
    <>
      <Heading title="Agents">An agent acts for a person, with that person's access, and doesn't take a seat.</Heading>
      {error && <p className="mt-5 text-[13px] text-danger">{error}</p>}
      <Rows title="Active in this workspace">
        {!directory && !error && <ListSkeleton />}
        {directory?.agents.length === 0 && <p className="py-3 text-[13px] text-muted">No agents yet. They show up here once they act.</p>}
        {directory && directory.agents.length > 0 && (
          <ul className="divide-y divide-border">
            {directory.agents.map((a) => {
              const brand = brandOf(a.name) ?? brandOf(a.id)
              return (
                <ListRow
                  key={a.key}
                  avatar={
                    brand ? (
                      <BrandTile brand={brand} size={32} title={a.name} />
                    ) : (
                      <span className="grid size-8 shrink-0 place-items-center rounded-[9px] text-white" style={{ background: colorFor(a.key) }}>
                        <RobotIcon size={17} weight="bold" />
                      </span>
                    )
                  }
                  name={a.name}
                  detail={`Acts for ${self.type === "user" && self.id === a.onBehalfOf ? "you" : (a.onBehalfOfName ?? nameOf(a.onBehalfOf) ?? "a teammate")} · active ${timeAgo(a.lastSeenAt)}`}
                  role={roles[a.role === "owner" ? "editor" : a.role].label}
                />
              )
            })}
          </ul>
        )}
      </Rows>
      <Connect />
    </>
  )
}

/**
 * Every client reaches the same tools at /mcp. Live, each request needs a token.
 * A dev server (`stdartifacts serve`, `pnpm dev`) has no sign-in and answers only
 * this machine, so local agents connect without one. The server says which it is.
 */
function Connect() {
  const { authMode } = useWorkspace()
  const origin = window.location.origin
  const url = `${origin}/mcp`
  const live = authMode ? authMode === "live" : !import.meta.env.DEV
  return (
    <>
      <Rows title="Connect an agent">
        {live ? (
          <>
            <Snippet label="Claude Code" code={`claude mcp add --transport http stdartifacts ${url} --header "Authorization: Bearer $STDARTIFACTS_TOKEN"`} />
            <Snippet label="Codex" code={`codex mcp add stdartifacts --url ${url} --bearer-token-env-var STDARTIFACTS_TOKEN`} />
            <Snippet label="ChatGPT" help="Add as a connector in developer mode. Needs a public HTTPS address." code={url} />
          </>
        ) : (
          <>
            <Snippet label="Claude Code" code={`claude mcp add stdartifacts -e STDARTIFACTS_URL=${origin} -- npx stdartifacts mcp`} />
            <Snippet label="Claude Code over HTTP" code={`claude mcp add --transport http stdartifacts ${url}`} />
            <Snippet label="Codex" code={`codex mcp add stdartifacts --url ${url}`} />
          </>
        )}
      </Rows>
      <p className="mt-3 text-[13px] text-muted">
        {live
          ? "Each request needs a token, and you can't create one here yet."
          : "This server has no sign-in, so agents on this machine connect without a token. It only answers requests from this machine."}
      </p>
    </>
  )
}

function Snippet({ label, help, code }: { label: string; help?: string; code: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setState("copied")
    } catch {
      setState("failed")
    }
    setTimeout(() => setState("idle"), 1600)
  }
  return (
    <div className="py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{label}</span>
        {help && <span className="min-w-0 text-[13px] text-muted">{help}</span>}
      </div>
      <div className="mt-1.5 flex items-start gap-1 rounded-md bg-surface py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[12px] leading-5 whitespace-pre">{code}</code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label} setup`}
          title={state === "failed" ? "Couldn't copy. Select the text instead." : "Copy"}
          className="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-text"
        >
          {state === "copied" ? <CheckIcon size={14} weight="bold" className="text-table" /> : <CopyIcon size={14} />}
        </button>
      </div>
    </div>
  )
}
