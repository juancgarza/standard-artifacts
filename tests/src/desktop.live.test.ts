import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { SESSION_COOKIE, STATE_COOKIE } from "../../apps/app/src/worker/session.ts"
import { newPkce } from "../../apps/desktop/src/pkce.ts"
import { startLive, Visitor, type LiveApp } from "./live-harness.ts"

/**
 * The desktop app signing in through the person's browser (RFC 8252 with
 * PKCE), against the Worker in live mode and a fake WorkOS: the browser gets a
 * page that hands a one-time code to the app, and the app trades it, with its
 * verifier, for the session cookie. desktop-signin.test.ts covers expiry and
 * the app's links.
 */

let app: LiveApp
before(async () => {
  app = await startLive()
})
after(async () => {
  await app?.close()
})

/** The browser half: login with the app's challenge, through the fake AuthKit, to the "Return to Standard Artifacts" page. Returns the code. */
async function browserSignIn(browser: Visitor, challenge: string, returnTo = "/docs/d_1") {
  app.fake.signInAs(browser.email)
  const login = await browser.fetch(`/api/auth/login?${new URLSearchParams({ return_to: returnTo, desktop: challenge })}`)
  assert.equal(login.status, 302)
  const authorize = new URL(login.headers.get("location")!)
  assert.ok(authorize.searchParams.get("state")!.endsWith(`.${challenge}`), "the challenge rides in AuthKit's state")
  const hosted = await browser.fetch(authorize.toString())
  const callback = await browser.fetch(hosted.headers.get("location")!)
  return { callback, html: callback.status === 200 ? await callback.text() : "" }
}

const codeIn = (html: string) => {
  const link = /href="(stdartifacts:\/\/auth\/callback\?code=[^"]+)"/.exec(html)?.[1]
  assert.ok(link, "the page links back to the app")
  return new URL(link.replace(/&#38;/g, "&")).searchParams.get("code")!
}

/** The app half: POST the code and verifier from the app's own session (a cookie jar of its own), as Electron's session.fetch does. */
const exchange = (desktop: Visitor, body: unknown, contentType = "application/json") =>
  desktop.fetch("/api/auth/desktop/exchange", { method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) })

describe("desktop sign-in", () => {
  test("the browser gets a code, not a session; the app trades it with its verifier for the session cookie", async () => {
    const pkce = newPkce()
    const browser = new Visitor(app, "desk@example.test")
    const { callback, html } = await browserSignIn(browser, pkce.challenge)
    assert.equal(callback.status, 200)
    assert.match(callback.headers.get("content-type")!, /text\/html/)
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer")
    assert.equal(browser.cookies.get(SESSION_COOKIE), undefined, "the browser isn't signed in by a desktop sign-in")
    assert.equal(browser.cookies.get(STATE_COOKIE), undefined, "the sign-in state is used up")
    const code = codeIn(html)

    const desktop = new Visitor(app, browser.email)
    const res = await exchange(desktop, { code, verifier: pkce.verifier })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { returnTo: "/docs/d_1" })
    assert.match(res.headers.getSetCookie().join("\n"), new RegExp(`${SESSION_COOKIE}=v1\\..*HttpOnly.*SameSite=Lax`))
    const s = await desktop.session()
    assert.equal(s.status, 200)
    assert.equal(s.body.signedIn, true)
    assert.equal(s.body.user.email, "desk@example.test")
  })

  test("a wrong verifier is refused, and the code is spent", async () => {
    const pkce = newPkce()
    const browser = new Visitor(app, "wrong@example.test")
    const code = codeIn((await browserSignIn(browser, pkce.challenge)).html)
    const thief = new Visitor(app, "thief@example.test")
    const stolen = await exchange(thief, { code, verifier: newPkce().verifier })
    assert.equal(stolen.status, 400)
    assert.equal((await stolen.json()).reason, "mismatch")
    assert.equal(thief.cookies.get(SESSION_COOKIE), undefined)
    const late = await exchange(new Visitor(app, browser.email), { code, verifier: pkce.verifier })
    assert.equal(late.status, 400, "one guess burns it")
  })

  test("a code works once", async () => {
    const pkce = newPkce()
    const browser = new Visitor(app, "once@example.test")
    const code = codeIn((await browserSignIn(browser, pkce.challenge)).html)
    assert.equal((await exchange(new Visitor(app, browser.email), { code, verifier: pkce.verifier })).status, 200)
    const again = await exchange(new Visitor(app, browser.email), { code, verifier: pkce.verifier })
    assert.equal(again.status, 400)
    assert.equal((await again.json()).reason, "unknown")
  })

  test("a code with no sign-in behind it, a malformed one, or a form post gets nothing", async () => {
    const { verifier } = newPkce()
    const desktop = new Visitor(app, "none@example.test")
    const forged = await exchange(desktop, { code: `sdc.${Buffer.from("org_nobody").toString("base64url")}.${"A".repeat(43)}`, verifier })
    assert.equal(forged.status, 400)
    assert.equal((await forged.json()).reason, "unknown")
    assert.equal((await exchange(desktop, { code: "nope", verifier })).status, 400)
    assert.equal((await exchange(desktop, "not json")).status, 400)
    assert.equal((await exchange(desktop, "code=x&verifier=y", "application/x-www-form-urlencoded")).status, 415, "a form on another site can't post here")
    const crossSite = await desktop.fetch("/api/auth/desktop/exchange", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: "{}" })
    assert.equal(crossSite.status, 403)
    assert.equal(desktop.cookies.get(SESSION_COOKIE), undefined)
  })

  test("the challenge can't be swapped on the way back, and a malformed one is refused up front", async () => {
    const pkce = newPkce()
    const browser = new Visitor(app, "swap@example.test")
    app.fake.signInAs(browser.email)
    const login = await browser.fetch(`/api/auth/login?desktop=${pkce.challenge}`)
    const hosted = await browser.fetch(login.headers.get("location")!)
    const back = new URL(hosted.headers.get("location")!)
    back.searchParams.set("state", back.searchParams.get("state")!.replace(pkce.challenge, newPkce().challenge))
    assert.equal((await browser.fetch(back.toString())).status, 400)

    assert.equal((await browser.fetch("/api/auth/login?desktop=too-short")).status, 400)
  })

  test("a browser sign-in in the same browser still signs the browser in", async () => {
    const browser = new Visitor(app, "both@example.test")
    await browserSignIn(browser, newPkce().challenge)
    assert.equal(await browser.signIn({ returnTo: "/settings" }), "/settings")
    assert.ok(browser.cookies.get(SESSION_COOKIE))
  })
})
