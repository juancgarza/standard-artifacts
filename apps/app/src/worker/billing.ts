import { Config, Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import {
  Forbidden,
  Invalid,
  TRIAL_DAYS,
  Unavailable,
  UpgradeRequired,
  type BillingInfo,
  type BillingInterval,
  type BillingRedirect,
  type Plan,
  type Principal,
  type Role,
} from "@standard-artifacts/protocol"
import { Bindings } from "./env"
import {
  billingFromMetadata,
  billingMetadata,
  billingSetup,
  effectiveRole,
  hasLiveSubscription,
  metadataChanged,
  seatsFor,
  stateFromSubscriptions,
  upgradeReason,
  type BillingState,
} from "./plans"
import { membershipRole } from "./session"
import { makeStripe, verifyStripeSignature, type StripeClient, type StripeError } from "./stripe"
import { makeWorkOS, type WorkOSClient, type WorkOSError } from "./workos"

/**
 * Billing: Free and Team plans on Stripe (Standard Artifacts Cloud).
 *
 * - Stripe is the source of truth for who pays. Checkout starts Team (with a
 *   14-day trial and no card the first time); the customer portal handles
 *   cards, invoices, monthly or annual, and cancelling.
 * - The webhook (POST /api/billing/webhook) checks Stripe's signature, then
 *   lists the customer's subscriptions afresh and mirrors the current one into
 *   the WorkOS organization's metadata (`plan`, `seats`, `billingStatus`,
 *   `stripeCustomerId`…; see plans.ts) and the org's WorkspaceCell. Always
 *   writing current state, never applying the event's delta, makes it
 *   idempotent: a retried, duplicated or out-of-order event writes the same thing.
 * - Seats are Owners and Editors. Adding or removing one updates the
 *   subscription's quantity, prorated (`syncSeats`).
 * - Enforcement: on Free limits (Free, past due, paused), inviting or
 *   promoting an Editor or Owner answers UpgradeRequired, and Editors act as
 *   viewers until it's fixed (`effectiveRole`). Nothing is deleted.
 *
 * With no Stripe settings (Solo, dev, self-hosting) `enabled` is false and
 * every method is a no-op: plans come from metadata as before, nothing is gated.
 */

export class Billing extends Context.Service<
  Billing,
  {
    readonly enabled: boolean
    /** The org's plan now: as the webhook last set it in the org's cell, else `fallback` (the session's). */
    readonly livePlan: (orgId: string, fallback: Plan) => Effect.Effect<Plan>
    /** A role under the org's plan: Editors read on Free limits. With billing off, the role as it is. */
    readonly effectiveRole: (role: Role, plan: Plan) => Role
    /** Fails with UpgradeRequired when the org's plan doesn't cover one more person with this role. */
    readonly requireSeat: (orgId: string, role: Role) => Effect.Effect<void, UpgradeRequired | Unavailable>
    /** Bring the subscription's seats in line with the org's Owners and Editors. Never fails: problems are logged. */
    readonly syncSeats: (orgId: string) => Effect.Effect<void>
    readonly info: (p: Principal) => Effect.Effect<BillingInfo, Forbidden | Unavailable>
    /** Stripe Checkout for Team. Owners only (the caller checks). */
    readonly checkout: (p: Principal, interval: BillingInterval, origin: string) => Effect.Effect<BillingRedirect, Invalid | Unavailable>
    /** The customer portal. Owners only (the caller checks). */
    readonly portal: (p: Principal, origin: string) => Effect.Effect<BillingRedirect, Invalid | Unavailable>
    /** POST /api/billing/webhook. */
    readonly webhook: (request: Request) => Effect.Effect<Response>
  }
>()("@standard-artifacts/Billing") {
  static readonly layer = Layer.effect(
    Billing,
    Effect.gen(function* () {
      const text = (name: string) => Config.String(name).pipe(Config.withDefault(""), Config.map((s) => s.trim()))
      const secret = (name: string) => Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")))
      const env = yield* Bindings
      const mode = (yield* Config.String("AUTH_MODE").pipe(Config.withDefault("live"))) === "dev" ? "dev" : "live"
      const secretKey = yield* secret("STRIPE_SECRET_KEY")
      const webhookSecret = Redacted.value(yield* secret("STRIPE_WEBHOOK_SECRET")).trim()
      const prices = { monthly: yield* text("STRIPE_PRICE_MONTHLY"), annual: yield* text("STRIPE_PRICE_ANNUAL") }
      const stripeUrl = (yield* text("STRIPE_API_URL")) || "https://api.stripe.com"
      const workosKey = yield* secret("WORKOS_API_KEY")
      const workosClientId = yield* text("WORKOS_CLIENT_ID")
      const workosUrl = (yield* text("WORKOS_API_URL")) || "https://api.workos.com"

      const setup = billingSetup({
        STRIPE_SECRET_KEY: Redacted.value(secretKey),
        STRIPE_WEBHOOK_SECRET: webhookSecret,
        STRIPE_PRICE_MONTHLY: prices.monthly,
        STRIPE_PRICE_ANNUAL: prices.annual,
        // Dev has no accounts, so no plans to bill.
        WORKOS_API_KEY: mode === "dev" ? "" : Redacted.value(workosKey),
      })
      if (setup.problem) console.error(`Standard Artifacts: ${setup.problem}`)
      const enabled = setup.enabled
      const stripe: StripeClient | undefined = enabled ? makeStripe({ secretKey, apiUrl: stripeUrl }) : undefined
      // Its own client over the same WorkOS code as Accounts: billing only reads and writes org metadata and lists members.
      const wos: WorkOSClient | undefined = enabled ? makeWorkOS({ apiKey: workosKey, clientId: workosClientId, apiUrl: workosUrl }) : undefined

      const cellOf = (orgId: string) => env.WORKSPACE.get(env.WORKSPACE.idFromName(orgId))

      const off = () => new Unavailable({ message: "This server doesn't bill: every workspace works as it always has." })
      const clients = Effect.suspend(() => (stripe && wos ? Effect.succeed({ stripe, wos }) : Effect.fail(off())))

      const fromStripe = (e: StripeError) => {
        console.error(`Stripe: ${e.status} ${e.type} ${e.message}`)
        return e.status === 0 || e.status === 429 || e.status >= 500
          ? new Unavailable({ message: "The billing service didn't answer. Try again in a moment." })
          : new Invalid({ message: "Billing couldn't do that. Try again, or contact support if it keeps happening." })
      }
      const fromWorkOS = (e: WorkOSError) => {
        console.error(`WorkOS: ${e.status} ${e.code} ${e.message}`)
        return new Unavailable({ message: "The account service didn't answer. Try again in a moment." })
      }

      /** The org's billing as WorkOS holds it, and the org (whose raw metadata says what a write would change). */
      const orgBilling = Effect.fn("Billing.orgBilling")(function* (orgId: string) {
        const { wos } = yield* clients
        const org = yield* wos.getOrganization(orgId).pipe(Effect.mapError(fromWorkOS))
        return { org, state: billingFromMetadata(org.metadata) }
      })

      const paidMembers = Effect.fn("Billing.paidMembers")(function* (orgId: string) {
        const { wos } = yield* clients
        const memberships = yield* wos.listMemberships({ organizationId: orgId }).pipe(Effect.mapError(fromWorkOS))
        return memberships.map(membershipRole)
      })

      /**
       * Mirror a state into WorkOS (only what changed), then the org's cell, which tickets and tokens read.
       * `observedAt` is when Stripe was asked: the cell keeps the newest observation, so of two webhooks
       * racing, the one that read Stripe first can't overwrite the other there.
       */
      const record = Effect.fn("Billing.record")(function* (
        orgId: string,
        current: Readonly<Record<string, unknown>> | null | undefined,
        state: BillingState,
        observedAt: number,
      ) {
        const { wos } = yield* clients
        const metadata = billingMetadata(state)
        if (metadataChanged(current, metadata)) yield* wos.updateOrganizationMetadata(orgId, metadata).pipe(Effect.mapError(fromWorkOS))
        yield* Effect.tryPromise({
          try: async () => void (await cellOf(orgId).setBilling(state.plan, state.status, observedAt)),
          catch: (e) => new Unavailable({ message: `Couldn't update the workspace's plan: ${String(e)}` }),
        })
      })

      // --- Reads -------------------------------------------------------------------------------

      const livePlan: Billing["Service"]["livePlan"] = (orgId, fallback) =>
        enabled
          ? Effect.tryPromise(async () => (await cellOf(orgId).billing())?.plan ?? fallback).pipe(
              Effect.orElseSucceed(() => fallback),
              Effect.withSpan("Billing.livePlan"),
            )
          : Effect.succeed(fallback)

      const info: Billing["Service"]["info"] = Effect.fn("Billing.info")(function* (p) {
        if (p.actor.type === "guest") return yield* new Forbidden({ message: "Guests can't see the workspace's billing." })
        if (!enabled) {
          return { enabled: false, plan: p.plan, status: "none", interval: null, seats: 0, paidMembers: 0, trialEndsAt: null, trialAvailable: false, canManage: false } as const
        }
        const [{ state }, roles] = yield* Effect.all([orgBilling(p.orgId), paidMembers(p.orgId)], { concurrency: 2 })
        return {
          enabled: true,
          plan: state.plan,
          status: state.status,
          interval: state.interval,
          seats: state.seats,
          paidMembers: roles.filter((r) => r !== "viewer").length,
          trialEndsAt: state.trialEndsAt,
          // Once per workspace: "none" means it has never had a subscription (a lapsed one reads as paused or canceled).
          trialAvailable: state.status === "none",
          canManage: p.actor.type === "user" && p.role === "owner",
        } satisfies BillingInfo
      })

      // --- Enforcement ---------------------------------------------------------------------------

      const requireSeat: Billing["Service"]["requireSeat"] = Effect.fn("Billing.requireSeat")(function* (orgId, role) {
        if (!enabled || role === "viewer") return
        const { state } = yield* orgBilling(orgId)
        const reason = upgradeReason(role, state, enabled)
        if (reason) return yield* new UpgradeRequired({ message: reason })
      })

      const syncSeats: Billing["Service"]["syncSeats"] = (orgId) =>
        Effect.gen(function* () {
          if (!enabled) return
          const { stripe } = yield* clients
          const { state } = yield* orgBilling(orgId)
          if (!state.subscriptionId || !hasLiveSubscription(state.status)) return
          const want = seatsFor(yield* paidMembers(orgId))
          if (want === state.seats) return
          const sub = yield* stripe.getSubscription(state.subscriptionId).pipe(Effect.mapError(fromStripe))
          const item = sub.items.data[0]
          if (!item || item.quantity === want) return
          // The webhook (customer.subscription.updated) mirrors the new quantity into metadata.
          yield* stripe.setQuantity(item.id, want).pipe(Effect.mapError(fromStripe))
        }).pipe(
          Effect.catch((e) => Effect.sync(() => console.error(`Billing: couldn't sync seats for ${orgId}: ${e.message}`))),
          Effect.withSpan("Billing.syncSeats"),
        )

      // --- Checkout and the portal -------------------------------------------------------------------

      /** The org's Stripe customer, made on first use and remembered in WorkOS right away (so a second click reuses it). */
      const customerFor = Effect.fn("Billing.customerFor")(function* (p: Principal) {
        const { stripe, wos } = yield* clients
        const { org, state } = yield* orgBilling(p.orgId)
        if (state.customerId) return { customerId: state.customerId, state }
        const customer = yield* stripe.createCustomer({ orgId: p.orgId, name: org.name }).pipe(Effect.mapError(fromStripe))
        yield* wos.updateOrganizationMetadata(p.orgId, { stripeCustomerId: customer.id }).pipe(Effect.mapError(fromWorkOS))
        return { customerId: customer.id, state }
      })

      const checkout: Billing["Service"]["checkout"] = Effect.fn("Billing.checkout")(function* (p, interval, origin) {
        const { stripe } = yield* clients
        const { customerId, state } = yield* customerFor(p)
        if (state.status === "trialing" || state.status === "active" || state.status === "past_due") {
          return yield* new Invalid({ message: "This workspace already has Team. Open Manage billing to change it." })
        }
        // The trial comes with a workspace's first subscription only (an abandoned Checkout doesn't use it up).
        const trial = (yield* stripe.listSubscriptions(customerId).pipe(Effect.mapError(fromStripe))).length === 0
        const quantity = seatsFor(yield* paidMembers(p.orgId))
        const session = yield* stripe
          .createCheckoutSession({
            mode: "subscription",
            customer: customerId,
            client_reference_id: p.orgId,
            line_items: [{ price: interval === "year" ? prices.annual : prices.monthly, quantity }],
            subscription_data: {
              metadata: { orgId: p.orgId },
              // No card needed for the trial; without one by the end, it pauses (Free limits, nothing deleted).
              ...(trial && { trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: "pause" } } }),
            },
            payment_method_collection: trial ? "if_required" : "always",
            success_url: `${origin}/settings/billing?checkout=done`,
            cancel_url: `${origin}/settings/billing`,
          })
          .pipe(Effect.mapError(fromStripe))
        if (!session.url) return yield* new Unavailable({ message: "Stripe didn't return a Checkout page. Try again." })
        return { url: session.url }
      })

      /** The portal configuration scripts/stripe-setup.mjs made (metadata app=standard-artifacts), else Stripe's default. */
      const portalConfiguration = yield* Effect.cachedWithTTL(
        Effect.suspend(() =>
          stripe
            ? stripe.listPortalConfigurations().pipe(
                Effect.map((all) => all.find((c) => c.active && c.metadata?.app === "standard-artifacts")?.id),
                Effect.orElseSucceed(() => undefined),
              )
            : Effect.succeed(undefined),
        ),
        Duration.minutes(10),
      )

      const portal: Billing["Service"]["portal"] = Effect.fn("Billing.portal")(function* (p, origin) {
        const { stripe } = yield* clients
        const { state } = yield* orgBilling(p.orgId)
        if (!state.customerId) return yield* new Invalid({ message: "This workspace has no billing yet. Upgrade to Team first." })
        const session = yield* stripe
          .createPortalSession({ customer: state.customerId, returnUrl: `${origin}/settings/billing`, configuration: yield* portalConfiguration })
          .pipe(Effect.mapError(fromStripe))
        if (!session.url) return yield* new Unavailable({ message: "Stripe didn't return a billing page. Try again." })
        return { url: session.url }
      })

      // --- Webhook -------------------------------------------------------------------------------

      /**
       * Bring an org's billing in line with its Stripe customer. `checkoutSubscription`: a Checkout just
       * finished with this subscription, so older paused or unpaid ones (a lapsed trial) are cancelled,
       * leaving one subscription per org.
       */
      const reconcile = Effect.fn("Billing.reconcile")(function* (customerId: string, checkoutSubscription: string | undefined) {
        const { stripe, wos } = yield* clients
        const customer = yield* stripe.getCustomer(customerId).pipe(Effect.mapError(fromStripe))
        const orgId = customer.metadata?.orgId
        if (customer.deleted || !orgId) {
          console.warn(`Billing: Stripe customer ${customerId} has no org; ignoring its event`)
          return "ignored" as const
        }
        const org = yield* wos.getOrganization(orgId).pipe(
          Effect.map((o) => o as typeof o | undefined),
          Effect.catchTag("WorkOSError", (e) => (e.status === 404 ? Effect.succeed(undefined) : Effect.fail(fromWorkOS(e)))),
        )
        if (!org) {
          console.warn(`Billing: org ${orgId} (Stripe customer ${customerId}) doesn't exist; ignoring its event`)
          return "ignored" as const
        }
        const known = billingFromMetadata(org.metadata).customerId
        if (known && known !== customerId) {
          console.warn(`Billing: org ${orgId} bills through ${known}, not ${customerId}; ignoring its event`)
          return "ignored" as const
        }
        let observedAt = Date.now()
        let subscriptions = yield* stripe.listSubscriptions(customerId).pipe(Effect.mapError(fromStripe))
        if (checkoutSubscription) {
          const stale = subscriptions.filter((s) => s.id !== checkoutSubscription && ["paused", "unpaid", "past_due", "incomplete"].includes(s.status))
          if (stale.length) {
            yield* Effect.forEach(stale, (s) => stripe.cancelSubscription(s.id).pipe(Effect.mapError(fromStripe)), { concurrency: 2, discard: true })
            observedAt = Date.now()
            subscriptions = yield* stripe.listSubscriptions(customerId).pipe(Effect.mapError(fromStripe))
          }
        }
        yield* record(orgId, org.metadata, stateFromSubscriptions(customerId, subscriptions, prices), observedAt)
        return "synced" as const
      })

      const webhook: Billing["Service"]["webhook"] = (request) =>
        Effect.gen(function* () {
          if (!enabled) return Response.json({ error: "Billing is off on this server." }, { status: 404 })
          const body = yield* Effect.promise(() => request.text())
          const check = yield* Effect.promise(() => verifyStripeSignature(body, request.headers.get("stripe-signature"), webhookSecret))
          if (check !== "valid") return Response.json({ error: `Signature ${check}` }, { status: 400 })
          const event = decodeEvent(body)
          if (!event) return Response.json({ error: "Not a Stripe event" }, { status: 400 })
          if (!HANDLED.has(event.type)) return Response.json({ received: true, ignored: event.type })
          const object = event.data.object
          const customerId = typeof object.customer === "string" ? object.customer : undefined
          if (!customerId) return Response.json({ received: true, ignored: "no customer" })
          const checkoutSubscription =
            event.type === "checkout.session.completed" && typeof object.subscription === "string" ? object.subscription : undefined
          const outcome = yield* reconcile(customerId, checkoutSubscription)
          return Response.json({ received: true, [outcome]: event.type })
        }).pipe(
          // Anything that went wrong after the signature checked out: 500, so Stripe retries (it does for 3 days).
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              console.error("Billing webhook failed:", cause)
              return Response.json({ error: "Couldn't process the event. Stripe will retry." }, { status: 500 })
            }),
          ),
          Effect.withSpan("Billing.webhook"),
        )

      return Billing.of({
        enabled,
        livePlan,
        effectiveRole: (role, plan) => effectiveRole(role, plan, enabled),
        requireSeat,
        syncSeats,
        info,
        checkout,
        portal,
        webhook,
      })
    }),
  )
}

/** Events that can change an org's billing. Each one re-reads the customer's subscriptions, so the list can be generous. */
export const HANDLED: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
])

const WebhookEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  data: Schema.Struct({ object: Schema.Record(Schema.String, Schema.Unknown) }),
})
const decodeEventResult = Schema.decodeUnknownOption(Schema.fromJsonString(WebhookEvent))
const decodeEvent = (body: string) => {
  const o = decodeEventResult(body)
  return o._tag === "Some" ? o.value : undefined
}
