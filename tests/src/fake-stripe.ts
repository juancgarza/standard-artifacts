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
  /** What Checkout does when it completes: a subscription for the customer. */
  subscribe(customer: string, options?: { status?: string; price?: string; quantity?: number; trialDays?: number; orgId?: string }): Subscription
  setStatus(id: string, status: string): void
  /** POST a signed event to the app's webhook, as Stripe would. */
  deliver(appBase: string, type: string, object: unknown, options?: { secret?: string; timestamp?: number; signature?: string }): Promise<Response>
  close(): Promise<void>
}

const id = (prefix: string) => `${prefix}_${randomBytes(9).toString("hex")}`

export async function startFakeStripe(): Promise<FakeStripe> {
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
    if (route === "GET /v1/billing_portal/configurations") {
      return send(res, 200, { object: "list", data: [{ id: "bpc_fake", active: true, metadata: { app: "standard-artifacts" } }], has_more: false })
    }
    error(res, 404, `Unrecognized request URL (${route})`)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  ;(fake as { url: string }).url = `http://127.0.0.1:${port}`
  return fake
}
