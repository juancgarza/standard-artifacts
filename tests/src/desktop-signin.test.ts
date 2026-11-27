import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  DESKTOP_CODE_TTL_S,
  callbackLink,
  challengeOf,
  challengeOfState,
  codeOrg,
  desktopState,
  isChallenge,
  issueCode,
  redeemCode,
  returnPage,
  type CodeStore,
  type PendingCode,
} from "../../apps/app/src/worker/desktop-handoff.ts"
import { authCallbackCode, browserSignInUrl, deepLinkHref, isAuthLink, isSignInUrl, isSignOutUrl } from "../../apps/desktop/src/links.ts"
import { challengeFor, newPkce } from "../../apps/desktop/src/pkce.ts"

/**
 * Signing in the desktop app through the browser (RFC 8252 with PKCE): the
 * Worker's one-time codes and the app's links, without a server or Electron.
 * desktop.live.test.ts runs the same handoff through the Worker.
 */

/** The WorkspaceCell's code table, in memory, with the same take-once rule. */
function memoryStores() {
  const orgs = new Map<string, Map<string, PendingCode>>()
  const storeFor = (orgId: string): CodeStore => {
    const rows = orgs.get(orgId) ?? new Map<string, PendingCode>()
    orgs.set(orgId, rows)
    return {
      put: async (hash, pending) => void rows.set(hash, pending),
      take: async (hash) => {
        const row = rows.get(hash) ?? null
        rows.delete(hash)
        return row
      },
    }
  }
  return { orgs, storeFor }
}

const NOW = 1_800_000_000
const ORG = "org_01HXYZ0123456789ABCDEFGHJK"

async function issued(pkce = newPkce()) {
  const stores = memoryStores()
  const code = await issueCode(stores.storeFor, { orgId: ORG, challenge: pkce.challenge, sealed: "v1.sealed.session", returnTo: "/docs/d_1" }, NOW)
  return { ...stores, code, pkce }
}

describe("code exchange", () => {
  test("the right verifier gets the session and where to land, once", async () => {
    const { code, pkce, storeFor, orgs } = await issued()
    assert.equal(codeOrg(code), ORG)
    assert.equal([...orgs.get(ORG)!.keys()].some((k) => k === code), false, "only a hash of the code is stored")
    assert.deepEqual(await redeemCode(storeFor, code, pkce.verifier, NOW + 1), { ok: true, orgId: ORG, sealed: "v1.sealed.session", returnTo: "/docs/d_1" })
    assert.equal(orgs.get(ORG)!.size, 0)
  })

  test("a wrong verifier is refused, and burns the code", async () => {
    const { code, pkce, storeFor } = await issued()
    const wrong = await redeemCode(storeFor, code, newPkce().verifier, NOW + 1)
    assert.equal(wrong.ok, false)
    assert.equal(!wrong.ok && wrong.reason, "mismatch")
    const after = await redeemCode(storeFor, code, pkce.verifier, NOW + 2)
    assert.equal(!after.ok && after.reason, "unknown", "whoever caught the link got one guess")
  })

  test("a code works once", async () => {
    const { code, pkce, storeFor } = await issued()
    assert.equal((await redeemCode(storeFor, code, pkce.verifier, NOW + 1)).ok, true)
    const again = await redeemCode(storeFor, code, pkce.verifier, NOW + 2)
    assert.equal(!again.ok && again.reason, "unknown")
  })

  test("a code expires after a minute", async () => {
    const { code, pkce, storeFor } = await issued()
    const late = await redeemCode(storeFor, code, pkce.verifier, NOW + DESKTOP_CODE_TTL_S + 1)
    assert.equal(!late.ok && late.reason, "expired")
    const { code: onTime, pkce: p2, storeFor: s2 } = await issued()
    assert.equal((await redeemCode(s2, onTime, p2.verifier, NOW + DESKTOP_CODE_TTL_S)).ok, true, "the last second still counts")
  })

  test("a code nobody issued, or one shaped wrong, gets nothing", async () => {
    const { storeFor, pkce } = await issued()
    const forged = `sdc.${Buffer.from(ORG).toString("base64url")}.${"A".repeat(43)}`
    const unknown = await redeemCode(storeFor, forged, pkce.verifier, NOW)
    assert.equal(!unknown.ok && unknown.reason, "unknown")
    for (const code of [undefined, 42, "", "sdc", "sdc..x", `sdc.${Buffer.from("../x").toString("base64url")}.${"A".repeat(43)}`, `sat_00_${"a".repeat(32)}`]) {
      const r = await redeemCode(storeFor, code, pkce.verifier, NOW)
      assert.equal(!r.ok && r.reason, "malformed", String(code))
    }
    const { code } = await issued()
    for (const verifier of [undefined, "", "short", "x".repeat(129), `${"a".repeat(42)} `]) {
      const r = await redeemCode(storeFor, code, verifier, NOW)
      assert.equal(!r.ok && r.reason, "malformed", JSON.stringify(verifier))
    }
  })

  test("codes from different orgs live apart", async () => {
    const stores = memoryStores()
    const a = newPkce()
    const code = await issueCode(stores.storeFor, { orgId: "org_a", challenge: a.challenge, sealed: "s", returnTo: "/" }, NOW)
    assert.equal(stores.orgs.get("org_a")!.size, 1)
    assert.equal(stores.orgs.get("org_b"), undefined)
    assert.equal((await redeemCode(stores.storeFor, code, a.verifier, NOW)).ok, true)
  })
})

describe("PKCE", () => {
  test("the app's challenge is the one the Worker checks (S256, RFC 7636's example)", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert.equal(challengeFor(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    assert.equal(await challengeOf(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    const fresh = newPkce()
    assert.equal(await challengeOf(fresh.verifier), fresh.challenge)
    assert.ok(isChallenge(fresh.challenge))
    assert.notEqual(newPkce().verifier, fresh.verifier)
  })

  test("the challenge rides in AuthKit's state, and only a well-formed one counts", () => {
    const { challenge } = newPkce()
    assert.equal(challengeOfState(desktopState("r4nd0m", challenge)), challenge)
    for (const state of ["r4nd0m", `r4nd0m.${challenge}.x`, `.${challenge}`, "r4nd0m.short", `r4nd0m.${challenge.slice(1)}!`]) {
      assert.equal(challengeOfState(state), undefined, state)
    }
  })

  test("the page that hands the code back links to the app and leaks it nowhere", async () => {
    const res = returnPage("sdc.b3Jn.secret")
    const html = await res.text()
    assert.match(html, /href="stdartifacts:\/\/auth\/callback\?code=sdc\.b3Jn\.secret"/)
    assert.match(html, /Return to Standard Artifacts/)
    assert.equal(res.headers.get("referrer-policy"), "no-referrer")
    assert.equal(res.headers.get("cache-control"), "no-store")
    assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/)
    assert.equal(callbackLink("a b"), "stdartifacts://auth/callback?code=a%20b")
  })
})

describe("auth links in the app", () => {
  const origin = "https://app.standardartifacts.com"
  const code = `sdc.b3JnX2E.${"A".repeat(43)}`

  test("the callback link gives its code, and nothing else does", () => {
    assert.equal(authCallbackCode(`stdartifacts://auth/callback?code=${code}`), code)
    assert.equal(authCallbackCode(`stdartifacts://auth/callback/?code=${code}`), code)
    for (const url of [
      "stdartifacts://auth/callback",
      "stdartifacts://auth/callback?code=",
      "stdartifacts://auth/callback?code=short",
      `stdartifacts://auth/callback?code=${code}%3Cscript%3E`,
      `stdartifacts://auth/other?code=${code}`,
      `stdartifacts://docs/callback?code=${code}`,
      `commonartifacts://auth/callback?code=${code}`,
      `https://app.standardartifacts.com/auth/callback?code=${code}`,
      "not a url",
    ]) {
      assert.equal(authCallbackCode(url), null, url)
    }
  })

  test("auth links are told apart from pages, and pages still can't reach the API", () => {
    assert.equal(isAuthLink(`stdartifacts://auth/callback?code=${code}`), true)
    assert.equal(isAuthLink("stdartifacts://AUTH/whatever"), true)
    assert.equal(isAuthLink("stdartifacts://docs/d_1"), false)
    assert.equal(isAuthLink("https://auth/callback"), false)
    // The handoff is its own handler; deepLinkHref keeps refusing the API, including the exchange.
    assert.equal(deepLinkHref("stdartifacts://api/auth/desktop/exchange?code=x"), null)
    assert.equal(deepLinkHref("stdartifacts://api/auth/login"), null)
  })

  test("the app's sign-in goes to the browser with the challenge and only the login's own parameters", () => {
    assert.equal(isSignInUrl(`${origin}/api/auth/login?return_to=/docs/d_1`, origin), true)
    assert.equal(isSignInUrl(`${origin}/api/auth/login/`, origin), true)
    assert.equal(isSignInUrl(`${origin}/api/auth/logout`, origin), false)
    assert.equal(isSignInUrl("https://evil.test/api/auth/login", origin), false)
    assert.equal(isSignInUrl("http://app.standardartifacts.com/api/auth/login", origin), false)

    const { challenge } = newPkce()
    const out = new URL(browserSignInUrl(`${origin}/api/auth/login?return_to=%2Fdocs%2Fd_1&screen=sign-up&invitation_token=inv_1&desktop=evil&x=1`, origin, challenge))
    assert.equal(out.origin, origin)
    assert.equal(out.pathname, "/api/auth/login")
    assert.deepEqual(Object.fromEntries(out.searchParams), { return_to: "/docs/d_1", screen: "sign-up", invitation_token: "inv_1", desktop: challenge })
  })

  test("AuthKit's sign-out is recognized by its path, over https only", () => {
    assert.equal(isSignOutUrl("https://api.workos.com/user_management/sessions/logout?session_id=s&return_to=x"), true)
    assert.equal(isSignOutUrl("http://api.workos.com/user_management/sessions/logout"), false)
    assert.equal(isSignOutUrl("https://api.workos.com/user_management/authorize"), false)
    assert.equal(isSignOutUrl("javascript:alert(1)"), false)
  })
})
