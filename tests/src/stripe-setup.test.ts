import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"
import { FAKE_STRIPE_KEY, startFakeStripe, type FakeStripe } from "./fake-stripe.ts"

/** scripts/stripe-setup.mjs against a fake Stripe: what it makes, that a second run finds it, and what it refuses. */

const script = fileURLToPath(new URL("../../scripts/stripe-setup.mjs", import.meta.url))
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
const APP = "https://staging.example.test"

let stripe: FakeStripe
let dir: string
before(async () => {
  stripe = await startFakeStripe({ seedPortal: false })
  dir = mkdtempSync(join(tmpdir(), "stripe-setup-"))
})
after(async () => {
  await stripe?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Run the script (asynchronously: the fake answers from this process). */
const run = (args: Array<string>, key = FAKE_STRIPE_KEY) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", STRIPE_SECRET_KEY: key, STRIPE_API_URL: stripe.url } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    )
  })

const envFile = (text: string) => Object.fromEntries(text.trim().split("\n").map((l) => l.split("=") as [string, string]))

describe("stripe-setup.mjs", () => {
  test("refuses a live key without --live, and doesn't call Stripe", async () => {
    for (const key of ["sk_live_abc", "rk_live_abc"]) {
      const r = await run(["--app-url", APP, "--print-secrets"], key)
      assert.equal(r.code, 1)
      assert.match(r.stderr, /live key/)
    }
    assert.equal(stripe.calls.length, 0)
  })

  test("needs somewhere to put the secrets and the app's address", async () => {
    assert.match((await run(["--app-url", APP])).stderr, /--out <path>.*--print-secrets/)
    assert.match((await run(["--print-secrets"])).stderr, /--app-url/)
    assert.equal(stripe.calls.length, 0)
  })

  let first: Record<string, string>
  test("makes the product, both prices, the portal and the webhook, and writes the ids and secret to a 600 file", async () => {
    const out = join(dir, "stripe.env")
    const r = await run(["--app-url", APP, "--out", out])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, "", "nothing on stdout without --print-secrets")
    first = envFile(readFileSync(out, "utf8"))
    assert.deepEqual(Object.keys(first), ["STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_ANNUAL", "STRIPE_WEBHOOK_SECRET"])
    assert.equal(statSync(out).mode & 0o777, 0o600)
    assert.ok(!r.stderr.includes(first.STRIPE_WEBHOOK_SECRET!) && !r.stderr.includes(first.STRIPE_PRICE_MONTHLY!), "progress shows no ids or secrets")

    assert.equal(stripe.products.get("standard_artifacts_team")?.name, "Standard Artifacts Team")
    const monthly = stripe.prices.get(first.STRIPE_PRICE_MONTHLY!)!
    const annual = stripe.prices.get(first.STRIPE_PRICE_ANNUAL!)!
    assert.deepEqual([monthly.unit_amount, monthly.currency, monthly.recurring.interval, monthly.lookup_key], [1200, "usd", "month", "sa_team_monthly"])
    assert.deepEqual([annual.unit_amount, annual.currency, annual.recurring.interval, annual.lookup_key], [12000, "usd", "year", "sa_team_annual"])
    assert.equal(monthly.recurring.usage_type, "licensed", "per seat")

    const [portal] = [...stripe.portalConfigurations.values()]
    assert.equal(portal!.metadata.app, "standard-artifacts", "the app finds it by this")
    assert.equal(portal!["features[subscription_update][enabled]"], "true")
    assert.equal(portal!["features[subscription_update][default_allowed_updates][0]"], "price")
    assert.equal(portal!["features[subscription_update][default_allowed_updates][1]"], "quantity")
    assert.equal(portal!["features[subscription_update][products][0][prices][0]"], first.STRIPE_PRICE_MONTHLY)
    assert.equal(portal!["features[subscription_update][products][0][prices][1]"], first.STRIPE_PRICE_ANNUAL)
    assert.equal(portal!["features[subscription_cancel][enabled]"], "true")
    assert.equal(portal!["features[payment_method_update][enabled]"], "true")
    assert.equal(portal!.default_return_url, `${APP}/settings/billing`)

    const [hook] = [...stripe.webhookEndpoints.values()]
    assert.equal(hook!.url, `${APP}/api/billing/webhook`)
    assert.equal(hook!.secret, first.STRIPE_WEBHOOK_SECRET)
    assert.equal(hook!.api_version, "2025-03-31.basil")
    assert.ok(hook!.enabled_events.includes("checkout.session.completed") && hook!.enabled_events.includes("invoice.payment_failed"))
  })

  test("a second run finds everything and makes nothing new; the webhook's secret isn't shown again", async () => {
    const r = await run(["--app-url", APP, "--print-secrets"])
    assert.equal(r.code, 0, r.stderr)
    const again = envFile(r.stdout)
    assert.deepEqual(again, { STRIPE_PRICE_MONTHLY: first.STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL: first.STRIPE_PRICE_ANNUAL })
    assert.match(r.stderr, /--rotate-webhook/)
    assert.equal(stripe.products.size, 1)
    assert.equal(stripe.prices.size, 2)
    assert.equal(stripe.portalConfigurations.size, 1)
    assert.equal(stripe.webhookEndpoints.size, 1)
  })

  test("--rotate-webhook replaces the endpoint and hands over its new secret", async () => {
    const r = await run(["--app-url", APP, "--print-secrets", "--rotate-webhook"])
    assert.equal(r.code, 0, r.stderr)
    const rotated = envFile(r.stdout)
    assert.ok(rotated.STRIPE_WEBHOOK_SECRET && rotated.STRIPE_WEBHOOK_SECRET !== first.STRIPE_WEBHOOK_SECRET)
    assert.equal(stripe.webhookEndpoints.size, 1)
  })

  test("its API version and events match the Worker's", () => {
    const setup = read("../../scripts/stripe-setup.mjs")
    const version = (src: string) => /STRIPE_API_VERSION = "([^"]+)"/.exec(src)?.[1]
    assert.equal(version(setup), version(read("../../apps/app/src/worker/stripe.ts")))
    const events = (src: string, name: string) => [...(new RegExp(`${name}[^[]*\\[([^\\]]+)\\]`).exec(src)?.[1] ?? "").matchAll(/"([\w.]+)"/g)].map((m) => m[1]).sort()
    const handled = events(read("../../apps/app/src/worker/billing.ts"), "HANDLED: ReadonlySet<string> = new Set\\(")
    assert.ok(handled.length >= 8)
    assert.deepEqual(events(setup, "const WEBHOOK_EVENTS ="), handled)
  })
})
