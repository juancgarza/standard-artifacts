import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"
import { signStripePayload } from "../../apps/app/src/worker/stripe.ts"

/**
 * A fake Stripe for the billing tests: the REST calls the Worker makes
 * (customers, subscriptions, subscription items, Checkout and portal
 * sessions), in memory, plus signed webhook delivery. No Stripe keys, and
 * nothing leaves the machine.
 *
 * Like Stripe, it refuses requests without the secret key or without a
 * pinned `Stripe-Version`, reads form-encoded bodies, and answers errors as
 * `{ error: { type, message } }`. Tests drive what Stripe would do on its
 * own (a Checkout completing, a trial pausing) with `subscribe` and `setStatus`,
 * then `deliver` the matching event.
 */

export const FAKE_STRIPE_KEY = "sk_test_fake_stripe"
export const FAKE_WEBHOOK_SECRET = "whsec_fake_stripe_signing_secret"
export const FAKE_PRICE_MONTHLY = "price_fake_monthly"
export const FAKE_PRICE_ANNUAL = "price_fake_annual"

type Customer = { id: string; name: string; metadata: Record<string, string> }
type Subscription = {
  id: string
  customer: string
  status: string
  created: number
  trial_end: number | null
  metadata: Record<string, string>
  items: { data: Array<{ id: string; quantity: number; price: { id: string; recurring: { interval: string } } }> }
}

export interface FakeStripe {
  readonly url: string
  readonly customers: Map<string, Customer>
  readonly subscriptions: Map<string, Subscription>
  /** Every Checkout session's parameters, flat (`line_items[0][quantity]`), newest last. */
  readonly checkouts: Array<Record<string, string>>
  readonly portals: Array<Record<string, string>>
  /** Every API call, as "METHOD /path". */
  readonly calls: Array<string>
  /** What scripts/stripe-setup.mjs makes: products, prices, portal configurations, webhook endpoints (flat params). */
  readonly products: Map<string, Record<string, any>>
  readonly prices: Map<string, Record<string, any>>
  readonly portalConfigurations: Map<string, Record<string, any>>
  readonly webhookEndpoints: Map<string, Record<string, any>>
  /** What Checkout does when it completes: a subscription for the customer. */
  subscribe(customer: string, options?: { status?: string; price?: string; quantity?: number; trialDays?: number; orgId?: string }): Subscription
  setStatus(id: string, status: string): void
  /** POST a signed event to the app's webhook, as Stripe would. */
  deliver(appBase: string, type: string, object: unknown, options?: { secret?: string; timestamp?: number; signature?: string }): Promise<Response>
  close(): Promise<void>
}

const id = (prefix: string) => `${prefix}_${randomBytes(9).toString("hex")}`

/** `seedPortal`: start with the portal configuration the setup script would have made (default true). */
export async function startFakeStripe(options: { seedPortal?: boolean } = {}): Promise<FakeStripe> {
  const products = new Map<string, Record<string, any>>()
  const prices = new Map<string, Record<string, any>>()
  const portalConfigurations = new Map<string, Record<string, any>>()
  const webhookEndpoints = new Map<string, Record<string, any>>()
  if (options.seedPortal ?? true) portalConfigurations.set("bpc_fake", { id: "bpc_fake", active: true, metadata: { app: "standard-artifacts" } })
  const customers = new Map<string, Customer>()
  const subscriptions = new Map<string, Subscription>()
  const checkouts: Array<Record<string, string>> = []
  const portals: Array<Record<string, string>> = []
  const calls: Array<string> = []
  const idempotent = new Map<string, unknown>()

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  const error = (res: ServerResponse, status: number, message: string) => send(res, status, { error: { type: "invalid_request_error", message } })
  const readForm = (req: IncomingMessage) =>
    new Promise<Record<string, string>>((resolve) => {
      let data = ""
      req.on("data", (c) => (data += c))
      req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(data))))
    })
  /** `metadata[orgId]` and friends, back into an object. */
  const prefixed = (form: Record<string, string>, prefix: string) =>
    Object.fromEntries(Object.entries(form).flatMap(([k, v]) => (k.startsWith(`${prefix}[`) ? [[k.slice(prefix.length + 1, -1), v]] : [])))

  const fake: FakeStripe = {
    url: "",
    customers,
    subscriptions,
    checkouts,
    portals,
    calls,
    products,
    prices,
    portalConfigurations,
    webhookEndpoints,
    subscribe: (customer, o = {}) => {
      const trialDays = o.trialDays ?? 0
      const s: Subscription = {
        id: id("sub"),
        customer,
        status: o.status ?? (trialDays ? "trialing" : "active"),
        created: Math.floor(Date.now() / 1000) + subscriptions.size,
        trial_end: trialDays ? Math.floor(Date.now() / 1000) + trialDays * 86400 : null,
        metadata: o.orgId ? { orgId: o.orgId } : {},
        items: { data: [{ id: id("si"), quantity: o.quantity ?? 1, price: { id: o.price ?? FAKE_PRICE_MONTHLY, recurring: { interval: o.price === FAKE_PRICE_ANNUAL ? "year" : "month" } } }] },
      }
      subscriptions.set(s.id, s)
      return s
    },
    setStatus: (subId, status) => {
      const s = subscriptions.get(subId)
      if (!s) throw new Error(`No subscription ${subId}`)
      s.status = status
    },
    deliver: async (appBase, type, object, o = {}) => {
      const body = JSON.stringify({ id: id("evt"), object: "event", type, data: { object } })
      const signature = o.signature ?? (await signStripePayload(body, o.secret ?? FAKE_WEBHOOK_SECRET, o.timestamp))
      return fetch(`${appBase}/api/billing/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body })
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake")
    const path = url.pathname
    const route = `${req.method} ${path}`
    calls.push(route)
    if (req.headers.authorization !== `Bearer ${FAKE_STRIPE_KEY}`) return error(res, 401, "Invalid API Key provided")
    if (!req.headers["stripe-version"]) return error(res, 400, "Pin a Stripe-Version")
    const form = req.method === "POST" ? await readForm(req) : Object.fromEntries(url.searchParams)
    const key = req.headers["idempotency-key"]
    if (typeof key === "string" && idempotent.has(key)) return send(res, 200, idempotent.get(key))
    const remember = (body: unknown) => {
      if (typeof key === "string") idempotent.set(key, body)
      return send(res, 200, body)
    }

    let m: RegExpMatchArray | null
    if (route === "POST /v1/customers") {
      const c: Customer = { id: id("cus"), name: form.name ?? "", metadata: prefixed(form, "metadata") }
      customers.set(c.id, c)
      return remember({ object: "customer", ...c })
    }
    if ((m = path.match(/^\/v1\/customers\/([\w-]+)$/)) && req.method === "GET") {
      const c = customers.get(m[1]!)
      return c ? send(res, 200, { object: "customer", ...c }) : error(res, 404, "No such customer")
    }
    if (route === "GET /v1/subscriptions") {
      const data = [...subscriptions.values()].filter((s) => s.customer === form.customer).sort((a, b) => b.created - a.created)
      return send(res, 200, { object: "list", data: data.map((s) => ({ object: "subscription", ...s })), has_more: false })
    }
    if ((m = path.match(/^\/v1\/subscriptions\/([\w-]+)$/))) {
      const s = subscriptions.get(m[1]!)
      if (!s) return error(res, 404, "No such subscription")
      if (req.method === "DELETE") s.status = "canceled"
      return send(res, 200, { object: "subscription", ...s })
    }
    if ((m = path.match(/^\/v1\/subscription_items\/([\w-]+)$/)) && req.method === "POST") {
      const item = [...subscriptions.values()].flatMap((s) => s.items.data).find((i) => i.id === m![1])
      if (!item) return error(res, 404, "No such subscription item")
      if (form.proration_behavior !== "create_prorations") return error(res, 400, "Expected prorations")
      item.quantity = Number(form.quantity)
      return send(res, 200, { object: "subscription_item", ...item })
    }
    if (route === "POST /v1/checkout/sessions") {
      if (!form.customer || !customers.has(form.customer)) return error(res, 400, "No such customer")
      checkouts.push(form)
      const sid = id("cs_test")
      return send(res, 200, { object: "checkout.session", id: sid, url: `https://checkout.stripe.test/c/pay/${sid}` })
    }
    if (route === "POST /v1/billing_portal/sessions") {
      if (!form.customer || !customers.has(form.customer)) return error(res, 400, "No such customer")
      portals.push(form)
      return send(res, 200, { object: "billing_portal.session", id: id("bps"), url: `https://billing.stripe.test/p/session/${form.customer}` })
    }
    const list = (data: Array<unknown>) => send(res, 200, { object: "list", data, has_more: false })
    /** `a[0]`, `a[1]`… (or `a[]`) as an array. */
    const arrayOf = (name: string) =>
      Object.entries(form)
        .filter(([k]) => k === `${name}[]` || new RegExp(`^${name.replace(/[[\]]/g, "\\$&")}\\[\\d+\\]$`).test(k))
        .map(([, v]) => v)

    if (route === "GET /v1/billing_portal/configurations") return list([...portalConfigurations.values()].filter((c) => c.active))
    if (route === "POST /v1/billing_portal/configurations") {
      const c = { id: id("bpc"), active: true, ...form, metadata: prefixed(form, "metadata") }
      portalConfigurations.set(c.id, c)
      return send(res, 200, c)
    }
    if ((m = path.match(/^\/v1\/billing_portal\/configurations\/([\w-]+)$/)) && req.method === "POST") {
      const c = portalConfigurations.get(m[1]!)
      if (!c) return error(res, 404, "No such configuration")
      Object.assign(c, form, { metadata: prefixed(form, "metadata") })
      return send(res, 200, c)
    }

    if (route === "POST /v1/products") {
      if (form.id && products.has(form.id)) return error(res, 400, "Product already exists")
      const p = { id: form.id ?? id("prod"), active: true, name: form.name, metadata: prefixed(form, "metadata") }
      products.set(p.id, p)
      return remember(p)
    }
    if ((m = path.match(/^\/v1\/products\/([\w-]+)$/))) {
      const p = products.get(m[1]!)
      if (!p) return error(res, 404, "No such product")
      if (req.method === "POST") Object.assign(p, { active: form.active !== "false" })
      return send(res, 200, p)
    }
    if (route === "GET /v1/prices") {
      const keys = arrayOf("lookup_keys")
      return list([...prices.values()].filter((p) => p.active && (!keys.length || keys.includes(p.lookup_key))))
    }
    if (route === "POST /v1/prices") {
      if (!products.has(form.product ?? "")) return error(res, 400, "No such product")
      if (form.lookup_key) {
        const holder = [...prices.values()].find((p) => p.lookup_key === form.lookup_key)
        if (holder && form.transfer_lookup_key !== "true") return error(res, 400, "Lookup key in use")
        if (holder) holder.lookup_key = null
      }
      const p = {
        id: id("price"),
        active: true,
        product: form.product,
        currency: form.currency,
        unit_amount: Number(form.unit_amount),
        lookup_key: form.lookup_key ?? null,
        recurring: { interval: form["recurring[interval]"], usage_type: form["recurring[usage_type]"] },
      }
      prices.set(p.id, p)
      return remember(p)
    }

    if (route === "GET /v1/webhook_endpoints") return list([...webhookEndpoints.values()].map(({ secret: _, ...w }) => w))
    if (route === "POST /v1/webhook_endpoints") {
      const w = { id: id("we"), url: form.url, api_version: form.api_version, enabled_events: arrayOf("enabled_events"), secret: `whsec_${randomBytes(16).toString("hex")}` }
      webhookEndpoints.set(w.id, w)
      return send(res, 200, w)
    }
    if ((m = path.match(/^\/v1\/webhook_endpoints\/([\w-]+)$/))) {
      const w = webhookEndpoints.get(m[1]!)
      if (!w) return error(res, 404, "No such webhook endpoint")
      if (req.method === "DELETE") {
        webhookEndpoints.delete(w.id)
        return send(res, 200, { id: w.id, deleted: true })
      }
      if (req.method === "POST") w.enabled_events = arrayOf("enabled_events")
      const { secret: _, ...shown } = w
      return send(res, 200, shown)
    }
    error(res, 404, `Unrecognized request URL (${route})`)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  ;(fake as { url: string }).url = `http://127.0.0.1:${port}`
  return fake
}
