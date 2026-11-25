import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { API, BASE, call } from "./harness.ts"

/** A dev server (`pnpm dev`, `stdartifacts serve`) has no sign-in, and adding sign-in mustn't change that. */

describe("dev mode has no sign-in", () => {
  test("the session endpoint says dev, login goes home, and requests are the local owner", async () => {
    const ticket = await fetch(`${BASE}/api/auth/ticket`, { method: "POST" })
    assert.equal(ticket.status, 200)
    assert.deepEqual(await ticket.json(), { mode: "dev" })
    const login = await fetch(`${BASE}/api/auth/login`, { redirect: "manual" })
    assert.equal(login.status, 302)
    assert.equal(login.headers.get("location"), "/")
    const { body } = await call("GET", "/workspace")
    assert.equal(body.authMode, "dev")
    assert.equal(body.principal.role, "owner")
    assert.equal(body.principal.actor.id, "usr_dev")
  })

  test("there are no accounts to manage", async () => {
    const members = await call("GET", "/org/members")
    assert.equal(members.status, 503)
    assert.equal(members.body._tag, "Unavailable")
    assert.equal((await call("POST", "/org/invitations", { email: "a@example.test", role: "viewer" })).status, 503)
  })

  test("access tokens work against a dev server too, and revoking one stops it", async () => {
    const made = await call("POST", "/tokens", { name: "e2e dev token" })
    assert.equal(made.status, 200, JSON.stringify(made.body))
    try {
      const res = await fetch(`${API}/workspace`, { headers: { authorization: `Bearer ${made.body.token}` } })
      assert.equal(res.status, 200)
      assert.equal((await res.json()).principal.actor.id, "usr_dev")
      // Guests and agents have no tokens of their own.
      assert.equal((await call("GET", "/tokens", undefined, "agent")).status, 403)
      assert.equal((await call("GET", "/tokens", undefined, "guest")).status, 403)
    } finally {
      assert.equal((await call("DELETE", `/tokens/${made.body.id}`)).status, 204)
    }
    assert.equal((await fetch(`${API}/workspace`, { headers: { authorization: `Bearer ${made.body.token}` } })).status, 401)
  })
})
