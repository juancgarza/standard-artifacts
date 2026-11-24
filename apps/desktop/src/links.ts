/** Where a URL may go. Kept free of Electron so it can be tested on its own. */

export const SCHEME = "stdartifacts"

/** The scheme from before the rename. Only `SCHEME` is registered, but a legacy link passed on the command line still opens. */
const LEGACY_SCHEME = "commonartifacts"
const isDeepLink = (url: string) => url.startsWith(`${SCHEME}:`) || url.startsWith(`${LEGACY_SCHEME}:`)

export type Destination = "in-app" | "external" | "blocked"

export function destinationOf(url: string, appOrigin: string): Destination {
  try {
    const { origin, protocol } = new URL(url)
    if (origin === appOrigin) return "in-app"
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? "external" : "blocked"
  } catch {
    return "blocked"
  }
}

/**
 * The page a `stdartifacts://doc/d_abc` link (or a legacy `commonartifacts://` one) opens, or null if it isn't one.
 *
 * Any site can launch one of these links, so only the path is used and never the
 * API: `/api/v1/share/...` would set a cookie and swap who the person is signed in as.
 */
export function deepLinkHref(url: string): string | null {
  try {
    const link = new URL(url)
    if (!isDeepLink(link.protocol)) return null
    // Resolved so dot segments can't climb into the API after the check. The base is never used.
    const page = new URL(`/${link.host}/${link.pathname}`.replace(/\/{2,}/g, "/"), "http://app")
    const path = page.pathname.length > 1 ? page.pathname.replace(/\/$/, "") : page.pathname
    if (/^\/(api|mcp)(\/|$)/i.test(path)) return null
    return `${path}${link.search}${link.hash}`
  } catch {
    return null
  }
}

export const deepLinkInArgs = (args: ReadonlyArray<string>) => args.find(isDeepLink)
