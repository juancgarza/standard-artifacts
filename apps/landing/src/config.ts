/**
 * Every outside URL on the page. The build fills each export into the HTML,
 * the Markdown view, robots.txt and sitemap.xml as `%NAME%`, so this is the
 * only place to edit. See "Landing page" in docs/development.md.
 */

/** The landing page's own address: canonical, Open Graph, sitemap. No trailing slash. */
export const SITE_URL = "https://standardartifacts.com"

/** The source repository: "View on GitHub", the docs and license links. No trailing slash. */
export const GITHUB_URL = "https://github.com/juancgarza/standard-artifacts"

/** The CLI on npm, which `npx stdartifacts serve` runs. */
export const NPM_URL = "https://www.npmjs.com/package/stdartifacts"

/** Where "Join the waitlist" for Cloud goes. A mailto until there's a real waitlist form. */
export const WAITLIST_URL = "mailto:hello@standardartifacts.com?subject=Standard%20Artifacts%20Cloud%20waitlist"

/** Why the server is AGPL and the clients Apache-2.0. */
export const LICENSING_URL = `${GITHUB_URL}/blob/main/LICENSING.md`

/** How to reach a workspace from ChatGPT or Claude connectors today (a dev tunnel). */
export const REMOTE_MCP_DOCS_URL = `${GITHUB_URL}/blob/main/docs/cli-and-mcp.md#remote-mcp-codex-chatgpt`
