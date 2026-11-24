/** Image types boards and docs accept for uploads (stored in the artifact's own cell). */
export const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
export type ImageType = (typeof imageTypes)[number]
/** Cloudflare's SQLite caps a row at 2 MB; stay under it. */
export const maxImageBytes = 1_900_000

export type SniffedImage = { readonly ok: true; readonly type: ImageType } | { readonly ok: false; readonly error: string }

const notImage = { ok: false, error: "The file isn't a PNG, JPEG, GIF or WebP image" } as const
const incomplete = (name: string) => ({ ok: false, error: `The ${name} file is incomplete or damaged` }) as const

const ascii = (b: Uint8Array, at: number, text: string) => {
  if (at + text.length > b.length) return false
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false
  return true
}
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** The last 12 bytes of every PNG: a zero-length IEND chunk and its fixed CRC. */
const PNG_IEND = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]

const png = (b: Uint8Array): SniffedImage => {
  // Signature, then IHDR (length 13, nonzero width and height), and IEND at the very end.
  if (b.length < PNG_SIGNATURE.length + 25 + PNG_IEND.length) return incomplete("PNG")
  if (u32be(b, 8) !== 13 || !ascii(b, 12, "IHDR") || u32be(b, 16) === 0 || u32be(b, 20) === 0) return incomplete("PNG")
  const end = b.length - PNG_IEND.length
  if (!PNG_IEND.every((v, i) => b[end + i] === v)) return incomplete("PNG")
  return { ok: true, type: "image/png" }
}

const jpeg = (b: Uint8Array): SniffedImage => {
  // Walk the marker segments after SOI to the start of scan, then look for EOI after it.
  let at = 2
  let frame = false
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return incomplete("JPEG")
    const marker = b[at + 1]!
    if (marker === 0xff) {
      at++ // fill byte
      continue
    }
    const length = (b[at + 2]! << 8) | b[at + 3]!
    if (length < 2 || at + 2 + length > b.length) return incomplete("JPEG")
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) frame = true
    if (marker === 0xda) {
      if (!frame) return incomplete("JPEG")
      for (let i = b.length - 2; i >= at + 2 + length; i--) if (b[i] === 0xff && b[i + 1] === 0xd9) return { ok: true, type: "image/jpeg" }
      return incomplete("JPEG")
    }
    at += 2 + length
  }
  return incomplete("JPEG")
}

const gif = (b: Uint8Array): SniffedImage => {
  // Header and logical screen descriptor (13 bytes), at least one more byte, and the 0x3B trailer.
  if (b.length < 14 || b[b.length - 1] !== 0x3b) return incomplete("GIF")
  return { ok: true, type: "image/gif" }
}

const webp = (b: Uint8Array): SniffedImage => {
  // RIFF size covers everything after its first 8 bytes, and the chunks after "WEBP" fill it exactly.
  // The first chunk is VP8 (with its frame start code), VP8L (with its signature byte) or VP8X.
  const end = b.length >= 20 ? 8 + u32le(b, 4) : 0
  if (end < 20 || end > b.length) return incomplete("WebP")
  const vp8 = ascii(b, 12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a
  const vp8l = ascii(b, 12, "VP8L") && b[20] === 0x2f
  if (!vp8 && !vp8l && !ascii(b, 12, "VP8X")) return incomplete("WebP")
  let at = 12
  while (at + 8 <= end) at += 8 + u32le(b, at + 4) + (u32le(b, at + 4) & 1)
  if (at !== end) return incomplete("WebP")
  return { ok: true, type: "image/webp" }
}

/**
 * What an upload really is, read from its bytes rather than its declared type.
 * Only PNG, JPEG, GIF and WebP pass, and only when their structure is complete
 * (a header with no image data, or a file cut off partway, is refused).
 */
export const sniffImage = (bytes: Uint8Array): SniffedImage => {
  const b = bytes
  if (PNG_SIGNATURE.every((v, i) => b[i] === v)) return png(b)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b)
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return gif(b)
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return webp(b)
  return notImage
}
