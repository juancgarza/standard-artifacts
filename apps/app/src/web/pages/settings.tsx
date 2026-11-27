import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react"
import { Heading, ListSkeleton, Row, Rows, Snippet, roles } from "../components/settings-parts"
import { Link, useParams } from "@tanstack/react-router"
import {
  BuildingsIcon,
  CreditCardIcon,
  DesktopIcon,
  KeyIcon,
  MoonIcon,
  PaletteIcon,
  RobotIcon,
  SunIcon,
  UserIcon,
  UsersThreeIcon,
  type IconProps,
} from "@phosphor-icons/react"
import { BrandTile, brandOf } from "@standard-artifacts/room/brands"
import { colorFor, type OrgDirectory, type Principal } from "@standard-artifacts/protocol"
import { Initial } from "../components/share-dialog"
import { SidebarToggle } from "../components/sidebar-collapse"
import { setTheme, useTheme, type Theme } from "../theme"
import { timeAgo } from "../time"
import { useWorkspace, type DevAs } from "../workspace"
import { Avatar } from "../components/account-menu"
import { AccessTokens, LiveMembers } from "./settings-account"
import { Billing } from "./settings-billing"

type SectionId = "profile" | "appearance" | "tokens" | "general" | "members" | "agents" | "billing"
type NavGroup = { label: string; items: ReadonlyArray<{ id: SectionId; label: string; icon: ComponentType<IconProps> }> }

const groups: ReadonlyArray<NavGroup> = [
  {
    label: "Personal",
    items: [
      { id: "profile", label: "Profile", icon: UserIcon },
      { id: "appearance", label: "Appearance", icon: PaletteIcon },
      { id: "tokens", label: "Access tokens", icon: KeyIcon },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "general", label: "General", icon: BuildingsIcon },
      { id: "members", label: "Members", icon: UsersThreeIcon },
      { id: "agents", label: "Agents", icon: RobotIcon },
      { id: "billing", label: "Billing", icon: CreditCardIcon },
    ],
  },
]

/** A guest has no account and isn't a member, so all that's theirs to set is how the page looks. */
const guestGroups: ReadonlyArray<NavGroup> = [{ label: "Personal", items: groups[0]!.items.filter((s) => s.id === "appearance") }]


/** Personal and workspace settings. A normal page, so it takes a tab like any other and links can point at a section. */
/** Access tokens need an account: a dev server has none (its CLI and MCP need no token). */
const devGroups: ReadonlyArray<NavGroup> = groups.map((g) => ({ ...g, items: g.items.filter((s) => s.id !== "tokens" && s.id !== "billing") }))

/** Billing shows only where the server bills (Cloud). */
const unbilledGroups: ReadonlyArray<NavGroup> = groups.map((g) => ({ ...g, items: g.items.filter((s) => s.id !== "billing") }))

export function SettingsPage() {
  const { principal, account, billing } = useWorkspace()
  const { section } = useParams({ from: "/settings/{-$section}" })
  const visible = principal?.actor.type === "guest" ? guestGroups : account ? (billing ? groups : unbilledGroups) : devGroups
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
  const { account } = useWorkspace()
  switch (id) {
    case "profile":
      return <Profile principal={principal} />
    case "appearance":
      return <Appearance />
    case "general":
      return <General principal={principal} />
    case "tokens":
      return <AccessTokens principal={principal} />
    case "members":
      return account ? <LiveMembers principal={principal} /> : <Members principal={principal} />
    case "agents":
      return <Agents principal={principal} />
    case "billing":
      return <Billing principal={principal} />
  }
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
  const { account } = useWorkspace()
  const { actor, role } = principal
  const name = actor.type === "user" ? actor.name : actor.type === "agent" ? (actor.name ?? "Agent") : "Guest"
  return (
    <>
      <Heading title="Profile">Your name and role come from your account.</Heading>
      <Rows>
        <Row label="Name">
          <span className="flex items-center gap-2.5 text-text">
            {account ? <Avatar name={name} id={actor.id} url={account.user.avatarUrl} size={32} /> : <Initial name={name} color={colorFor(actor.id)} />}
            {name}
          </span>
        </Row>
        {account && (
          <Row label="Email">
            <span className="text-text">{account.user.email}</span>
          </Row>
        )}
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
  const { editable, billing } = useWorkspace()
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
          {billing ? (
            <Link to="/settings/{-$section}" params={{ section: "billing" }} className="text-text hover:underline">
              {principal.plan === "team" ? "Team" : "Free"}
            </Link>
          ) : (
            <span className="text-text">{principal.plan === "team" ? "Team" : "Free"}</span>
          )}
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
      <p className="mt-3 text-[13px] text-muted">
        This server has no sign-in, so there's no one to invite. To show someone your work, share a view-only link from any artifact. With sign-in (Standard Artifacts Cloud, or
        self-hosted with WorkOS), owners invite people here and choose their roles.
      </p>
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
        {live ? (
          <>
            Each request needs a token.{" "}
            <Link to="/settings/{-$section}" params={{ section: "tokens" }} className="text-accent hover:underline">
              Create one under Access tokens
            </Link>
            , then set STDARTIFACTS_TOKEN to it.
          </>
        ) : (
          "This server has no sign-in, so agents on this machine connect without a token. It only answers requests from this machine."
        )}
      </p>
    </>
  )
}
