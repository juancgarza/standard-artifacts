import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { FAKE_PRICE_ANNUAL, FAKE_PRICE_MONTHLY, FAKE_STRIPE_KEY, FAKE_WEBHOOK_SECRET, startFakeStripe, type FakeStripe } from "./fake-stripe.ts"
import { startLive, Visitor, type LiveApp } from "./live-harness.ts"

/**
 * Billing in live mode (Standard Artifacts Cloud) against a fake WorkOS and a
 * fake Stripe: the invite gate on Free, Checkout's trial, the signed webhook
 * mirroring a subscription into WorkOS metadata, seats following members,
 * Free limits when a trial pauses, and that without Stripe settings nothing
 * changes at all.
 */

let app: LiveApp
let stripe: FakeStripe
before(async () => {
  stripe = await startFakeStripe()
  app = await startLive({
    STRIPE_SECRET_KEY: FAKE_STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
    STRIPE_PRICE_MONTHLY: FAKE_PRICE_MONTHLY,
    STRIPE_PRICE_ANNUAL: FAKE_PRICE_ANNUAL,
    STRIPE_API_URL: stripe.url,
  })
})
after(async () => {
  await app?.close()
  await stripe?.close()
})

async function signedIn(a: LiveApp, email: string, invitationToken?: string) {
  const v = new Visitor(a, email)
  await v.signIn(invitationToken ? { invitationToken } : {})
  const s = await v.session()
  assert.equal(s.status, 200, JSON.stringify(s.body))
  return v
}

/** Invite someone and have them accept: they sign in with the invitation's token. */
async function join(a: LiveApp, owner: Visitor, email: string, role: string) {
  const sent = await owner.api("POST", "/org/invitations", { email, role })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  return signedIn(a, email, a.fake.invitations.get(sent.body.id)!.token)
}

describe("billing on", () => {
  let owner: Visitor
  let orgId: string
  let customerId: string
  let subscriptionId: string
  const metadata = () => app.fake.orgs.get(orgId)!.metadata

  before(async () => {
    owner = await signedIn(app, "billing-owner@example.test")
    orgId = (await owner.session()).body.org.id
  })

  test("a new workspace is on Free, with the trial available, and Settings shows Billing", async () => {
    const info = await owner.api("GET", "/billing")
    assert.equal(info.status, 200)
    assert.deepEqual(info.body, {
      enabled: true,
      plan: "free",
      status: "none",
      interval: null,
      seats: 0,
      paidMembers: 1,
      trialEndsAt: null,
      trialAvailable: true,
      canManage: true,
    })
    assert.equal((await owner.api("GET", "/workspace")).body.billing, true)
  })

  test("on Free, inviting an Editor or Owner answers UpgradeRequired; a Viewer is free", async () => {
    for (const role of ["editor", "owner"]) {
      const res = await owner.api("POST", "/org/invitations", { email: `paid-${role}@example.test`, role })
      assert.equal(res.status, 402, JSON.stringify(res.body))
      assert.equal(res.body._tag, "UpgradeRequired")
      assert.match(res.body.message, /upgrade in Settings → Billing/)
    }
    const viewer = await join(app, owner, "free-viewer@example.test", "viewer")
    assert.equal((await viewer.session()).body.role, "viewer")
    // Promoting the viewer is adding a seat too.
    const members = (await owner.api("GET", "/org/members")).body.members
    const m = members.find((x: any) => x.email === "free-viewer@example.test")
    const promoted = await owner.api("PATCH", `/org/members/${m.id}`, { role: "editor" })
    assert.equal(promoted.status, 402)
    assert.equal(promoted.body._tag, "UpgradeRequired")
  })

  test("only owners, in the app, start Checkout", async () => {
    const viewer = new Visitor(app, "free-viewer@example.test")
    await viewer.signIn()
    await viewer.session()
    assert.equal((await viewer.api("POST", "/billing/checkout", { interval: "month" })).status, 403)
    assert.equal((await viewer.api("GET", "/billing")).body.canManage, false)
    assert.equal(stripe.checkouts.length, 0)
  })

  test("Checkout starts a 14-day trial with no card, for one seat, and remembers the customer", async () => {
    const res = await owner.api("POST", "/billing/checkout", { interval: "year" })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.match(res.body.url, /^https:\/\/checkout\.stripe\.test\//)
    const params = stripe.checkouts.at(-1)!
    customerId = params.customer!
    assert.equal(params.mode, "subscription")
    assert.equal(params.client_reference_id, orgId)
    assert.equal(params["line_items[0][price]"], FAKE_PRICE_ANNUAL)
    assert.equal(params["line_items[0][quantity]"], "1", "the owner; viewers are free")
    assert.equal(params["subscription_data[trial_period_days]"], "14")
    assert.equal(params["subscription_data[trial_settings][end_behavior][missing_payment_method]"], "pause")
    assert.equal(params.payment_method_collection, "if_required")
    assert.equal(params["subscription_data[metadata][orgId]"], orgId)
    assert.equal(params.success_url, `${app.base}/settings/billing?checkout=done`)
    assert.equal(stripe.customers.get(customerId)?.metadata.orgId, orgId)
    assert.equal(metadata().stripeCustomerId, customerId)
    // Checking out again (abandoned the first time) reuses the customer and still offers the trial.
    await owner.api("POST", "/billing/checkout", { interval: "month" })
    assert.equal(stripe.checkouts.at(-1)!.customer, customerId)
    assert.equal(stripe.checkouts.at(-1)!["subscription_data[trial_period_days]"], "14")
    assert.equal(stripe.customers.size, 1)
  })

  test("the webhook refuses bad and stale signatures, and changes nothing", async () => {
    const sub = stripe.subscribe(customerId, { trialDays: 14, price: FAKE_PRICE_ANNUAL, orgId })
    subscriptionId = sub.id
    const bad = await stripe.deliver(app.base, "customer.subscription.created", sub, { secret: "whsec_wrong" })
    assert.equal(bad.status, 400)
    const stale = await stripe.deliver(app.base, "customer.subscription.created", sub, { timestamp: Math.floor(Date.now() / 1000) - 3600 })
    assert.equal(stale.status, 400)
    const unsigned = await fetch(`${app.base}/api/billing/webhook`, { method: "POST", body: "{}" })
    assert.equal(unsigned.status, 400)
    assert.equal(metadata().plan, undefined)
    assert.equal(metadata().billingStatus, undefined)
  })

  test("a signed event mirrors the subscription into WorkOS, and replays change nothing", async () => {
    const sub = stripe.subscriptions.get(subscriptionId)!
    const res = await stripe.deliver(app.base, "checkout.session.completed", { object: "checkout.session", customer: customerId, subscription: sub.id, client_reference_id: orgId })
    assert.equal(res.status, 200, await res.clone().text())
    const after = { ...metadata() }
    assert.equal(after.plan, "team")
    assert.equal(after.billingStatus, "trialing")
    assert.equal(after.seats, "1")
    assert.equal(after.billingInterval, "year")
    assert.equal(after.stripeCustomerId, customerId)
    assert.equal(after.stripeSubscriptionId, sub.id)
    assert.ok(after.trialEndsAt && Date.parse(after.trialEndsAt) > Date.now())
    const writes = app.fake.calls.filter((c) => c === `PUT /organizations/${orgId}`).length

    // The same event again, and another for the same subscription: same state, no new writes.
    assert.equal((await stripe.deliver(app.base, "checkout.session.completed", { customer: customerId, subscription: sub.id })).status, 200)
    assert.equal((await stripe.deliver(app.base, "customer.subscription.updated", sub)).status, 200)
    assert.deepEqual(metadata(), after)
    assert.equal(app.fake.calls.filter((c) => c === `PUT /organizations/${orgId}`).length, writes)

    // Events billing doesn't need are acknowledged and ignored.
    const other = await stripe.deliver(app.base, "charge.refunded", { customer: customerId })
    assert.equal(other.status, 200)
    assert.equal((await other.json()).ignored, "charge.refunded")
  })

  test("the next ticket says Team, without signing in again", async () => {
    const s = await owner.session()
    assert.equal(s.body.org.plan, "team")
    assert.equal((await owner.api("GET", "/workspace")).body.principal.plan, "team")
    const info = (await owner.api("GET", "/billing")).body
    assert.equal(info.plan, "team")
    assert.equal(info.status, "trialing")
    assert.equal(info.trialAvailable, false)
  })

  let editor: Visitor
  test("on Team an Editor can be invited, and accepting takes a seat (prorated)", async () => {
    editor = await join(app, owner, "team-editor@example.test", "editor")
    assert.equal((await editor.session()).body.role, "editor")
    const item = stripe.subscriptions.get(subscriptionId)!.items.data[0]!
    assert.equal(item.quantity, 2, "owner + editor; the viewer is free")
    assert.ok(stripe.calls.includes(`POST /v1/subscription_items/${item.id}`))
    // Stripe tells us; the webhook mirrors the new quantity.
    await stripe.deliver(app.base, "customer.subscription.updated", stripe.subscriptions.get(subscriptionId))
    assert.equal(metadata().seats, "2")

    // Promoting the viewer adds one more; removing them gives it back.
    const members = (await owner.api("GET", "/org/members")).body.members
    const viewer = members.find((x: any) => x.email === "free-viewer@example.test")
    assert.equal((await owner.api("PATCH", `/org/members/${viewer.id}`, { role: "editor" })).status, 200)
    assert.equal(item.quantity, 3)
    await stripe.deliver(app.base, "customer.subscription.updated", stripe.subscriptions.get(subscriptionId))
    assert.equal((await owner.api("DELETE", `/org/members/${viewer.id}`)).status, 204)
    assert.equal(item.quantity, 2)
  })

  test("a trial that ends without a card pauses: Free limits, Editors read, nothing is deleted", async () => {
    const doc = await editor.api("POST", "/artifacts", { kind: "doc", title: "Made on Team" })
    assert.equal(doc.status, 200)

    stripe.setStatus(subscriptionId, "paused")
    assert.equal((await stripe.deliver(app.base, "customer.subscription.paused", stripe.subscriptions.get(subscriptionId))).status, 200)
    assert.equal(metadata().plan, "free")
    assert.equal(metadata().billingStatus, "paused")

    const s = await editor.session()
    assert.equal(s.body.role, "viewer", "an Editor reads on Free limits")
    assert.equal(s.body.org.plan, "free")
    assert.equal((await editor.api("POST", "/artifacts", { kind: "doc", title: "Not now" })).status, 403)
    const list = (await editor.api("GET", "/workspace")).body.artifacts.map((a: any) => a.title)
    assert.ok(list.includes("Made on Team"), "nothing is deleted")
    assert.equal((await owner.session()).body.role, "owner", "the owner keeps editing")
    assert.equal((await owner.api("POST", "/artifacts", { kind: "doc", title: "Owner's" })).status, 200)
    // The member list still says Editor: the role comes back on its own.
    const members = (await owner.api("GET", "/org/members")).body.members
    assert.equal(members.find((m: any) => m.email === "team-editor@example.test").role, "editor")
    const invite = await owner.api("POST", "/org/invitations", { email: "later@example.test", role: "editor" })
    assert.equal(invite.status, 402)
    assert.match(invite.body.message, /trial ended without a payment method/)
  })

  test("upgrading after a pause: Checkout without a trial, then the paused subscription is cancelled", async () => {
    const res = await owner.api("POST", "/billing/checkout", { interval: "month" })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const params = stripe.checkouts.at(-1)!
    assert.equal(params["subscription_data[trial_period_days]"], undefined, "the trial was used")
    assert.equal(params.payment_method_collection, "always")
    assert.equal(params["line_items[0][quantity]"], "2")

    const paid = stripe.subscribe(customerId, { quantity: 2, orgId })
    assert.equal((await stripe.deliver(app.base, "checkout.session.completed", { customer: customerId, subscription: paid.id })).status, 200)
    assert.equal(stripe.subscriptions.get(subscriptionId)!.status, "canceled")
    assert.equal(metadata().plan, "team")
    assert.equal(metadata().billingStatus, "active")
    assert.equal(metadata().stripeSubscriptionId, paid.id)
    // A late event for the old, cancelled subscription doesn't undo it.
    await stripe.deliver(app.base, "customer.subscription.deleted", stripe.subscriptions.get(subscriptionId))
    assert.equal(metadata().plan, "team")
    assert.equal((await editor.session()).body.role, "editor", "the Editor edits again")
    subscriptionId = paid.id
  })

  test("the portal is for owners with a customer", async () => {
    const res = await owner.api("POST", "/billing/portal")
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.url, `https://billing.stripe.test/p/session/${customerId}`)
    assert.equal(stripe.portals.at(-1)!.configuration, "bpc_fake")
    assert.equal(stripe.portals.at(-1)!.return_url, `${app.base}/settings/billing`)
    assert.equal((await editor.api("POST", "/billing/portal")).status, 403)
  })

  test("past due falls back to Free limits too", async () => {
    stripe.setStatus(subscriptionId, "past_due")
    await stripe.deliver(app.base, "invoice.payment_failed", { object: "invoice", customer: customerId, subscription: subscriptionId })
    assert.equal(metadata().billingStatus, "past_due")
    assert.equal((await editor.session()).body.role, "viewer")
    stripe.setStatus(subscriptionId, "active")
    await stripe.deliver(app.base, "invoice.paid", { object: "invoice", customer: customerId, subscription: subscriptionId })
    assert.equal((await editor.session()).body.role, "editor")
  })

  test("an event for a customer that isn't this org's billing is ignored", async () => {
    const stray = "cus_stray"
    stripe.customers.set(stray, { id: stray, name: "x", metadata: { orgId } })
    stripe.subscribe(stray, { status: "canceled" })
    const res = await stripe.deliver(app.base, "customer.subscription.deleted", { customer: stray })
    assert.equal(res.status, 200)
    assert.equal(metadata().plan, "team")
    assert.equal(metadata().stripeCustomerId, customerId)
  })
})

describe("billing off (no Stripe settings)", () => {
  let plain: LiveApp
  before(async () => {
    plain = await startLive()
  })
  after(async () => {
    await plain?.close()
  })

  test("nothing changes: no gate, no Billing in Settings, no webhook", async () => {
    const owner = await signedIn(plain, "plain-owner@example.test")
    const info = await owner.api("GET", "/billing")
    assert.equal(info.status, 200)
    assert.equal(info.body.enabled, false)
    assert.equal((await owner.api("GET", "/workspace")).body.billing, undefined)
    const editor = await join(plain, owner, "plain-editor@example.test", "editor")
    const s = await editor.session()
    assert.equal(s.body.role, "editor", "a Free workspace's Editor edits, as before billing")
    assert.equal(s.body.org.plan, "free")
    assert.equal((await editor.api("POST", "/artifacts", { kind: "doc", title: "Fine" })).status, 200)
    assert.equal((await owner.api("POST", "/billing/checkout", { interval: "month" })).status, 503)
    const hook = await fetch(`${plain.base}/api/billing/webhook`, { method: "POST", body: "{}" })
    assert.equal(hook.status, 404)
    assert.ok(!plain.fake.calls.some((c) => c.startsWith("PUT /organizations")), "never writes org metadata")
  })
})
