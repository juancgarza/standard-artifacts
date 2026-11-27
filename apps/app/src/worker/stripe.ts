import { Effect, Redacted, Schema } from "effect"

/**
 * A small Stripe client over plain `fetch`: form-encoded requests to the REST
 * API, answers decoded with Schema. Only what billing needs (customers,
 * subscriptions, Checkout, the customer portal). No SDK, like workos.ts, so
 * the Worker stays light and runs on celld too.
 *
 * STRIPE_API_URL points it somewhere other than https://api.stripe.com, which
 * is how the tests run it against a fake.
 *
 * Imports nothing local, so tests load it directly.
 */

/**
 * Every request pins the API version, so the account's default version can't
 * change the shapes below. The webhook endpoint that scripts/stripe-setup.mjs
 * creates uses the same one.
 */
export const STRIPE_API_VERSION = "2025-03-31.basil"

export class StripeError extends Schema.TaggedError<StripeError>()("StripeError", {
  /** HTTP status, or 0 when Stripe couldn't be reached or answered with something unreadable. */
  status: Schema.Number,
  /** Stripe's error `type` (`invalid_request_error`, `card_error`…), or "". */
  type: Schema.String,
  message: Schema.String,
}) {}

const Metadata = Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))
const Nullable = <S extends Schema.Top>(s: S) => Schema.optionalKey(Schema.NullOr(s))

export const StripePrice = Schema.Struct({
  id: Schema.String,
  recurring: Nullable(Schema.Struct({ interval: Schema.String })),
})

export const StripeSubscriptionItem = Schema.Struct({
  id: Schema.String,
  quantity: Nullable(Schema.Number),
  price: StripePrice,
})
export interface StripeSubscriptionItem extends Schema.Schema.Type<typeof StripeSubscriptionItem> {}

export const StripeSubscription = Schema.Struct({
  id: Schema.String,
  /** Not expanded, so always the customer's id. */
  customer: Schema.String,
  /** trialing, active, past_due, paused, canceled, unpaid, incomplete, incomplete_expired. */
  status: Schema.String,
  created: Schema.Number,
  trial_end: Nullable(Schema.Number),
  cancel_at_period_end: Schema.optionalKey(Schema.Boolean),
  metadata: Metadata,
  items: Schema.Struct({ data: Schema.Array(StripeSubscriptionItem) }),
})
export interface StripeSubscription extends Schema.Schema.Type<typeof StripeSubscription> {}

export const StripeCustomer = Schema.Struct({
  id: Schema.String,
  /** A deleted customer answers `{ id, deleted: true }`. */
  deleted: Schema.optionalKey(Schema.Boolean),
  metadata: Metadata,
})
export interface StripeCustomer extends Schema.Schema.Type<typeof StripeCustomer> {}

const Session = Schema.Struct({ id: Schema.String, url: Nullable(Schema.String) })
const PortalConfiguration = Schema.Struct({ id: Schema.String, active: Schema.Boolean, metadata: Metadata })
const List = <S extends Schema.Top>(item: S) => Schema.Struct({ data: Schema.Array(item), has_more: Schema.optionalKey(Schema.Boolean) })

export interface StripeOptions {
  readonly secretKey: Redacted.Redacted<string>
  /** Default https://api.stripe.com. */
  readonly apiUrl: string
}

/** A form value: nested objects and arrays become `a[b][0]=…`, as Stripe expects. Undefined is left out. */
export type FormValue = string | number | boolean | undefined | ReadonlyArray<FormValue> | { readonly [key: string]: FormValue }

export function formEncode(params: { readonly [key: string]: FormValue }): string {
  const out = new URLSearchParams()
  const add = (key: string, value: FormValue) => {
    if (value === undefined) return
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v))
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v)
    else out.append(key, String(value))
  }
  for (const [k, v] of Object.entries(params)) add(k, v)
  return out.toString()
}

export type StripeClient = ReturnType<typeof makeStripe>

export function makeStripe(options: StripeOptions) {
  const base = options.apiUrl.replace(/\/+$/, "")

  const call = <S extends Schema.Top & { readonly DecodingServices: never }>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: S,
    input: { readonly params?: { readonly [key: string]: FormValue }; readonly idempotencyKey?: string } = {},
  ): Effect.Effect<S["Type"], StripeError> =>
    Effect.gen(function* () {
      const encoded = input.params ? formEncode(input.params) : ""
      const url = method === "GET" && encoded ? `${base}${path}?${encoded}` : `${base}${path}`
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method,
            headers: {
              authorization: `Bearer ${Redacted.value(options.secretKey)}`,
              "stripe-version": STRIPE_API_VERSION,
              accept: "application/json",
              ...(method !== "GET" && { "content-type": "application/x-www-form-urlencoded" }),
              ...(input.idempotencyKey && { "idempotency-key": input.idempotencyKey }),
            },
            ...(method !== "GET" && encoded && { body: encoded }),
          }),
        catch: (e) => new StripeError({ status: 0, type: "", message: `Couldn't reach Stripe: ${String(e)}` }),
      })
      const text = yield* Effect.promise(() => response.text())
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        // not JSON: handled below
      }
      if (!response.ok) {
        const error = (typeof json === "object" && json !== null ? (json as { error?: unknown }).error : undefined) as Record<string, unknown> | undefined
        return yield* new StripeError({
          status: response.status,
          type: typeof error?.type === "string" ? error.type : "",
          message: typeof error?.message === "string" ? error.message : `Stripe answered ${response.status}`,
        })
      }
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError((e) => new StripeError({ status: 0, type: "", message: `Unexpected answer from Stripe ${method} ${path}: ${e.message}` })),
      )
    }).pipe(Effect.withSpan(`Stripe ${method} ${path.replace(/\/(?:cus|sub|si|cs|bpc)_[\w]+/g, "/:id")}`))

  return {
    /** A customer for one org. The org id rides in its metadata, which is how the webhook finds the org again. */
    createCustomer: (p: { readonly orgId: string; readonly name: string }) =>
      call("POST", "/v1/customers", StripeCustomer, {
        params: { name: p.name, metadata: { orgId: p.orgId } },
        // A double click, or two owners at once, makes one customer (Stripe keeps keys for 24 hours).
        idempotencyKey: `standard-artifacts-customer-${p.orgId}`,
      }),
    getCustomer: (id: string) => call("GET", `/v1/customers/${encodeURIComponent(id)}`, StripeCustomer),
    /** Every subscription of a customer, canceled ones included (newest first). */
    listSubscriptions: (customerId: string) =>
      Effect.map(call("GET", "/v1/subscriptions", List(StripeSubscription), { params: { customer: customerId, status: "all", limit: 100 } }), (l) => l.data),
    getSubscription: (id: string) => call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`, StripeSubscription),
    /** Seats: a new quantity on the subscription's item, prorated. */
    setQuantity: (itemId: string, quantity: number) =>
      call("POST", `/v1/subscription_items/${encodeURIComponent(itemId)}`, StripeSubscriptionItem, {
        params: { quantity, proration_behavior: "create_prorations" },
      }),
    cancelSubscription: (id: string) => call("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`, StripeSubscription),
    createCheckoutSession: (params: { readonly [key: string]: FormValue }) => call("POST", "/v1/checkout/sessions", Session, { params }),
    createPortalSession: (p: { readonly customer: string; readonly returnUrl: string; readonly configuration: string | undefined }) =>
      call("POST", "/v1/billing_portal/sessions", Session, { params: { customer: p.customer, return_url: p.returnUrl, configuration: p.configuration } }),
    listPortalConfigurations: () =>
      Effect.map(call("GET", "/v1/billing_portal/configurations", List(PortalConfiguration), { params: { active: true, limit: 100 } }), (l) => l.data),
  }
}

// --- Webhook signatures ----------------------------------------------------------------------

/** How old a signed event may be (Stripe's own default), so a captured request can't be replayed later. */
export const SIGNATURE_TOLERANCE_S = 300

export type SignatureCheck = "valid" | "missing" | "invalid" | "stale"

/**
 * Check a `Stripe-Signature` header (`t=<unix>,v1=<hex>,v1=<hex>…`) against the
 * raw body: HMAC-SHA256 under the endpoint's signing secret, over
 * `<t>.<body>`. Any `v1` may match (Stripe sends several while a secret is
 * being rolled); `v0` and other schemes are ignored. The comparison is
 * constant-time, and a timestamp more than `toleranceS` away from now is stale
 * even when the signature matches.
 */
export async function verifyStripeSignature(
  body: string,
  header: string | null | undefined,
  secret: string,
  options: { readonly toleranceS?: number; readonly nowS?: number } = {},
): Promise<SignatureCheck> {
  if (!header || !secret) return "missing"
  let timestamp: number | undefined
  const signatures: Array<string> = []
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value)
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase())
  }
  if (timestamp === undefined || signatures.length === 0) return "missing"
  const expected = await hmacHex(secret, `${timestamp}.${body}`)
  let matched = false
  // Check every candidate, so how long this takes doesn't say which one matched.
  for (const s of signatures) matched = constantTimeEqual(s, expected) || matched
  if (!matched) return "invalid"
  const now = options.nowS ?? Math.floor(Date.now() / 1000)
  return Math.abs(now - timestamp) > (options.toleranceS ?? SIGNATURE_TOLERANCE_S) ? "stale" : "valid"
}

/** A `Stripe-Signature` header for a body, as Stripe would send it. For tests and the fake. */
export async function signStripePayload(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Equal strings, in time that depends only on their length. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
