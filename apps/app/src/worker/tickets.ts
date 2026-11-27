import type { Principal } from "@standard-artifacts/protocol"

/**
 * Mint a ticket in the format `Auth` verifies:
 * `base64url(json).base64url(hmacSha256(json))`, with the signature taken over
 * the encoded body. The Worker issues these itself for sign-in, agent runs and
 * remote MCP sessions signed in with OAuth (`via: "grant"`). Keep them
 * short-lived: there's no way to revoke one.
 */
export async function signTicket(secret: string, principal: Principal, ttlSeconds: number, now = Date.now(), via?: "grant"): Promise<string> {
  const body = toB64url(new TextEncoder().encode(JSON.stringify({ ...principal, exp: Math.floor(now / 1000) + ttlSeconds, ...(via && { via }) })))
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  return `${body}.${toB64url(new Uint8Array(signature))}`
}

const toB64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
