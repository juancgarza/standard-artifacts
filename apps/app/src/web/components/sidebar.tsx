import { useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { ArchiveIcon, GearSixIcon, HouseIcon, LockSimpleIcon, MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react"
import { kindOrder, kinds, type ArtifactKind } from "@standard-artifacts/protocol"
import { useWorkspace } from "../workspace"
import { shortcutLabel } from "./command-palette"
import { SidebarToggle } from "./sidebar-collapse"
import { Folders } from "./sidebar-folders"
import { Row, SectionHeader, useActiveId } from "./sidebar-parts"
import { AccountMenu } from "./account-menu"
import { signIn } from "../session"

/** Rows per kind section before "See all". */
const TOP = 5

export function Sidebar({ onNavigate, onSearch, collapsible }: { onNavigate?: () => void; onSearch: () => void; collapsible?: boolean }) {
  const { principal, editable } = useWorkspace()

  return (
    <nav aria-label="Workspace" data-tab-links className="flex h-full w-full flex-col bg-surface">
      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2">
        <div className="grid size-7 place-items-center rounded-md bg-accent text-[13px] font-semibold text-accent-text">
          {principal?.orgName.charAt(0) ?? "·"}
        </div>
        <div className="min-w-0 flex-1 truncate font-medium">{principal?.orgName ?? "Loading…"}</div>
        {principal && (
          <span className="rounded-full border border-border px-1.5 py-px text-[11px] text-muted capitalize">
            {principal.plan}
          </span>
        )}
        {collapsible && <SidebarToggle placement="sidebar" className="-mr-1" />}
      </div>

      <div className="space-y-px px-2 py-1">
        <button
          type="button"
          onClick={onSearch}
          aria-keyshortcuts="Meta+K Control+K"
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-muted hover:bg-hover hover:text-text"
        >
          <MagnifyingGlassIcon size={16} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border border-border bg-bg px-1.5 py-px font-sans text-[11px] text-faint">{shortcutLabel()}</kbd>
        </button>
        <Link
          to="/"
          onClick={onNavigate}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-muted hover:bg-hover hover:text-text"
          activeProps={{ className: "bg-active !text-text" }}
          activeOptions={{ exact: true }}
        >
          <HouseIcon size={16} /> Home
        </Link>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-2 pt-2 pb-4">
        <Starred onNavigate={onNavigate} />
        <Folders onNavigate={onNavigate} />
        {kindOrder.map((kind) => (
          <Section key={kind} kind={kind} editable={editable} onNavigate={onNavigate} />
        ))}
        {editable && (
          <Link
            to="/archived"
            onClick={onNavigate}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-muted hover:bg-hover hover:text-text"
            activeProps={{ className: "bg-active !text-text" }}
          >
            <ArchiveIcon size={16} /> Archived
          </Link>
        )}
      </div>

      <Footer onNavigate={onNavigate} />
    </nav>
  )
}

function Starred({ onNavigate }: { onNavigate?: () => void }) {
  const { artifacts, starred } = useWorkspace()
  const [open, setOpen] = useState(true)
  const byId = new Map(artifacts.map((a) => [a.id, a]))
  const items = starred.flatMap((id) => byId.get(id) ?? [])
  if (items.length === 0) return null

  return (
    <section aria-label="Starred">
      <SectionHeader open={open} onToggle={() => setOpen((o) => !o)} label="Starred" />
      {open && (
        <ul className="mt-0.5 space-y-px">
          {items.map((a) => (
            <Row key={a.id} artifact={a} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Section({ kind, editable, onNavigate }: { kind: ArtifactKind; editable: boolean; onNavigate?: () => void }) {
  const { artifacts, create, status, principal } = useWorkspace()
  const navigate = useNavigate()
  const activeId = useActiveId()
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)
  const [creating, setCreating] = useState(false)
  const items = artifacts.filter((a) => a.kind === kind)
  const meta = kinds[kind]

  // The top few by last update; the open artifact stays visible even when it's older.
  let shown = all ? items : items.slice(0, TOP)
  if (!all && activeId && !shown.some((a) => a.id === activeId)) {
    const current = items.find((a) => a.id === activeId)
    if (current) shown = [...shown, current]
  }
  const hidden = items.length - shown.length

  const onCreate = async () => {
    setCreating(true)
    const artifact = await create(kind)
    setCreating(false)
    if (artifact) {
      setOpen(true)
      onNavigate?.()
      navigate({ to: "/$kind/$id/{-$item}", params: { kind: meta.slug, id: artifact.id, item: undefined } })
    }
  }

  // A share-link guest is scoped to one artifact: other kinds would only ever be empty.
  if (principal?.scope && status === "ready" && items.length === 0) return null

  return (
    <section aria-label={meta.label}>
      <SectionHeader open={open} onToggle={() => setOpen((o) => !o)} label={meta.label} count={items.length}>
        {editable && (
          <button
            type="button"
            onClick={onCreate}
            disabled={creating}
            aria-label={`New ${meta.singular.toLowerCase()}`}
            title={`New ${meta.singular.toLowerCase()}`}
            className="grid size-6 place-items-center rounded text-muted opacity-0 group-hover:opacity-100 hover:bg-active hover:text-text focus-visible:opacity-100 disabled:opacity-50 max-md:opacity-100"
          >
            <PlusIcon size={14} weight="bold" />
          </button>
        )}
      </SectionHeader>

      {open && (
        <ul className="mt-0.5 space-y-px">
          {shown.map((a) => (
            <Row key={a.id} artifact={a} onNavigate={onNavigate} />
          ))}
          {(hidden > 0 || all) && items.length > TOP && (
            <li>
              <button
                type="button"
                onClick={() => setAll((v) => !v)}
                aria-expanded={all}
                className="flex h-7 w-full items-center rounded-md pl-8 text-[13px] text-muted hover:bg-hover hover:text-text"
              >
                {all ? "Show less" : `See all ${items.length}`}
              </button>
            </li>
          )}
          {status === "ready" && items.length === 0 && (
            <li className="px-2 py-1 text-[13px] text-faint">
              {editable ? (
                <button type="button" onClick={onCreate} className="hover:text-muted">
                  + New {meta.singular.toLowerCase()}
                </button>
              ) : (
                `No ${meta.label.toLowerCase()} yet`
              )}
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

function Footer({ onNavigate }: { onNavigate?: () => void }) {
  const { principal, account, authMode } = useWorkspace()
  const actor = principal?.actor
  const name = !actor ? "" : actor.type === "user" ? actor.name : actor.type === "guest" ? "Guest" : "Agent"

  return (
    <div className="border-t border-border p-2">
      {actor?.type === "guest" && (
        <div className="mb-2 rounded-md border border-border bg-bg p-2.5 text-[13px]">
          <div className="flex items-center gap-1.5 font-medium">
            <LockSimpleIcon size={14} /> Read-only
          </div>
          <p className="mt-1 text-muted">Create an account to edit and run agents.</p>
          {authMode === "live" && (
            <button type="button" onClick={() => signIn()} className="mt-2 font-medium text-accent hover:underline">
              Sign in
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-1 py-1">
        {account ? (
          <AccountMenu account={account} />
        ) : (
          <>
            <div className="grid size-6 place-items-center rounded-full bg-active text-[11px] font-medium">{name.charAt(0)}</div>
            <div className="min-w-0 flex-1 truncate text-[13px]">{name}</div>
          </>
        )}
        <Link
          to="/settings/{-$section}"
          params={{ section: undefined }}
          onClick={onNavigate}
          aria-label="Settings"
          title="Settings"
          className="-mr-0.5 grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-text"
          activeProps={{ className: "bg-active !text-text" }}
        >
          <GearSixIcon size={15} />
        </Link>
      </div>
    </div>
  )
}
