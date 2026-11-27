import type { BillingInterval, BillingStatus, Plan, Role } from "@standard-artifacts/protocol"
import type { StripeSubscription } from "./stripe"

/**
 * Plans and billing rules that don't talk to anything: what a Stripe
 * subscription means for an org, how that's kept in WorkOS organization
 * metadata, and what Free limits do to a role. Only type imports, so tests
 * load this file directly.
 *
 * - Free: one human edits (the owner), plus unlimited agents and read-only share links.
 * - Team: billed per seat, where a seat is an Owner or an Editor. Viewers, agents and access tokens are free.
 * - Only `trialing` and `active` are Team. Past due and paused fall back to Free limits until they're fixed;
 *   Editors become read-only and nothing is deleted.
 *
 * Billing is on only with Stripe configured (Cloud). Without it, every rule here is a no-op and an org's plan
 * is whatever its metadata `plan` says, as before billing existed.
 */

// --- Configuration ---------------------------------------------------------------------------

export interface BillingConfig {
  readonly STRIPE_SECRET_KEY?: string | undefined
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined
  readonly STRIPE_PRICE_MONTHLY?: string | undefined
  readonly STRIPE_PRICE_ANNUAL?: string | undefined
  /** WorkOS holds the plan, so billing needs it too. */
  readonly WORKOS_API_KEY?: string | undefined
}

const STRIPE_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_ANNUAL"] as const

/**
 * Whether billing is on, and why not when it's half set up. None of the Stripe
 * settings: off, quietly (Solo, dev, self-hosting). Some but not all, or no
 * WorkOS: off, with a problem to log, so a typo never bills anyone by surprise.
 */
export function billingSetup(config: BillingConfig): { readonly enabled: boolean; readonly problem: string | undefined } {
  const set = STRIPE_KEYS.filter((k) => config[k]?.trim())
  if (set.length === 0) return { enabled: false, problem: undefined }
  const missing = STRIPE_KEYS.filter((k) => !config[k]?.trim())
  if (missing.length) return { enabled: false, problem: `Billing is off: set ${missing.join(", ")} too, or none of the Stripe settings.` }
  if (!config.WORKOS_API_KEY?.trim()) return { enabled: false, problem: "Billing is off: it keeps each workspace's plan in WorkOS, so it needs sign-in (WORKOS_API_KEY) too." }
  return { enabled: true, problem: undefined }
}

// --- Billing state ---------------------------------------------------------------------------

/** An org's billing, as mirrored into WorkOS organization metadata. */
export interface BillingState {
  readonly plan: Plan
  readonly status: BillingStatus
  /** Seats the subscription bills for (0 without one). */
  readonly seats: number
  readonly interval: BillingInterval | null
  /** ISO, while trialing. */
  readonly trialEndsAt: string | null
  readonly customerId: string | null
  readonly subscriptionId: string | null
}

export const NO_BILLING: BillingState = { plan: "free", status: "none", seats: 0, interval: null, trialEndsAt: null, customerId: null, subscriptionId: null }

/** Stripe's subscription status, in our terms. Unpaid is past due that Stripe stopped retrying; both mean "fix the card". */
export function statusOf(stripeStatus: string): BillingStatus {
  switch (stripeStatus) {
    case "trialing":
    case "active":
    case "past_due":
    case "paused":
    case "canceled":
    case "incomplete":
      return stripeStatus
    case "unpaid":
      return "past_due"
    case "incomplete_expired":
      return "canceled"
    default:
      return "none"
  }
}

/** Only these are Team. */
export const isTeamStatus = (s: BillingStatus) => s === "trialing" || s === "active"

/** A subscription that still exists in Stripe's eyes: seats are kept in step with members. */
export const hasLiveSubscription = (s: BillingStatus) => s === "trialing" || s === "active" || s === "past_due" || s === "paused"

/** Which subscription speaks for the org when a customer has several (an old paused one and a new active one). */
const rank: Record<BillingStatus, number> = { active: 6, trialing: 5, past_due: 4, paused: 3, incomplete: 2, canceled: 1, none: 0 }

export function currentSubscription(subscriptions: ReadonlyArray<StripeSubscription>): StripeSubscription | undefined {
  let best: StripeSubscription | undefined
  for (const s of subscriptions) {
    if (!best) best = s
    else {
      const a = rank[statusOf(s.status)]
      const b = rank[statusOf(best.status)]
      if (a > b || (a === b && s.created > best.created)) best = s
    }
  }
  return best
}

/**
 * What a customer's subscriptions mean for the org. Called with every
 * subscription the customer has, freshly listed, so the answer doesn't depend
 * on which webhook arrived first or how often.
 */
export function stateFromSubscriptions(
  customerId: string,
  subscriptions: ReadonlyArray<StripeSubscription>,
  prices: { readonly monthly: string; readonly annual: string },
): BillingState {
  const sub = currentSubscription(subscriptions)
  if (!sub) return { ...NO_BILLING, customerId }
  const status = statusOf(sub.status)
  // Over: Free, nothing billed. The customer stays, for the next Checkout and the invoice history.
  if (status === "canceled" || status === "none") return { ...NO_BILLING, status, customerId }
  const item = sub.items.data.find((i) => i.price.id === prices.monthly || i.price.id === prices.annual) ?? sub.items.data[0]
  const interval: BillingInterval | null =
    item?.price.id === prices.annual ? "year" : item?.price.id === prices.monthly ? "month" : item?.price.recurring?.interval === "year" ? "year" : item?.price.recurring?.interval === "month" ? "month" : null
  return {
    plan: isTeamStatus(status) ? "team" : "free",
    status,
    seats: Math.max(0, Math.trunc(item?.quantity ?? 0)),
    interval,
    trialEndsAt: status === "trialing" && sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    customerId,
    subscriptionId: sub.id,
  }
}

// --- WorkOS organization metadata --------------------------------------------------------------

/**
 * The metadata keys billing owns. WorkOS allows 10 pairs per org, keys up to 40
 * ASCII characters and values up to 600, all strings; these are 7 short ones.
 * A null value deletes the key (WorkOS updates are partial), so keys nobody
 * else writes are left alone.
 */
export const BILLING_KEYS = ["plan", "seats", "billingStatus", "billingInterval", "trialEndsAt", "stripeCustomerId", "stripeSubscriptionId"] as const

export type BillingMetadata = { readonly [K in (typeof BILLING_KEYS)[number]]: string | null }

export function billingMetadata(state: BillingState): BillingMetadata {
  return {
    plan: state.plan,
    seats: String(state.seats),
    billingStatus: state.status,
    billingInterval: state.interval,
    trialEndsAt: state.trialEndsAt,
    stripeCustomerId: state.customerId,
    stripeSubscriptionId: state.subscriptionId,
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null)

/**
 * The org's plan from metadata `plan`: "team" or, by default, "free". A
 * self-hoster (or support, comping an org) can set it by hand; billing writes
 * it from Stripe.
 */
export const planOf = (metadata: Readonly<Record<string, unknown>> | null | undefined): Plan => (metadata?.plan === "team" ? "team" : "free")

/** Billing as WorkOS last heard it. Anything unreadable reads as no billing. */
export function billingFromMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined): BillingState {
  const status = statusOf(str(metadata?.billingStatus) ?? "")
  const interval = metadata?.billingInterval === "year" ? "year" : metadata?.billingInterval === "month" ? "month" : null
  const seats = Number(metadata?.seats)
  return {
    plan: planOf(metadata),
    status,
    seats: Number.isFinite(seats) && seats > 0 ? Math.trunc(seats) : 0,
    interval,
    trialEndsAt: str(metadata?.trialEndsAt),
    customerId: str(metadata?.stripeCustomerId),
    subscriptionId: str(metadata?.stripeSubscriptionId),
  }
}

/** Whether writing `next` would change anything WorkOS holds. */
export function metadataChanged(current: Readonly<Record<string, unknown>> | null | undefined, next: BillingMetadata): boolean {
  return BILLING_KEYS.some((k) => (str(current?.[k]) ?? null) !== next[k])
}

// --- Enforcement -----------------------------------------------------------------------------------

/** Owners and Editors take a seat. Viewers don't, and neither do agents or tokens (they act as a person). */
export const isPaidRole = (role: Role) => role !== "viewer"

/**
 * A person's role under the org's plan. On Free limits (Free, or Team that's
 * past due or paused) only owners edit: an Editor reads, until the workspace
 * upgrades or billing is fixed. Their role itself doesn't change, so it comes
 * back on its own. With billing off, roles are as they are.
 */
export function effectiveRole(role: Role, plan: Plan, billingEnabled: boolean): Role {
  return billingEnabled && plan === "free" && role === "editor" ? "viewer" : role
}

/**
 * Why adding someone with `role` needs an upgrade first, or undefined when it
 * doesn't. Viewers are always free; with billing off nothing is gated.
 */
export function upgradeReason(role: Role, state: BillingState, billingEnabled: boolean): string | undefined {
  if (!billingEnabled || !isPaidRole(role) || state.plan === "team") return undefined
  const who = role === "owner" ? "Owners" : "Editors"
  switch (state.status) {
    case "past_due":
      return `Billing for this workspace is past due. Update the payment method in Settings → Billing to add ${who.toLowerCase()}. Viewers are free.`
    case "paused":
      return `The Team trial ended without a payment method, so the workspace is on Free limits. Add one in Settings → Billing to add ${who.toLowerCase()}. Viewers are free.`
    default:
      return `On Free, only you edit. ${who} take a seat on Team: upgrade in Settings → Billing. Viewers are free.`
  }
}

/** Seats to bill: every Owner and Editor, and never fewer than one. */
export const seatsFor = (roles: ReadonlyArray<Role>) => Math.max(1, roles.filter(isPaidRole).length)

// --- Hosted agent runs -----------------------------------------------------------------------------

/** Hosted `@claude` runs a workspace gets during its Team trial, in all. After that, Team needs a payment method. */
export const TRIAL_HOSTED_RUNS = 25

/**
 * How old a waiting request may be and still start a hosted run when a workspace gets them (an upgrade, a payment
 * that went through). Older ones expire instead: a months-old @claude shouldn't wake up and edit someone's docs.
 */
export const WAITING_MENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** What an expired request says. */
export const expiredMentionMessage = () =>
  `Expired: this request waited more than ${Math.round(WAITING_MENTION_MAX_AGE_MS / 3_600_000)} hours without an agent taking it. Ask again.`

export type HostedRunsRefusal = "plan" | "trial-limit"

/** Whether the hosted runner may start a run for the org. `trial`: each new run uses up the trial's allowance. */
export type HostedRuns = { readonly allowed: true; readonly trial: boolean } | { readonly allowed: false; readonly reason: HostedRunsRefusal }

/**
 * Hosted runs are for paying workspaces. With billing on: Team that's active,
 * or trialing with allowance left (TRIAL_HOSTED_RUNS in all). Free, past due,
 * paused and canceled get none. An org with no billing yet but on Team (set by
 * hand, a comp) counts as active. With billing off, every workspace gets them,
 * as before. A refused mention is still filed: the person's own agent
 * (`stdartifacts agent serve`, or MCP) can take it.
 */
export function hostedRuns(input: {
  readonly billingEnabled: boolean
  /** The org's billing status as the webhook last set it, or null if it never has. */
  readonly status: BillingStatus | null
  /** The org's plan (used when there's no billing status: Team by hand). */
  readonly plan: Plan | null
  readonly trialRunsUsed: number
}): HostedRuns {
  if (!input.billingEnabled) return { allowed: true, trial: false }
  const status = input.status ?? (input.plan === "team" ? "active" : "none")
  if (status === "active") return { allowed: true, trial: false }
  if (status === "trialing") return input.trialRunsUsed < TRIAL_HOSTED_RUNS ? { allowed: true, trial: true } : { allowed: false, reason: "trial-limit" }
  return { allowed: false, reason: "plan" }
}

/** What a person sees on a request the hosted runner won't take. */
export function hostedRunsMessage(reason: HostedRunsRefusal): string {
  return reason === "trial-limit"
    ? `This trial's ${TRIAL_HOSTED_RUNS} hosted runs are used up. Add a payment method in Settings → Billing to keep them, or run your own agent: stdartifacts agent serve`
    : "Hosted runs are part of Team. Upgrade in Settings → Billing, or run your own agent: stdartifacts agent serve"
}

/**
 * The role a hosted run acts with for the person who asked: their role under
 * the org's plan now (an Editor on Free limits reads), and never above editor.
 */
export function runnerRole(requesterRole: Role, plan: Plan, billingEnabled: boolean): Role {
  const role = effectiveRole(requesterRole, plan, billingEnabled)
  return role === "owner" ? "editor" : role
}

/** Whether billing is on for a Worker's raw env (cells read env, not Config). Dev mode never bills. */
export const billingOn = (env: BillingConfig & { readonly AUTH_MODE?: string | undefined }) => env.AUTH_MODE !== "dev" && billingSetup(env).enabled
