import { Context } from "effect"
import type { BoardCell } from "./cells/board-cell"
import type { DocCell } from "./cells/doc-cell"
import type { McpCell } from "./cells/mcp-cell"
import type { RunnerCell } from "./cells/runner-cell"
import type { TrackerCell } from "./cells/tracker-cell"
import type { TableCell } from "./cells/table-cell"
import type { WorkspaceCell } from "./cells/workspace-cell"

/**
 * Worker bindings. alchemy.run.ts (and wrangler.jsonc, for celld) must declare
 * the same names.
 */
export interface Env {
  readonly WORKSPACE: DurableObjectNamespace<WorkspaceCell>
  readonly TABLE: DurableObjectNamespace<TableCell>
  readonly BOARD: DurableObjectNamespace<BoardCell>
  readonly DOC: DurableObjectNamespace<DocCell>
  readonly TRACKER: DurableObjectNamespace<TrackerCell>
  /** Remote MCP sessions, one cell per principal. */
  readonly MCP: DurableObjectNamespace<McpCell>
  /** Hosted agent runs (Cloudflare containers). Absent in dev and on celld, where `stdartifacts agent serve` does this. */
  readonly RUNNER?: DurableObjectNamespace<RunnerCell>
  /** The model key for hosted runs. Stays in the Worker; containers never see it. */
  readonly ANTHROPIC_API_KEY?: string
  /** Most hosted runs per org in 24 hours (default 50), which caps spend at this times the per-run budget. */
  readonly RUNNER_DAILY_RUNS?: string
  /** "dev" allows ticketless requests as a local owner. Never set in production. */
  readonly AUTH_MODE?: string
  /** Dev only: the local owner's display name (default "JC"). `stdartifacts serve` sets it from the OS user. */
  readonly DEV_OWNER_NAME?: string
  /** Dev only: hosts besides localhost allowed to reach a dev server (comma-separated), e.g. a tunnel. See dev-guard.ts. */
  readonly DEV_ALLOWED_HOSTS?: string
  /** Tickets are HMAC-SHA256 signed with it. Required in live mode. */
  readonly TICKET_SECRET?: string
  /**
   * Sign-in (live mode): WorkOS AuthKit, with WorkOS Organizations as the source
   * of truth for members and roles. Live mode needs all three, or every sign-in
   * fails with a message saying what's missing; it never falls back to dev.
   */
  readonly WORKOS_API_KEY?: string
  readonly WORKOS_CLIENT_ID?: string
  /** Seals the session cookie (AES-GCM). At least 32 characters. Changing it signs everyone out. */
  readonly WORKOS_COOKIE_PASSWORD?: string
  /** The app's public address, for AuthKit's redirect URI (<APP_URL>/api/auth/callback). Default: the request's origin. */
  readonly APP_URL?: string
  /** Default https://api.workos.com. The tests point it at a fake. */
  readonly WORKOS_API_URL?: string
  /** Turns on content search. Without it, nothing is indexed and search matches titles only. */
  readonly TURBOPUFFER_API_KEY?: string
  /** The region's host (default aws-us-east-1). Namespaces live in one region. */
  readonly TURBOPUFFER_URL?: string
  /** Namespace prefix, to keep stages apart in one account. */
  readonly SEARCH_PREFIX?: string
}

/** The raw Workers env, for services that need DO namespaces. Config values go through Config. */
export class Bindings extends Context.Service<Bindings, Env>()("@standard-artifacts/Bindings") {}
