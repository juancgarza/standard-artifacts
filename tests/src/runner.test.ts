import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { describe, test } from "node:test"
import { appHost, routeOutbound } from "../../apps/app/src/worker/runner-outbound.ts"
import { signTicket } from "../../apps/app/src/worker/tickets.ts"

/** The rules for hosted agent runs that don't need a container or a running app. */

const secrets = { ticket: "the-ticket", anthropicKey: "the-key" }

describe("what a run's container can reach", () => {
  const req = (url: string, init?: RequestInit) => new Request(url, init)

  test("this app gets the run's ticket, whatever the container sent", () => {
    const out = routeOutbound(req(`http://${appHost}/api/v1/workspace`, { headers: { authorization: "Bearer forged", "x-dev-as": "viewer", cookie: "standard_artifacts_ticket=forged" } }), secrets)
    assert.equal(out.to, "app")
    assert.ok(out.to === "app")
    assert.equal(out.request.headers.get("authorization"), "Bearer the-ticket")
    assert.equal(out.request.headers.get("x-dev-as"), null)
    assert.equal(out.request.headers.get("cookie"), null)
  })

  test("the model API gets our key, over HTTPS only", () => {
    const out = routeOutbound(req("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}", headers: { "x-api-key": "added-by-the-worker", authorization: "Bearer forged" } }), secrets)
    assert.ok(out.to === "anthropic")
    assert.equal(out.request.headers.get("x-api-key"), "the-key")
    assert.equal(out.request.headers.get("authorization"), null)
    assert.equal(routeOutbound(req("http://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }), secrets).to, "denied")
  })

  test("a host that only looks like ours gets no credentials", () => {
    for (const url of [`https://${appHost}.evil.test/`, "https://api.anthropic.com.evil.test/", `https://evil.test/${appHost}`]) {
      const out = routeOutbound(req(url), secrets)
      assert.ok(out.to === "web", url)
      assert.equal(out.request.headers.get("authorization"), null)
      assert.equal(out.request.headers.get("x-api-key"), null)
    }
  })

  test("the web is read-only and never sees credentials", () => {
    const out = routeOutbound(req("https://example.com/page", { headers: { "x-api-key": "added-by-the-worker", authorization: "Bearer x" } }), secrets)
    assert.ok(out.to === "web")
    assert.equal(out.request.headers.get("x-api-key"), null)
    assert.equal(out.request.headers.get("authorization"), null)
    assert.equal(routeOutbound(req("https://example.com/", { method: "HEAD" }), secrets).to, "web")
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(routeOutbound(req("https://example.com/collect", { method, ...(method !== "DELETE" && { body: "workspace data" }) }), secrets).to, "denied", method)
    }
  })
})

describe("tickets", () => {
  const principal = { orgId: "o", orgName: "Org — ñ", plan: "free", role: "editor", actor: { type: "agent", id: "a", onBehalfOf: "u" } } as const

  test("are signed over the encoded body, in the format Auth verifies", async () => {
    const [body, signature] = (await signTicket("secret", principal, 60)).split(".")
    assert.ok(body && signature)
    assert.equal(signature, createHmac("sha256", "secret").update(body).digest("base64url"))
    assert.doesNotMatch(body, /[+/=]/)
  })

  test("carry the principal and expire", async () => {
    const [body] = (await signTicket("secret", principal, 60, 1_000_000)).split(".")
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString())
    assert.equal(decoded.exp, 1060)
    assert.equal(decoded.orgName, "Org — ñ")
    assert.deepEqual(decoded.actor, principal.actor)
  })
})
