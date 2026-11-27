import { useCallback, useEffect, useState } from "react"
import type { Effect } from "effect"
import { TEAM_PRICE, TRIAL_DAYS, type BillingInfo, type BillingInterval, type BillingRedirect, type Principal } from "@standard-artifacts/protocol"
import { Heading, ListSkeleton, Row, Rows } from "../components/settings-parts"
import { renew } from "../session"
import { useApi, type Client } from "./settings-account"

/**
 * Settings → Billing (Cloud): the workspace's plan, its seats, the trial's
 * end, and the way to Stripe: Checkout to start Team, the customer portal to
 * manage it. Owners act; everyone else can see where things stand.
 */

const button = "flex h-8 shrink-0 items-center rounded-md border border-border px-3 text-[13px] font-medium text-text hover:bg-hover disabled:opacity-50"
const primary = "flex h-8 shrink-0 items-center rounded-md bg-accent px-3 text-[13px] font-medium text-accent-text disabled:opacity-50"

const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })

/** A sentence on where the plan stands. */
function standing(b: BillingInfo): string {
  const per = b.interval === "year" ? "billed annually" : "billed monthly"
  const seats = `${b.seats} ${b.seats === 1 ? "seat" : "seats"}`
  switch (b.status) {
    case "trialing":
      return `Team trial${b.trialEndsAt ? ` until ${dateOf(b.trialEndsAt)}` : ""}. Add a payment method before then to keep Team. Without one, the workspace goes back to Free limits, and nothing is deleted.`
    case "active":
      return `${seats}, ${per}.`
    case "past_due":
      return "The last payment didn't go through. Until it's fixed, Free limits apply: Editors can view but not edit."
    case "paused":
      return "The trial ended without a payment method, so Free limits apply: Editors can view but not edit. Nothing was deleted."
    default:
      return b.plan === "team" ? "Everyone in the workspace works together, each with their own role." : "Only you edit. Agents and view-only share links are unlimited."
  }
}

export function Billing({ principal }: { principal: Principal }) {
  const run = useApi()
  const [info, setInfo] = useState<BillingInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<BillingInterval>("year")
  const [busy, setBusy] = useState(false)
  // Back from Checkout: Stripe confirms by webhook, usually within seconds.
  const [returning, setReturning] = useState(() => new URLSearchParams(window.location.search).get("checkout") === "done")

  const load = useCallback(() => run((c) => c.billing.info()).then((b) => (setInfo(b), setError(null), b)), [run])

  useEffect(() => {
    load().catch((e: Error) => setError(e.message))
  }, [load])

  useEffect(() => {
    if (!returning) return
    let tries = 0
    let stopped = false
    const poll = async () => {
      if (stopped) return
      const b = await load().catch(() => null)
      if (b && (b.status === "trialing" || b.status === "active")) {
        // A new ticket carries the new plan; reload so the whole app sees it.
        await renew()
        window.history.replaceState(null, "", "/settings/billing")
        window.location.reload()
        return
      }
      if (++tries < 15) setTimeout(() => void poll(), 2000)
      else setReturning(false)
    }
    void poll()
    return () => {
      stopped = true
    }
  }, [returning, load])

  const go = async (call: (c: Client) => Effect.Effect<BillingRedirect, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const { url } = await run(call)
      window.location.assign(url)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const hasSubscription = info && (info.status === "trialing" || info.status === "active" || info.status === "past_due" || info.status === "paused")
  const canStart = info && info.status !== "trialing" && info.status !== "active" && info.status !== "past_due"
  const monthlyTotal = (n: number) => n * TEAM_PRICE.month
  const annualTotal = (n: number) => n * TEAM_PRICE.year * 12

  return (
    <>
      <Heading title="Billing">
        Team is ${TEAM_PRICE.year} per seat a month billed annually, or ${TEAM_PRICE.month} monthly. A seat is an Owner or an Editor; viewers, agents and access tokens are free.
      </Heading>
      {returning && (
        <p role="status" className="mt-4 text-[13px] text-muted">
          Thanks. Your plan updates as soon as Stripe confirms it…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-[13px] text-danger">
          {error}
        </p>
      )}
      <Rows>
        {!info && !error && <ListSkeleton />}
        {info && (
          <>
            <Row label="Plan" help={standing(info)}>
              <span className="text-text">{info.plan === "team" ? (info.status === "trialing" ? "Team (trial)" : "Team") : "Free"}</span>
            </Row>
            <Row label="Seats" help="Owners and Editors in the workspace now. The subscription follows them, prorated.">
              <span className="text-text">
                {info.paidMembers}
                {hasSubscription && info.seats !== info.paidMembers && <span className="text-muted"> ({info.seats} billed)</span>}
              </span>
            </Row>
          </>
        )}
      </Rows>

      {info && !info.canManage && <p className="mt-3 text-[13px] text-muted">Owners manage billing for {principal.orgName}.</p>}

      {info?.canManage && canStart && (
        <section className="mt-5" aria-label="Upgrade to Team">
          <h3 className="mb-2 text-[13px] font-medium">{info.trialAvailable ? `Try Team free for ${TRIAL_DAYS} days` : "Upgrade to Team"}</h3>
          <div role="radiogroup" aria-label="Billing period" className="grid gap-2 sm:grid-cols-2">
            {(["year", "month"] as const).map((id) => {
              const seats = Math.max(1, info.paidMembers)
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer flex-col rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-accent ${
                    period === id ? "border-accent" : "border-border hover:bg-hover"
                  }`}
                >
                  <input type="radio" name="interval" value={id} checked={period === id} onChange={() => setPeriod(id)} className="sr-only" />
                  <span className="font-medium text-text">{id === "year" ? "Annual" : "Monthly"}</span>
                  <span className="text-[13px] text-muted">
                    ${TEAM_PRICE[id]} per seat a month{id === "year" ? `, $${annualTotal(seats)} a year` : `, $${monthlyTotal(seats)} a month`} for {seats}{" "}
                    {seats === 1 ? "seat" : "seats"}
                  </span>
                </label>
              )
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void go((c) => c.billing.checkout({ payload: { interval: period } }))} className={primary}>
              {busy ? "Opening Stripe…" : info.trialAvailable ? "Start free trial" : "Upgrade to Team"}
            </button>
            {hasSubscription && (
              <button type="button" disabled={busy} onClick={() => void go((c) => c.billing.portal())} className={button}>
                Manage billing
              </button>
            )}
            <span className="text-[13px] text-muted">{info.trialAvailable ? "No card needed for the trial." : "Checkout is on Stripe."}</span>
          </div>
        </section>
      )}

      {info?.canManage && !canStart && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => void go((c) => c.billing.portal())} className={primary}>
            {busy ? "Opening Stripe…" : info.status === "past_due" ? "Update payment method" : "Manage billing"}
          </button>
          <span className="text-[13px] text-muted">Cards, invoices, monthly or annual, and cancelling, on Stripe.</span>
        </div>
      )}
    </>
  )
}
