/**
 * AUTH_MODE=dev turns every ticketless request into the workspace owner, so a
 * dev server must only answer this machine. This rejects any request whose
 * Host, or Origin when there is one, isn't localhost, 127.0.0.1 or [::1] (any
 * port). That also stops DNS rebinding and other sites' pages from calling a
 * local server through the browser.
 *
 * DEV_ALLOWED_HOSTS (comma-separated hostnames, optionally with a port) is the
 * escape hatch, e.g. a cloudflared tunnel for testing ChatGPT. Whoever reaches
 * an allowed host gets the workspace as its owner.
 *
 * Live mode (tickets) is unaffected. No imports, so tests can load it directly.
 */

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"])

export interface DevGuardEnv {
  readonly AUTH_MODE?: string | undefined
  readonly DEV_ALLOWED_HOSTS?: string | undefined
}

/** A 403 when a dev-mode request comes from somewhere other than this machine; otherwise undefined. */
export function devGuard(request: Request, env: DevGuardEnv): Response | undefined {
  if (env.AUTH_MODE !== "dev") return undefined
  const allowed = (env.DEV_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  const ok = (url: URL) => LOCAL.has(url.hostname) || allowed.includes(url.hostname) || allowed.includes(url.host)

  const origin = request.headers.get("origin")
  if (!ok(new URL(request.url)) || (origin !== null && !isOkOrigin(origin, ok))) {
    return new Response(
      "This dev server has no sign-in, so it only answers requests from localhost; add the host to DEV_ALLOWED_HOSTS to allow it.\n",
      { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
    )
  }
  return undefined
}

/** "null" (sandboxed frames, file:) and anything unparsable count as foreign. */
function isOkOrigin(origin: string, ok: (url: URL) => boolean): boolean {
  try {
    return ok(new URL(origin))
  } catch {
    return false
  }
}
