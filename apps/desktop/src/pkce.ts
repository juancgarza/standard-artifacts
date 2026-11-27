import { createHash, randomBytes } from "node:crypto"

/** PKCE (RFC 7636, S256) for signing in through the browser. Kept free of Electron so it can be tested on its own. */

export interface Pkce {
  /** Stays in the app's memory; only its hash leaves. */
  readonly verifier: string
  /** base64url(SHA-256(verifier)). */
  readonly challenge: string
}

export const challengeFor = (verifier: string) => createHash("sha256").update(verifier).digest("base64url")

export function newPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: challengeFor(verifier) }
}
