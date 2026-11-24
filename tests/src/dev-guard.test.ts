import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { devGuard } from "../../apps/app/src/worker/dev-guard.ts"

/** The dev guard on its own (no server needed): dev mode answers this machine only. */

const req = (url: string, origin?: string) => new Request(url, origin ? { headers: { origin } } : {})
const dev = { AUTH_MODE: "dev" }

describe("dev guard", () => {
  test("allows localhost, 127.0.0.1 and [::1] on any port", () => {
    for (const host of ["localhost", "localhost:5173", "127.0.0.1:1337", "127.0.0.1:4747", "[::1]:4747", "LOCALHOST:80"]) {
      assert.equal(devGuard(req(`http://${host}/api/v1/workspace`), dev), undefined, host)
    }
    assert.equal(devGuard(req("http://localhost:1337/api/v1/workspace", "http://localhost:5173"), dev), undefined, "Vite proxy with changeOrigin")
    assert.equal(devGuard(req("http://127.0.0.1:4747/mcp", "http://[::1]:4747"), dev), undefined)
  })

  test("rejects a foreign Host with a 403 and a reason", async () => {
    for (const url of ["http://evil.example/api/v1/workspace", "https://abc.trycloudflare.com/mcp", "http://192.168.1.20:4747/api/v1/workspace", "http://localhost.evil.example/"]) {
      const res = devGuard(req(url), dev)
      assert.equal(res?.status, 403, url)
    }
    assert.match(await devGuard(req("http://evil.example/"), dev)!.text(), /only answers requests from localhost/)
  })

  test("rejects a foreign Origin even on a local Host", () => {
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example", "not a url"]) {
      assert.equal(devGuard(req("http://127.0.0.1:4747/api/v1/workspace", origin), dev)?.status, 403, origin)
    }
  })

  test("DEV_ALLOWED_HOSTS lets listed hosts in, and only those", () => {
    const env = { ...dev, DEV_ALLOWED_HOSTS: " abc.trycloudflare.com , other.test:8443" }
    assert.equal(devGuard(req("https://abc.trycloudflare.com/mcp"), env), undefined)
    assert.equal(devGuard(req("https://abc.trycloudflare.com/mcp", "https://abc.trycloudflare.com"), env), undefined)
    assert.equal(devGuard(req("https://other.test:8443/api/v1/workspace"), env), undefined, "host with port")
    assert.equal(devGuard(req("https://other.test:9000/api/v1/workspace"), env)?.status, 403, "listed with a port, so other ports stay out")
    assert.equal(devGuard(req("https://xyz.trycloudflare.com/mcp"), env)?.status, 403)
    assert.equal(devGuard(req("https://abc.trycloudflare.com/mcp", "https://evil.example"), env)?.status, 403)
  })

  test("live mode is unaffected", () => {
    for (const env of [{ AUTH_MODE: "live" }, {}]) {
      assert.equal(devGuard(req("https://standardartifacts.example/api/v1/workspace", "https://elsewhere.example"), env), undefined)
    }
  })
})
