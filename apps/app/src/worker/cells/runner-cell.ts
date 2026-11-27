import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import type { Principal } from "@standard-artifacts/protocol"
import { handle } from "../app"
import type { Env } from "../env"
import type { HostedRunsRefusal } from "../plans"
import { appHost, routeOutbound } from "../runner-outbound"
import { signTicket } from "../tickets"

/**
 * Hosted agent runs: one Cloudflare container per mention, running
 * `stdartifacts agent serve --once`, which answers one mention and exits. Nothing sits
 * idle, and runs can't see each other.
 *
 * WorkspaceCell decides when to start one, and this cell asks it again before
 * starting: with billing on, hosted runs are for paying workspaces (see
 * `hostedRuns` in plans.ts). The container has no internet and no secrets;
 * RunnerOutbound adds credentials to what it sends. Only the Cloudflare
 * deploy binds this class (see alchemy.run.ts). Dev and celld use `stdartifacts agent serve`.
 */

/** Stops a stuck run. It's below the mention's 10-minute lease, so a run is dead before another can claim the mention. */
const RUN_LIMIT_MS = 9 * 60 * 1000
/** Outlives the run, and expires soon after, since a ticket can't be revoked. */
const TICKET_TTL_SECONDS = 10 * 60

/** Model spend per run. The run's limits are flags here, not settings the agent or the container can change. */
const BUDGET_USD = "1"
const MAX_TURNS = "30"

export interface RunnerJob {
  readonly orgId: string
  readonly orgName: string
  readonly plan: Principal["plan"]
  /** The person who asked. The agent acts for them. */
  readonly requestedBy: string
  /** Their role now, under the org's plan (an Editor on Free limits reads). The run never acts above it, or above editor. */
  readonly role: Principal["role"]
  readonly mentionId: string
}

/** Whether a run started, or why not: not entitled to hosted runs, or the person who asked can only read. */
export type RunOutcome = { readonly started: true } | { readonly started: false; readonly reason: HostedRunsRefusal | "read-only" }

export interface RunnerProps {
  readonly ticket: string
}

/** On, only when the deploy bound the class and every secret a run needs is set. */
export const runnerEnabled = (env: Env) => !!(env.RUNNER && env.ANTHROPIC_API_KEY && env.TICKET_SECRET)

/** The agent a run acts as: the requester's agent, with their role (WorkspaceCell works it out), never an owner. */
export function runnerPrincipal(job: RunnerJob): Principal {
  return {
    orgId: job.orgId,
    orgName: job.orgName,
    plan: job.plan,
    role: job.role === "owner" ? "editor" : job.role,
    // An agent's own request is keyed "agent:person"; the person is who it acts for.
    actor: { type: "agent", id: "agt_claude", onBehalfOf: job.requestedBy.split(":").at(-1) ?? job.requestedBy, name: "Claude" },
  }
}

export class RunnerCell extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The timeout doesn't survive a restart of this object, so it's set again here.
    if (ctx.container?.running) void ctx.container.setInactivityTimeout(RUN_LIMIT_MS)
  }

  /**
   * Start the run. Returns once it's started, not when it finishes: the mention's status tracks the outcome.
   * Asks the org's WorkspaceCell first whether this run may be hosted, whoever called: a container is never
   * started for a workspace without hosted runs, nor for someone who can only read.
   */
  async run(job: RunnerJob): Promise<RunOutcome> {
    if (!this.env.TICKET_SECRET) throw new Error("TICKET_SECRET isn't set")
    const workspace = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(job.orgId))
    const verdict = await workspace.mayHostRun(job.mentionId)
    if (!verdict.allowed) return { started: false, reason: verdict.reason }
    if (runnerPrincipal(job).role === "viewer") return { started: false, reason: "read-only" }
    await this.launch(await signTicket(this.env.TICKET_SECRET, runnerPrincipal(job), TICKET_TTL_SECONDS), job)
    return { started: true }
  }

  protected async launch(ticket: string, _job: RunnerJob): Promise<void> {
    const container = this.ctx.container
    if (!container) throw new Error("This Durable Object has no container")
    if (container.running) return
    const image = container.images.Runner
    if (!image) throw new Error("The runner image isn't deployed")
    const outbound = this.outbound(ticket)
    await container.interceptOutboundHttps("*", outbound)
    await container.interceptAllOutboundHttp(outbound)
    container.start({
      image,
      instance: "standard-1",
      enableInternet: false,
      entrypoint: ["/app/run.sh", "agent", "serve", "--once", "--budget", BUDGET_USD, "--max-turns", MAX_TURNS],
      env: {
        STDARTIFACTS_URL: `http://${appHost}`,
        // A placeholder: the runner checks that a key is set, and RunnerOutbound replaces it on the way out.
        ANTHROPIC_API_KEY: "added-by-the-worker",
        // Telemetry and update checks would only be denied.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    })
    await container.setInactivityTimeout(RUN_LIMIT_MS)
  }

  protected outbound(ticket: string): Fetcher {
    return (this.ctx.exports as unknown as RunnerExports).RunnerOutbound({ props: { ticket } })
  }
}

interface RunnerExports {
  readonly RunnerOutbound: (options: { readonly props: RunnerProps }) => Fetcher
}

/** Every request a run's container makes comes through here. See runner-outbound.ts for the rules. */
export class RunnerOutbound extends WorkerEntrypoint<Env, RunnerProps> {
  override async fetch(request: Request): Promise<Response> {
    const route = routeOutbound(request, { ticket: this.ctx.props.ticket, anthropicKey: this.env.ANTHROPIC_API_KEY ?? "" })
    switch (route.to) {
      case "app":
        return handle(route.request, this.env)
      case "anthropic":
        return fetch(route.request)
      case "web":
        console.log(`Agent run read ${new URL(route.request.url).hostname}`)
        return fetch(route.request)
      case "denied":
        console.warn(`Agent run denied: ${route.reason}`)
        return new Response(route.reason, { status: 403 })
    }
  }
}
