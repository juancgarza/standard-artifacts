/**
 * What a hosted agent run may reach, and with whose credentials. A run's
 * container has no internet and holds no secrets: every request it makes comes
 * here first, and this is where the Anthropic key and the org's ticket get added.
 *
 *   standard-artifacts.internal         this app, called in-process, as the run's agent
 *   api.anthropic.com   the model, with our key (HTTPS only)
 *   anything else       the public web, read-only and with credentials removed
 *
 * The read-only rule makes it harder for a prompt-injected page to get workspace
 * content posted somewhere. It doesn't rule that out: a GET can carry data in its
 * URL, which is why these requests are logged.
 */

export const appHost = "standard-artifacts.internal"
const anthropicHost = "api.anthropic.com"

const credentialHeaders = ["authorization", "cookie", "x-api-key", "x-dev-as"]

export type Outbound =
  | { readonly to: "app"; readonly request: Request }
  | { readonly to: "anthropic"; readonly request: Request }
  | { readonly to: "web"; readonly request: Request }
  | { readonly to: "denied"; readonly reason: string }

function withHeaders(request: Request, set: Record<string, string>) {
  const headers = new Headers(request.headers)
  for (const name of credentialHeaders) headers.delete(name)
  for (const [name, value] of Object.entries(set)) headers.set(name, value)
  return new Request(request, { headers })
}

export function routeOutbound(request: Request, secrets: { readonly ticket: string; readonly anthropicKey: string }): Outbound {
  const url = new URL(request.url)
  if (url.hostname === appHost) return { to: "app", request: withHeaders(request, { authorization: `Bearer ${secrets.ticket}` }) }
  if (url.hostname === anthropicHost) {
    if (url.protocol !== "https:") return { to: "denied", reason: "The model API is HTTPS only" }
    return { to: "anthropic", request: withHeaders(request, { "x-api-key": secrets.anthropicKey }) }
  }
  if (request.method !== "GET" && request.method !== "HEAD") return { to: "denied", reason: `${request.method} to ${url.hostname} isn't allowed: the web is read-only for agents` }
  return { to: "web", request: withHeaders(request, {}) }
}
