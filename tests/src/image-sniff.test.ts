import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { sniffImage } from "../../packages/protocol/src/image.ts"
import { html, images, svg } from "./images.ts"

/** Unit tests for upload sniffing; they don't need the app running. */

const type = (bytes: Uint8Array) => {
  const r = sniffImage(bytes)
  return r.ok ? r.type : null
}
const concat = (...parts: Array<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe("sniffImage", () => {
  test("recognizes real PNG, JPEG, GIF and WebP files", () => {
    assert.equal(type(images.png), "image/png")
    assert.equal(type(images.jpeg), "image/jpeg")
    assert.equal(type(images.progressiveJpeg), "image/jpeg")
    assert.equal(type(images.gif), "image/gif")
    assert.equal(type(images.webp), "image/webp")
    assert.equal(type(images.webpLossless), "image/webp")
    assert.equal(type(images.webpExtended), "image/webp")
  })

  test("refuses anything else, whatever it would be labelled", () => {
    for (const bytes of [html, svg, new Uint8Array(0), new TextEncoder().encode("hi"), new Uint8Array(500)]) {
      const r = sniffImage(bytes)
      assert.equal(r.ok, false)
      assert.match(!r.ok ? r.error : "", /isn't a PNG, JPEG, GIF or WebP/)
    }
  })

  test("refuses truncated files", () => {
    for (const [name, bytes] of Object.entries(images)) {
      for (const keep of [4, 8, 16, 33, Math.floor(bytes.length / 2), bytes.length - 1]) {
        assert.equal(type(bytes.subarray(0, keep)), null, `${name} cut to ${keep} bytes`)
      }
    }
  })

  test("refuses an image signature in front of something else", () => {
    // Just a signature, then a page: the old check (signature only) let these through.
    assert.equal(type(concat(images.png.subarray(0, 8), html)), null)
    assert.equal(type(concat(new Uint8Array([0xff, 0xd8, 0xff]), html)), null)
    assert.equal(type(concat(new TextEncoder().encode("GIF89a"), html)), null)
    assert.equal(type(concat(images.webp.subarray(0, 16), html)), null)
    // A PNG header with a zero-sized image.
    const empty = images.png.slice()
    empty.fill(0, 16, 24)
    assert.equal(type(empty), null)
  })
})
