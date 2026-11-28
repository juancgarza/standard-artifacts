import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  addServer,
  allWorkspaces,
  CLOUD_ID,
  LOCAL_ID,
  LOCAL_ORIGIN,
  parseSaved,
  partitionOf,
  screenAction,
  serializeSaved,
  serverOrigin,
  toPublic,
} from "../../apps/desktop/src/workspaces.ts"

/**
 * The desktop app's workspaces: Cloud, this computer, and self-hosted servers.
 * Which addresses it accepts, what it saves, and what the page gets to see.
 */
const CLOUD = "https://app.standardartifacts.com"
const empty = { servers: [], last: null }

describe("desktop workspaces", () => {
  test("Cloud and this computer are always there, each with its own session", () => {
    const all = allWorkspaces(CLOUD, empty)
    assert.deepEqual(
      all.map((w) => [w.id, w.kind, w.origin]),
      [
        [CLOUD_ID, "cloud", CLOUD],
        [LOCAL_ID, "local", LOCAL_ORIGIN],
      ],
    )
    assert.notEqual(partitionOf(all[0]!), partitionOf(all[1]!))
  })

  test("a typed server address: https anywhere, http only on this computer", () => {
    assert.equal(serverOrigin("artifacts.example.com"), "https://artifacts.example.com")
    assert.equal(serverOrigin("  https://artifacts.example.com/some/page?x=1 "), "https://artifacts.example.com")
    assert.equal(serverOrigin("http://localhost:4800"), "http://localhost:4800")
    assert.equal(serverOrigin("http://127.0.0.1:4800"), "http://127.0.0.1:4800")
    assert.equal(serverOrigin("http://artifacts.example.com"), null, "plain http elsewhere would send the session in the clear")
    assert.equal(serverOrigin("https://user:pw@artifacts.example.com"), null)
    for (const bad of ["", "   ", "file:///etc/passwd", "javascript:alert(1)", "ftp://x.example.com", "not a url", "data:text/html,hi"]) {
      assert.equal(serverOrigin(bad), null, bad)
    }
  })

  test("adding a server: once per address, and a built-in's address is the built-in", () => {
    const first = addServer(CLOUD, empty, "https://artifacts.example.com")
    assert.equal(first.workspace.kind, "server")
    assert.equal(first.workspace.label, "artifacts.example.com")
    const again = addServer(CLOUD, first.saved, "https://artifacts.example.com")
    assert.equal(again.workspace.id, first.workspace.id)
    assert.equal(again.saved.servers.length, 1)
    assert.equal(addServer(CLOUD, empty, CLOUD).workspace.id, CLOUD_ID)
    assert.equal(addServer(CLOUD, empty, LOCAL_ORIGIN).workspace.id, LOCAL_ID)
  })

  test("the saved file round-trips, and anything invalid in it is dropped", () => {
    const { saved } = addServer(CLOUD, empty, "https://artifacts.example.com")
    const back = parseSaved(JSON.parse(serializeSaved({ ...saved, last: LOCAL_ID })))
    assert.deepEqual(back.servers.map((s) => s.origin), ["https://artifacts.example.com"])
    assert.equal(back.last, LOCAL_ID)
    const messy = parseSaved({ servers: ["http://evil.example.com", 42, "javascript:x", "https://ok.example.com", "https://ok.example.com/again"], last: 7 })
    assert.deepEqual(messy.servers.map((s) => s.origin), ["https://ok.example.com"])
    assert.equal(messy.last, null)
    assert.deepEqual(parseSaved(null), empty)
    assert.deepEqual(parseSaved("nope"), empty)
  })

  test("the page sees ids and labels, never an address it could send back", () => {
    const { saved } = addServer(CLOUD, empty, "https://artifacts.example.com")
    for (const w of allWorkspaces(CLOUD, saved).map(toPublic)) {
      assert.ok(!JSON.stringify(w).includes("://"), JSON.stringify(w))
    }
  })

  test("the app's own screens: only their sentinel origin, and only known actions", () => {
    assert.deepEqual(screenAction("https://desktop.stdartifacts.invalid/open?workspace=local"), { type: "open", id: "local" })
    assert.deepEqual(screenAction("https://desktop.stdartifacts.invalid/add?address=artifacts.example.com"), { type: "add", address: "artifacts.example.com" })
    assert.deepEqual(screenAction("https://desktop.stdartifacts.invalid/choose"), { type: "choose" })
    assert.equal(screenAction("https://desktop.stdartifacts.invalid/delete"), null)
    assert.equal(screenAction("https://desktop.stdartifacts.invalid/open"), null)
    assert.equal(screenAction("https://app.standardartifacts.com/open?workspace=local"), null)
    assert.equal(screenAction("stdartifacts://desktop/open?workspace=local"), null)
  })
})
