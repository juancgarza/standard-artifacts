import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { FAKE_PRICE_ANNUAL, FAKE_PRICE_MONTHLY, FAKE_STRIPE_KEY, FAKE_WEBHOOK_SECRET, startFakeStripe, type FakeStripe } from "./fake-stripe.ts"
import { bearer, startLive, Visitor, type LiveApp } from "./live-harness.ts"

/**
 * Hosted @claude runs are for paying workspaces. Live mode with the RunnerCell
 * bound, against a fake WorkOS and a fake Stripe. Miniflare has no containers,
 * so a run that gets past every check fails to launch: the org's cell counts
 * each one it tried, which is what these tests read (over RPC).
 */

type HostedInfo = { available: boolean; reason: string | null; trialUsed: number; trialLimit: number; started: number }

const workspace = async (app: LiveApp, orgId: string) => {
  const ns = await app.mf.getDurableObjectNamespace("WORKSPACE")
  const cell = ns.get(ns.idFromName(orgId)) as unknown as { hostedRunsInfo(): Promise<HostedInfo | null> }
  return { hostedRunsInfo: async () => plain(await cell.hostedRunsInfo()) }
}
/**
 * Ask a RunnerCell to start a run directly, as WorkspaceCell would. "refused:<reason>" when its own checks say no;
 * "launch" when it got past them and tried to start a container (Miniflare has none, so that throws).
 */
async function attempt(app: LiveApp, name: string, job: unknown): Promise<string> {
  const ns = await app.mf.getDurableObjectNamespace("RUNNER")
  const cell = ns.get(ns.idFromName(name)) as unknown as { run(job: unknown): Promise<{ started: boolean; reason?: string }> }
  try {
    const outcome = await cell.run(job)
    return outcome.started ? "started" : `refused:${outcome.reason}`
  } catch {
    return "launch"
  }
}
/** RPC answers are proxies: copy the fields to compare them. */
const plain = (i: HostedInfo | null) => (i ? { available: i.available, reason: i.reason, trialUsed: i.trialUsed, trialLimit: i.trialLimit, started: i.started } : null)

/** Wait for `check` to hold, up to a few seconds. */
async function until<T>(check: () => Promise<T>, ok: (v: T) => boolean, ms = 6000): Promise<T> {
  const end = Date.now() + ms
  let v = await check()
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100))
    v = await check()
  }
  return v
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function owner(app: LiveApp, email: string) {
  const v = new Visitor(app, email)
  await v.signIn()
  const s = await v.session()
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const doc = await v.api("POST", "/artifacts", { kind: "doc", title: "Notes" })
  assert.equal(doc.status, 200, JSON.stringify(doc.body))
  return { v, orgId: s.body.org.id as string, docId: doc.body.id as string, userId: s.body.user.id as string }
}

let n = 0
const ask = (v: Visitor, artifactId: string) => v.api("POST", "/mentions", { artifactId, target: { type: "block", id: `b${++n}` }, text: "@claude summarize this" })
const job = (orgId: string, mentionId: string, requestedBy: string, role = "editor") => ({ orgId, orgName: "x", plan: "team", requestedBy, role, mentionId })

describe("hosted runs with billing off", () => {
  let app: LiveApp
  before(async () => {
    app = await startLive({}, { runner: true })
  })
  after(async () => {
    await app?.close()
  })

  test("every workspace runs, as before: a mention starts a hosted run", async () => {
    const { v, orgId, docId, userId } = await owner(app, "nobill@example.test")
    const m = await ask(v, docId)
    assert.equal(m.status, 200, JSON.stringify(m.body))
    assert.equal(m.body.unhosted, undefined)
    const cell = await workspace(app, orgId)
    const info = await until(() => cell.hostedRunsInfo(), (i) => (i?.started ?? 0) >= 1)
    assert.equal(info?.started, 1, "the cell tried to start a run")
    assert.equal(info?.available, true)
    // The RunnerCell's own check lets it through too (and then there's no container to start).
    assert.equal(await attempt(app, "nobill", job(orgId, m.body.id, userId)), "launch")
    assert.equal((await v.api("GET", "/billing")).body.hostedRuns, undefined, "billing off: no billing info to show")
  })
})

describe("hosted runs with billing on", () => {
  let app: LiveApp
  let stripe: FakeStripe
  before(async () => {
    stripe = await startFakeStripe()
    app = await startLive(
      {
        STRIPE_SECRET_KEY: FAKE_STRIPE_KEY,
        STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
        STRIPE_PRICE_MONTHLY: FAKE_PRICE_MONTHLY,
        STRIPE_PRICE_ANNUAL: FAKE_PRICE_ANNUAL,
        STRIPE_API_URL: stripe.url,
      },
      { runner: true },
    )
  })
  after(async () => {
    await app?.close()
    await stripe?.close()
  })

  let free: Awaited<ReturnType<typeof owner>>
  let filed: string
  test("on Free, a mention is filed but the hosted runner doesn't take it, and says why", async () => {
    free = await owner(app, "free-runs@example.test")
    const m = await ask(free.v, free.docId)
    assert.equal(m.status, 200, "filed, exactly as before")
    filed = m.body.id
    assert.equal(m.body.status, "queued")
    assert.equal(m.body.unhosted.reason, "plan")
    assert.match(m.body.unhosted.message, /Hosted runs are part of Team\. Upgrade in Settings → Billing, or run your own agent: stdartifacts agent serve/)
    const listed = (await free.v.api("GET", `/mentions?artifactId=${free.docId}`)).body
    assert.equal(listed[0].unhosted.reason, "plan")

    await pause(1500)
    const info = await (await workspace(app, free.orgId)).hostedRunsInfo()
    assert.equal(info?.started, 0, "no hosted run was started")
    assert.deepEqual({ available: info?.available, reason: info?.reason }, { available: false, reason: "plan" })
    const billing = (await free.v.api("GET", "/billing")).body
    assert.deepEqual(billing.hostedRuns, { available: false, reason: "plan", trialUsed: 0, trialLimit: 25 })
  })

  test("the RunnerCell refuses on its own, whoever asks it", async () => {
    assert.equal(await attempt(app, "free-direct", job(free.orgId, filed, free.userId)), "refused:plan")
  })

  test("a mention on Free stays queued for the person's own agent, which can claim it", async () => {
    const token = (await free.v.createToken("my agent")).body.token
    const claimed = await bearer(app, token, "POST", "/mentions/claim", { runner: "laptop", artifactId: free.docId }, { "x-dev-as": "agent" })
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
    assert.equal(claimed.body.id, filed)
    assert.equal(claimed.body.status, "running")
  })

  let trial: Awaited<ReturnType<typeof owner>>
  let customer: string
  let subscription: string
  test(`a trial gets 25 hosted runs in all, then says the allowance is used up`, async () => {
    trial = await owner(app, "trial-runs@example.test")
    assert.equal((await trial.v.api("POST", "/billing/checkout", { interval: "month" })).status, 200)
    customer = stripe.checkouts.at(-1)!.customer!
    const sub = stripe.subscribe(customer, { trialDays: 14 })
    subscription = sub.id
    assert.equal((await stripe.deliver(app.base, "customer.subscription.created", sub)).status, 200)
    const cell = await workspace(app, trial.orgId)
    assert.equal((await cell.hostedRunsInfo())?.available, true)

    for (let i = 1; i <= 25; i++) {
      const m = await ask(trial.v, trial.docId)
      assert.equal(m.body.unhosted, undefined, `run ${i} is within the allowance`)
      const info = await until(() => cell.hostedRunsInfo(), (x) => (x?.trialUsed ?? 0) >= i)
      assert.equal(info?.trialUsed, i)
      // Done with it, so the next one isn't waiting on the per-org limit of runs at once.
      await trial.v.api("POST", `/mentions/${m.body.id}/cancel`)
    }

    const over = await ask(trial.v, trial.docId)
    assert.equal(over.body.status, "queued")
    assert.equal(over.body.unhosted.reason, "trial-limit")
    assert.match(over.body.unhosted.message, /trial's 25 hosted runs are used up/)
    await pause(1500)
    const info = await cell.hostedRunsInfo()
    assert.equal(info?.trialUsed, 25)
    assert.equal(info?.started, 25, "no 26th run")
    assert.deepEqual((await trial.v.api("GET", "/billing")).body.hostedRuns, { available: false, reason: "trial-limit", trialUsed: 25, trialLimit: 25 })

    // The RunnerCell agrees: a new mention is refused, one already counted may still be retried.
    assert.equal(await attempt(app, "trial-over", job(trial.orgId, over.body.id, trial.userId)), "refused:trial-limit")
    const counted = (await trial.v.api("GET", `/mentions?artifactId=${trial.docId}`)).body.find((m: any) => m.status === "cancelled")
    assert.equal(await attempt(app, "trial-retry", job(trial.orgId, counted.id, trial.userId)), "launch")
  })

  test("paying for Team (active) starts the request that waited", async () => {
    stripe.setStatus(subscription, "active")
    assert.equal((await stripe.deliver(app.base, "customer.subscription.updated", stripe.subscriptions.get(subscription))).status, 200)
    const cell = await workspace(app, trial.orgId)
    const info = await until(() => cell.hostedRunsInfo(), (x) => (x?.started ?? 0) >= 26)
    assert.equal(info?.started, 26)
    assert.equal(info?.available, true)
    const listed = (await trial.v.api("GET", `/mentions?artifactId=${trial.docId}`)).body
    assert.ok(listed.every((m: any) => m.unhosted === undefined))
  })

  test("a run never acts above its requester: someone who can only read gets no container", async () => {
    assert.equal(await attempt(app, "read-only", job(trial.orgId, "m_any", trial.userId, "viewer")), "refused:read-only")
    assert.equal(await attempt(app, "as-owner", job(trial.orgId, "m_any", trial.userId, "owner")), "launch", "an owner's run goes ahead, as an editor")
  })

  test("past due or paused: no hosted runs again", async () => {
    stripe.setStatus(subscription, "past_due")
    await stripe.deliver(app.base, "invoice.payment_failed", { customer, subscription })
    const m = await ask(trial.v, trial.docId)
    assert.equal(m.body.unhosted.reason, "plan")
    const before = (await (await workspace(app, trial.orgId)).hostedRunsInfo())?.started
    await pause(1500)
    assert.equal((await (await workspace(app, trial.orgId)).hostedRunsInfo())?.started, before)
  })
})
