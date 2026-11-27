import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { describe, test } from "node:test"
import {
  BILLING_KEYS,
  NO_BILLING,
  billingFromMetadata,
  billingMetadata,
  billingSetup,
  currentSubscription,
  TRIAL_HOSTED_RUNS,
  billingOn,
  effectiveRole,
  hostedRuns,
  hostedRunsMessage,
  metadataChanged,
  planOf,
  runnerRole,
  seatsFor,
  stateFromSubscriptions,
  statusOf,
  upgradeReason,
  type BillingState,
} from "../../apps/app/src/worker/plans.ts"
import { constantTimeEqual, formEncode, signStripePayload, verifyStripeSignature, type StripeSubscription } from "../../apps/app/src/worker/stripe.ts"

/** Billing's pure parts (no server, no Stripe): webhook signatures, what a subscription means, and the rules on Free. */

const SECRET = "whsec_test_secret"
const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", data: { object: { customer: "cus_1" } } })
/** Signed the way Stripe documents it, with Node's crypto rather than ours. */
const sign = (payload: string, t: number, secret = SECRET) => createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")
const now = 1_800_000_000

describe("webhook signatures", () => {
  test("a good signature is valid, and matches what Stripe's own scheme computes", async () => {
    assert.equal(await verifyStripeSignature(body, `t=${now},v1=${sign(body, now)}`, SECRET, { nowS: now }), "valid")
    assert.equal(await signStripePayload(body, SECRET, now), `t=${now},v1=${sign(body, now)}`)
    assert.equal(await verifyStripeSignature(body, await signStripePayload(body, SECRET), SECRET), "valid")
  })

  test("a bad signature is invalid: wrong secret, changed body, changed timestamp", async () => {
    assert.equal(await verifyStripeSignature(body, `t=${now},v1=${sign(body, now, "whsec_other")}`, SECRET, { nowS: now }), "invalid")
    assert.equal(await verifyStripeSignature(`${body} `, `t=${now},v1=${sign(body, now)}`, SECRET, { nowS: now }), "invalid")
    assert.equal(await verifyStripeSignature(body, `t=${now + 1},v1=${sign(body, now)}`, SECRET, { nowS: now }), "invalid")
    assert.equal(await verifyStripeSignature(body, `t=${now},v1=${"0".repeat(64)}`, SECRET, { nowS: now }), "invalid")
  })

  test("a stale signature is refused even though it matches: older or newer than the tolerance", async () => {
    const old = now - 301
    assert.equal(await verifyStripeSignature(body, `t=${old},v1=${sign(body, old)}`, SECRET, { nowS: now }), "stale")
    const future = now + 301
    assert.equal(await verifyStripeSignature(body, `t=${future},v1=${sign(body, future)}`, SECRET, { nowS: now }), "stale")
    const edge = now - 300
    assert.equal(await verifyStripeSignature(body, `t=${edge},v1=${sign(body, edge)}`, SECRET, { nowS: now }), "valid")
    assert.equal(await verifyStripeSignature(body, `t=${old},v1=${sign(body, old)}`, SECRET, { nowS: now, toleranceS: 600 }), "valid")
  })

  test("any of several v1 signatures may match (a secret being rolled); v0 is ignored", async () => {
    const good = sign(body, now)
    const other = sign(body, now, "whsec_old")
    assert.equal(await verifyStripeSignature(body, `t=${now},v1=${other},v1=${good}`, SECRET, { nowS: now }), "valid")
    assert.equal(await verifyStripeSignature(body, `t=${now},v1=${good},v1=${other}`, SECRET, { nowS: now }), "valid")
    assert.equal(await verifyStripeSignature(body, `t=${now},v0=${good}`, SECRET, { nowS: now }), "missing", "v0 alone doesn't count")
    assert.equal(await verifyStripeSignature(body, `t=${now}, v1=${good.toUpperCase()}`, SECRET, { nowS: now }), "valid", "spaces and case")
  })

  test("a missing or malformed header, or no secret, is refused", async () => {
    for (const header of [undefined, null, "", "garbage", `v1=${sign(body, now)}`, `t=${now}`, `t=abc,v1=${sign(body, now)}`, `t=${now},v1=nothex`]) {
      assert.equal(await verifyStripeSignature(body, header, SECRET, { nowS: now }), "missing", String(header))
    }
    assert.equal(await verifyStripeSignature(body, `t=${now},v1=${sign(body, now)}`, "", { nowS: now }), "missing")
  })

  test("constant-time comparison still compares", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true)
    assert.equal(constantTimeEqual("abc", "abd"), false)
    assert.equal(constantTimeEqual("abc", "abcd"), false)
    assert.equal(constantTimeEqual("", ""), true)
  })
})

describe("form encoding", () => {
  test("nested objects and arrays become Stripe's bracket keys; undefined is left out", () => {
    const encoded = formEncode({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 3 }],
      subscription_data: { trial_period_days: 14, trial_settings: { end_behavior: { missing_payment_method: "pause" } }, skip: undefined },
      flag: true,
    })
    assert.deepEqual(Object.fromEntries(new URLSearchParams(encoded)), {
      mode: "subscription",
      "line_items[0][price]": "price_1",
      "line_items[0][quantity]": "3",
      "subscription_data[trial_period_days]": "14",
      "subscription_data[trial_settings][end_behavior][missing_payment_method]": "pause",
      flag: "true",
    })
  })
})

const prices = { monthly: "price_m", annual: "price_y" }
const sub = (o: Partial<StripeSubscription> & { quantity?: number; price?: string } = {}): StripeSubscription => ({
  id: o.id ?? "sub_1",
  customer: "cus_1",
  status: o.status ?? "active",
  created: o.created ?? 100,
  trial_end: o.trial_end ?? null,
  items: { data: [{ id: "si_1", quantity: o.quantity ?? 3, price: { id: o.price ?? "price_m", recurring: { interval: o.price === "price_y" ? "year" : "month" } } }] },
})

describe("a Stripe subscription as a plan", () => {
  test("trialing and active are Team; the trial's end, seats and period come along", () => {
    const trial = stateFromSubscriptions("cus_1", [sub({ status: "trialing", trial_end: 1_800_000_000, quantity: 2, price: "price_y" })], prices)
    assert.deepEqual(trial, {
      plan: "team",
      status: "trialing",
      seats: 2,
      interval: "year",
      trialEndsAt: new Date(1_800_000_000_000).toISOString(),
      customerId: "cus_1",
      subscriptionId: "sub_1",
    })
    const active = stateFromSubscriptions("cus_1", [sub({ status: "active", quantity: 5 })], prices)
    assert.equal(active.plan, "team")
    assert.equal(active.status, "active")
    assert.equal(active.seats, 5)
    assert.equal(active.interval, "month")
    assert.equal(active.trialEndsAt, null)
  })

  test("past due, unpaid and paused fall back to Free limits but keep the subscription", () => {
    for (const [stripe, ours] of [["past_due", "past_due"], ["unpaid", "past_due"], ["paused", "paused"]] as const) {
      const s = stateFromSubscriptions("cus_1", [sub({ status: stripe })], prices)
      assert.equal(s.plan, "free", stripe)
      assert.equal(s.status, ours, stripe)
      assert.equal(s.subscriptionId, "sub_1", stripe)
      assert.equal(s.seats, 3, stripe)
    }
  })

  test("canceled, expired or no subscription is Free with nothing billed, and the customer is kept", () => {
    for (const status of ["canceled", "incomplete_expired"]) {
      assert.deepEqual(stateFromSubscriptions("cus_1", [sub({ status })], prices), { ...NO_BILLING, status: "canceled", customerId: "cus_1" })
    }
    assert.deepEqual(stateFromSubscriptions("cus_1", [], prices), { ...NO_BILLING, customerId: "cus_1" })
    assert.equal(stateFromSubscriptions("cus_1", [sub({ status: "incomplete" })], prices).plan, "free")
  })

  test("with several, the one that counts is the best standing, then the newest", () => {
    const paused = sub({ id: "sub_old", status: "paused", created: 1 })
    const active = sub({ id: "sub_new", status: "active", created: 2 })
    assert.equal(currentSubscription([paused, active])?.id, "sub_new")
    assert.equal(currentSubscription([active, paused])?.id, "sub_new", "order doesn't matter")
    assert.equal(currentSubscription([sub({ id: "a", status: "canceled", created: 1 }), sub({ id: "b", status: "canceled", created: 5 })])?.id, "b")
    assert.equal(stateFromSubscriptions("cus_1", [paused, active], prices).plan, "team")
  })

  test("Stripe statuses we don't know read as none", () => {
    assert.equal(statusOf("something_new"), "none")
    assert.equal(statusOf("trialing"), "trialing")
  })
})

describe("WorkOS metadata", () => {
  const state: BillingState = { plan: "team", status: "trialing", seats: 4, interval: "year", trialEndsAt: "2026-12-11T00:00:00.000Z", customerId: "cus_ABC", subscriptionId: "sub_ABC" }

  test("billing's keys fit WorkOS's limits: at most 10 pairs, keys up to 40 ASCII characters, string values up to 600", () => {
    const m = billingMetadata(state)
    assert.deepEqual(Object.keys(m).sort(), [...BILLING_KEYS].sort())
    assert.ok(Object.keys(m).length <= 10)
    for (const [k, v] of Object.entries(m)) {
      assert.ok(k.length <= 40 && /^[\x20-\x7e]+$/.test(k), k)
      assert.ok(v === null || (typeof v === "string" && v.length <= 600 && /^[\x20-\x7e]*$/.test(v)), `${k}=${v}`)
    }
    assert.equal(m.plan, "team")
    assert.equal(m.seats, "4")
    assert.equal(m.billingStatus, "trialing")
    assert.equal(m.stripeCustomerId, "cus_ABC")
  })

  test("round-trips, and a cleared field is a null (which deletes the key)", () => {
    assert.deepEqual(billingFromMetadata(billingMetadata(state)), state)
    const free = billingMetadata({ ...NO_BILLING, customerId: "cus_ABC" })
    assert.equal(free.stripeSubscriptionId, null)
    assert.equal(free.trialEndsAt, null)
    assert.deepEqual(billingFromMetadata({ ...free, unrelated: "kept" }), { ...NO_BILLING, customerId: "cus_ABC" })
  })

  test("only a change is a change", () => {
    const m = billingMetadata(state)
    assert.equal(metadataChanged({ ...m, other: "x" }, m), false)
    assert.equal(metadataChanged({ ...m, seats: "5" }, m), true)
    assert.equal(metadataChanged({}, billingMetadata(NO_BILLING)), true, "plan, seats and status get written")
  })

  test("an org's plan is its `plan` key, free by default; junk reads as no billing", () => {
    assert.equal(planOf({ plan: "team" }), "team")
    assert.equal(planOf({ plan: "enterprise" }), "free")
    assert.equal(planOf(null), "free")
    assert.deepEqual(billingFromMetadata({ seats: "lots", billingStatus: 7, billingInterval: "week" }), NO_BILLING)
  })
})

describe("billing off (no Stripe settings)", () => {
  test("none of the settings: off and quiet. Some: off, saying what's missing. All, with WorkOS: on", () => {
    assert.deepEqual(billingSetup({}), { enabled: false, problem: undefined })
    assert.deepEqual(billingSetup({ WORKOS_API_KEY: "sk_x", STRIPE_SECRET_KEY: " " }), { enabled: false, problem: undefined })
    const partial = billingSetup({ STRIPE_SECRET_KEY: "sk_test_x", WORKOS_API_KEY: "sk_x" })
    assert.equal(partial.enabled, false)
    assert.match(partial.problem!, /STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL/)
    const all = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_ANNUAL: "price_y" }
    assert.equal(billingSetup(all).enabled, false, "no WorkOS, nowhere to keep plans")
    assert.match(billingSetup(all).problem!, /WORKOS_API_KEY/)
    assert.deepEqual(billingSetup({ ...all, WORKOS_API_KEY: "sk_x" }), { enabled: true, problem: undefined })
  })

  test("with billing off, roles are as they are and nothing is gated, whatever the plan", () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      assert.equal(effectiveRole(role, "free", false), role)
      assert.equal(upgradeReason(role, NO_BILLING, false), undefined)
      assert.equal(upgradeReason(role, { ...NO_BILLING, status: "paused" }, false), undefined)
    }
  })
})

describe("Free limits", () => {
  test("on Free an Editor reads; owners and viewers are unchanged; on Team everyone keeps their role", () => {
    assert.equal(effectiveRole("editor", "free", true), "viewer")
    assert.equal(effectiveRole("owner", "free", true), "owner")
    assert.equal(effectiveRole("viewer", "free", true), "viewer")
    for (const role of ["owner", "editor", "viewer"] as const) assert.equal(effectiveRole(role, "team", true), role)
  })

  test("seats are Owners and Editors, at least one", () => {
    assert.equal(seatsFor(["owner", "editor", "viewer", "viewer"]), 2)
    assert.equal(seatsFor(["viewer"]), 1)
    assert.equal(seatsFor([]), 1)
  })
})

describe("the invite gate", () => {
  const team: BillingState = { ...NO_BILLING, plan: "team", status: "active", seats: 2, customerId: "cus_1", subscriptionId: "sub_1" }

  test("on Free, an Editor or Owner needs an upgrade; a Viewer never does", () => {
    assert.match(upgradeReason("editor", NO_BILLING, true)!, /Editors take a seat on Team/)
    assert.match(upgradeReason("owner", NO_BILLING, true)!, /Owners take a seat on Team/)
    assert.equal(upgradeReason("viewer", NO_BILLING, true), undefined)
    assert.match(upgradeReason("editor", NO_BILLING, true)!, /Viewers are free/)
  })

  test("on Team (trial included) anyone can be added", () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      assert.equal(upgradeReason(role, team, true), undefined)
      assert.equal(upgradeReason(role, { ...team, status: "trialing" }, true), undefined)
    }
  })

  test("past due or paused says what to fix", () => {
    assert.match(upgradeReason("editor", { ...team, plan: "free", status: "past_due" }, true)!, /past due/)
    assert.match(upgradeReason("editor", { ...team, plan: "free", status: "paused" }, true)!, /trial ended without a payment method/)
  })

  test("an org comped to Team by hand (plan=team, no subscription) isn't gated", () => {
    assert.equal(upgradeReason("editor", billingFromMetadata({ plan: "team" }), true), undefined)
  })
})

describe("hosted runs", () => {
  const on = (status: Parameters<typeof hostedRuns>[0]["status"], trialRunsUsed = 0, plan: "free" | "team" | null = null) =>
    hostedRuns({ billingEnabled: true, status, plan, trialRunsUsed })

  test("entitled: Team that's active, or trialing with runs left", () => {
    assert.deepEqual(on("active"), { allowed: true, trial: false })
    assert.deepEqual(on("trialing"), { allowed: true, trial: true })
    assert.deepEqual(on("trialing", TRIAL_HOSTED_RUNS - 1), { allowed: true, trial: true })
  })

  test("not entitled: Free, past due, paused, canceled, incomplete", () => {
    for (const status of ["none", "past_due", "paused", "canceled", "incomplete"] as const) assert.deepEqual(on(status), { allowed: false, reason: "plan" }, status)
    assert.deepEqual(on(null, 0, "free"), { allowed: false, reason: "plan" }, "never billed")
    assert.deepEqual(on(null), { allowed: false, reason: "plan" })
  })

  test("the trial's allowance runs out at the constant, and says so", () => {
    assert.equal(TRIAL_HOSTED_RUNS, 25)
    assert.deepEqual(on("trialing", TRIAL_HOSTED_RUNS), { allowed: false, reason: "trial-limit" })
    assert.deepEqual(on("trialing", TRIAL_HOSTED_RUNS + 3), { allowed: false, reason: "trial-limit" })
    assert.match(hostedRunsMessage("trial-limit"), /trial's 25 hosted runs are used up/)
    assert.match(hostedRunsMessage("plan"), /Hosted runs are part of Team\. Upgrade .*, or run your own agent: stdartifacts agent serve/)
  })

  test("Team set by hand (no billing status) counts as active", () => {
    assert.deepEqual(on(null, 0, "team"), { allowed: true, trial: false })
  })

  test("with billing off, every workspace runs, whatever its status", () => {
    for (const status of [null, "none", "paused", "past_due", "trialing"] as const) {
      assert.deepEqual(hostedRuns({ billingEnabled: false, status, plan: "free", trialRunsUsed: 999 }), { allowed: true, trial: false })
    }
  })

  test("a run acts with the requester's effective role, never above editor", () => {
    assert.equal(runnerRole("owner", "team", true), "editor")
    assert.equal(runnerRole("editor", "team", true), "editor")
    assert.equal(runnerRole("editor", "free", true), "viewer", "an Editor on Free limits reads, and so does their run")
    assert.equal(runnerRole("viewer", "team", true), "viewer")
    assert.equal(runnerRole("editor", "free", false), "editor", "billing off: as before")
    assert.equal(runnerRole("owner", "free", false), "editor")
  })

  test("cells tell billing is on from the raw env, the same way the Billing service does", () => {
    const all = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_MONTHLY: "p_m", STRIPE_PRICE_ANNUAL: "p_y", WORKOS_API_KEY: "sk_x" }
    assert.equal(billingOn(all), true)
    assert.equal(billingOn({ ...all, AUTH_MODE: "live" }), true)
    assert.equal(billingOn({ ...all, AUTH_MODE: "dev" }), false)
    assert.equal(billingOn({ WORKOS_API_KEY: "sk_x" }), false)
  })
})
