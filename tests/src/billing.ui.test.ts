import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import type { Browser } from "playwright-core"
import { FAKE_PRICE_ANNUAL, FAKE_PRICE_MONTHLY, FAKE_STRIPE_KEY, FAKE_WEBHOOK_SECRET, startFakeStripe, type FakeStripe } from "./fake-stripe.ts"
import { launch } from "./harness.ts"
import { startLive, type LiveApp } from "./live-harness.ts"

/**
 * Billing in a real browser (production web build, live mode, fake WorkOS and
 * Stripe): the upgrade prompt when inviting an Editor on Free, Settings →
 * Billing, Checkout, and coming back to Team without signing in again.
 */

let app: LiveApp
let stripe: FakeStripe
let browser: Browser
before(async () => {
  stripe = await startFakeStripe()
  app = await startLive({
    STRIPE_SECRET_KEY: FAKE_STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
    STRIPE_PRICE_MONTHLY: FAKE_PRICE_MONTHLY,
    STRIPE_PRICE_ANNUAL: FAKE_PRICE_ANNUAL,
    STRIPE_API_URL: stripe.url,
  })
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await app?.close()
  await stripe?.close()
})

describe("billing (live mode)", () => {
  test("invite an Editor on Free, follow the prompt to Billing, start the trial, come back on Team", async () => {
    app.fake.user("bea@example.test", "Bea", "Lin")
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const p = await ctx.newPage()
    const errors: Array<string> = []
    p.on("pageerror", (e) => errors.push(e.message))

    await p.goto(app.base)
    await p.getByRole("button", { name: "Continue" }).click()
    await p.getByLabel("Email").fill("bea@example.test")
    await p.getByRole("button", { name: "Continue" }).click()
    await p.getByRole("button", { name: "Account" }).waitFor({ timeout: 15000 })

    // Members: an Editor on Free gets the upgrade prompt, not a bare error.
    await p.goto(`${app.base}/settings/members`)
    await p.getByText("1 member").waitFor()
    await p.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Billing" }).waitFor()
    await p.getByLabel("Email", { exact: true }).fill("colleague@example.test")
    await p.getByLabel("Role for the invitation").selectOption("editor")
    await p.getByRole("button", { name: "Invite" }).click()
    const prompt = p.getByRole("alert").filter({ hasText: "Editors take a seat on Team" })
    await prompt.waitFor()
    await prompt.getByRole("link", { name: "See plans and upgrade" }).click()

    // Billing: Free, the trial on offer, annual picked by default.
    await p.getByRole("heading", { name: "Billing" }).waitFor()
    await p.getByText("Try Team free for 14 days").waitFor()
    assert.equal(await p.getByRole("radio", { name: /Annual/ }).isChecked(), true)
    await p.getByText("$10 per seat a month, $120 a year for 1 seat").waitFor()

    // Checkout is Stripe's page; stand in for it.
    await p.route("https://checkout.stripe.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Checkout</title>Stripe Checkout" }))
    await p.getByRole("radio", { name: /Monthly/ }).check({ force: true })
    await p.getByRole("button", { name: "Start free trial" }).click()
    await p.waitForURL(/checkout\.stripe\.test/)
    const params = stripe.checkouts.at(-1)!
    assert.equal(params["line_items[0][price]"], FAKE_PRICE_MONTHLY)
    assert.equal(params["subscription_data[trial_period_days]"], "14")

    // Stripe finishes Checkout and sends the webhook; the browser comes back.
    const sub = stripe.subscribe(params.customer!, { trialDays: 14 })
    assert.equal((await stripe.deliver(app.base, "checkout.session.completed", { customer: params.customer, subscription: sub.id })).status, 200)
    await p.goto(`${app.base}/settings/billing?checkout=done`)
    await p.getByText("Team (trial)").waitFor({ timeout: 20000 })
    await p.getByRole("button", { name: "Manage billing" }).waitFor()

    // General shows the plan the new ticket carries.
    await p.goto(`${app.base}/settings/general`)
    await p.getByRole("link", { name: "Team" }).waitFor()
    assert.deepEqual(errors, [])
    await ctx.close()
  })
})
