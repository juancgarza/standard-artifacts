#!/usr/bin/env node
/**
 * Set up Stripe for Standard Artifacts Cloud billing, idempotently: run it again and it finds what's there.
 *
 *   - the product "Standard Artifacts Team" (id standard_artifacts_team)
 *   - its prices, per seat, found by lookup key: $12 a month (sa_team_monthly) and $120 a year (sa_team_annual)
 *   - a customer portal configuration (metadata app=standard-artifacts, which the app looks for): switch between
 *     monthly and annual, change the quantity, cancel at period end, update the payment method, see invoices
 *   - a webhook endpoint at <app-url>/api/billing/webhook for the events the app handles
 *
 * Usage (test mode):
 *
 *   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs --app-url https://staging.standardartifacts.com --out stripe.env
 *
 *   --app-url <url>       the app's address; the webhook goes to <url>/api/billing/webhook and the portal returns to
 *                         <url>/settings/billing (required)
 *   --out <path>          write STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL and STRIPE_WEBHOOK_SECRET there (mode 600)
 *   --print-secrets       print them to stdout instead
 *   --rotate-webhook      Stripe shows a webhook's signing secret only when it's created: delete and recreate the
 *                         endpoint to get a new one (the old secret stops working)
 *   --live                allow a live key (sk_live_/rk_live_). Without it, a live key is refused.
 *
 * Progress goes to stderr, without ids or secrets. STRIPE_API_URL points it somewhere other than
 * https://api.stripe.com (the tests use a fake).
 */
import { chmodSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

/** Keep in step with STRIPE_API_VERSION in apps/app/src/worker/stripe.ts (a test checks). */
const STRIPE_API_VERSION = "2025-03-31.basil"

/** Keep in step with HANDLED in apps/app/src/worker/billing.ts (a test checks). */
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
]

const PRODUCT_ID = "standard_artifacts_team"
const PRICES = [
  { env: "STRIPE_PRICE_MONTHLY", lookupKey: "sa_team_monthly", amount: 1200, interval: "month", nickname: "Team, monthly, per seat" },
  { env: "STRIPE_PRICE_ANNUAL", lookupKey: "sa_team_annual", amount: 12000, interval: "year", nickname: "Team, annual, per seat" },
]
const APP_TAG = "standard-artifacts"

const fail = (message) => {
  console.error(`stripe-setup: ${message}`)
  process.exit(1)
}
const log = (message) => console.error(`stripe-setup: ${message}`)

const { values: args } = parseArgs({
  options: {
    "app-url": { type: "string" },
    out: { type: "string" },
    "print-secrets": { type: "boolean", default: false },
    "rotate-webhook": { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (args.help) {
  console.error("Usage: STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs --app-url <url> (--out <path> | --print-secrets) [--rotate-webhook] [--live]")
  process.exit(0)
}

const key = process.env.STRIPE_SECRET_KEY?.trim()
if (!key) fail("set STRIPE_SECRET_KEY (a test-mode key, sk_test_… or rk_test_…).")
if (/^(sk|rk)_live_/.test(key) && !args.live) fail("that's a live key. This sets up test mode; pass --live to really set up live mode.")
if (!/^(sk|rk)_(test|live)_/.test(key)) fail("STRIPE_SECRET_KEY doesn't look like a Stripe secret or restricted key.")
if (!args["app-url"]) fail("pass --app-url, the app's address (like https://staging.standardartifacts.com).")
let appUrl
try {
  appUrl = new URL(args["app-url"])
  if (appUrl.protocol !== "https:" && appUrl.protocol !== "http:") throw new Error()
} catch {
  fail("--app-url must be an address like https://staging.standardartifacts.com.")
}
const origin = appUrl.origin
if (!args.out && !args["print-secrets"]) fail("pass --out <path> to write the price ids and webhook secret to a file, or --print-secrets to print them.")

const base = (process.env.STRIPE_API_URL?.trim() || "https://api.stripe.com").replace(/\/+$/, "")

/** Nested params as Stripe's bracket keys. */
function form(params, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${k}]` : k
    if (v === undefined) continue
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? form(item, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(item))))
    else if (typeof v === "object") form(v, name, out)
    else out.append(name, String(v))
  }
  return out
}

async function stripe(method, path, params = {}, { idempotencyKey } = {}) {
  const query = method === "GET" ? form(params).toString() : ""
  const res = await fetch(`${base}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "stripe-version": STRIPE_API_VERSION,
      ...(method !== "GET" && { "content-type": "application/x-www-form-urlencoded" }),
      ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
    },
    ...(method !== "GET" && { body: form(params).toString() }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error(`${method} ${path}: ${res.status} ${body?.error?.message ?? "no message"}`)
    error.status = res.status
    throw error
  }
  return body
}

/** Every item of a list, following `has_more`. */
async function all(path, params = {}) {
  const items = []
  let after
  for (let page = 0; page < 20; page++) {
    const res = await stripe("GET", path, { ...params, limit: 100, ...(after && { starting_after: after }) })
    items.push(...res.data)
    if (!res.has_more || res.data.length === 0) break
    after = res.data.at(-1).id
  }
  return items
}

// --- Product --------------------------------------------------------------------------------

async function product() {
  try {
    const found = await stripe("GET", `/v1/products/${PRODUCT_ID}`)
    if (!found.active) await stripe("POST", `/v1/products/${PRODUCT_ID}`, { active: true })
    log("product: exists")
    return found.id
  } catch (e) {
    if (e.status !== 404) throw e
  }
  const made = await stripe("POST", "/v1/products", {
    id: PRODUCT_ID,
    name: "Standard Artifacts Team",
    description: "Per seat: each Owner and Editor. Viewers, agents and access tokens are free.",
    metadata: { app: APP_TAG, plan: "team" },
  })
  log("product: created")
  return made.id
}

// --- Prices ----------------------------------------------------------------------------------

async function prices(productId) {
  const existing = await all("/v1/prices", { lookup_keys: PRICES.map((p) => p.lookupKey), active: true })
  const ids = {}
  for (const p of PRICES) {
    const found = existing.find((x) => x.lookup_key === p.lookupKey)
    const matches = found && found.unit_amount === p.amount && found.currency === "usd" && found.recurring?.interval === p.interval && found.product === productId
    if (matches) {
      ids[p.env] = found.id
      log(`price ${p.lookupKey}: exists`)
      continue
    }
    // Prices can't change amount: a new one takes over the lookup key, and the old one stays for existing subscriptions.
    const made = await stripe(
      "POST",
      "/v1/prices",
      {
        product: productId,
        currency: "usd",
        unit_amount: p.amount,
        recurring: { interval: p.interval, usage_type: "licensed" },
        lookup_key: p.lookupKey,
        transfer_lookup_key: true,
        nickname: p.nickname,
        metadata: { app: APP_TAG },
      },
      { idempotencyKey: `${APP_TAG}-setup-${p.lookupKey}-${p.amount}-${productId}` },
    )
    ids[p.env] = made.id
    log(`price ${p.lookupKey}: ${found ? "replaced (its amount or product differed)" : "created"}`)
  }
  return ids
}

// --- Customer portal --------------------------------------------------------------------------

async function portal(productId, priceIds) {
  const params = {
    business_profile: { headline: "Standard Artifacts: manage your Team plan" },
    default_return_url: `${origin}/settings/billing`,
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "name", "address", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price", "quantity"],
        proration_behavior: "create_prorations",
        products: [{ product: productId, prices: [priceIds.STRIPE_PRICE_MONTHLY, priceIds.STRIPE_PRICE_ANNUAL] }],
      },
    },
    metadata: { app: APP_TAG },
  }
  const found = (await all("/v1/billing_portal/configurations", { active: true })).find((c) => c.metadata?.app === APP_TAG)
  if (found) {
    await stripe("POST", `/v1/billing_portal/configurations/${found.id}`, params)
    log("portal configuration: updated")
  } else {
    await stripe("POST", "/v1/billing_portal/configurations", params)
    log("portal configuration: created")
  }
}

// --- Webhook endpoint ---------------------------------------------------------------------------

async function webhook() {
  const url = `${origin}/api/billing/webhook`
  const found = (await all("/v1/webhook_endpoints")).filter((w) => w.url === url)
  if (found.length && !args["rotate-webhook"]) {
    await stripe("POST", `/v1/webhook_endpoints/${found[0].id}`, { enabled_events: WEBHOOK_EVENTS, disabled: false })
    log("webhook endpoint: exists, events updated. Its signing secret was shown when it was made; pass --rotate-webhook for a new one.")
    return undefined
  }
  for (const w of found) await stripe("DELETE", `/v1/webhook_endpoints/${w.id}`)
  const made = await stripe("POST", "/v1/webhook_endpoints", {
    url,
    enabled_events: WEBHOOK_EVENTS,
    api_version: STRIPE_API_VERSION,
    description: "Standard Artifacts billing",
    metadata: { app: APP_TAG },
  })
  log(`webhook endpoint: ${found.length ? "recreated (the old signing secret no longer works)" : "created"}`)
  return made.secret
}

// --- Main ----------------------------------------------------------------------------------------

try {
  log(`setting up ${/_live_/.test(key) ? "LIVE" : "test"} mode for ${origin}`)
  const productId = await product()
  const priceIds = await prices(productId)
  await portal(productId, priceIds)
  const secret = await webhook()
  const lines = [`STRIPE_PRICE_MONTHLY=${priceIds.STRIPE_PRICE_MONTHLY}`, `STRIPE_PRICE_ANNUAL=${priceIds.STRIPE_PRICE_ANNUAL}`]
  if (secret) lines.push(`STRIPE_WEBHOOK_SECRET=${secret}`)
  const text = `${lines.join("\n")}\n`
  if (args["print-secrets"]) process.stdout.write(text)
  if (args.out) {
    writeFileSync(args.out, text, { mode: 0o600 })
    chmodSync(args.out, 0o600)
    log(`wrote ${lines.map((l) => l.split("=")[0]).join(", ")} to ${args.out}`)
  }
  log("done")
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
}
