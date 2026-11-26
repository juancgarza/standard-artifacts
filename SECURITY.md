# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately:

- **Preferred:** GitHub's private vulnerability reporting ("Report a vulnerability" on this repo's **Security** tab).
- **Email:** security@standardartifacts.com

Include what you found, how to reproduce it, and what an attacker could do with it. We'll acknowledge your report within 3 business days and keep you updated until it's fixed. We'll credit you in the release notes unless you'd rather not be named. Please give us a reasonable chance to fix the problem before you disclose it.

**Supported versions:** fixes land on `main` and in the latest release. The hosted service at standardartifacts.com always runs a current build.

## Security model

People and agents edit the same artifacts, and boards run HTML that someone else wrote. These are the boundaries the design relies on. A way around any of them is a vulnerability we want to hear about.

### Identity and access

- **Principals.** Every request resolves to a principal: an org, an actor (a person, an agent acting for a person, or a share-link guest) and a role (owner, editor or viewer).
  - Viewers and guests are read-only. The cell rejects their ops.
  - Agents act on behalf of a person and never have more access than that person.
- **Tickets.** In live mode, the Worker signs HMAC tickets with `TICKET_SECRET`, and every API, WebSocket and MCP request must carry a valid one (or an access token or share link, below). Tickets last 5 minutes and can't be revoked.
- **Sign-in** (live mode) goes through WorkOS AuthKit. WorkOS is the source of truth for orgs, members and roles.
  - The session is an httpOnly, SameSite=Lax, Secure, `__Host-` cookie, sealed with AES-GCM under `WORKOS_COOKIE_PASSWORD`. It holds a WorkOS refresh token and never reaches a cell.
  - The ticket is also set as a short `__Host-` cookie, but it only opens asset downloads (`<img>` URLs). API calls, sockets and MCP need the ticket sent on purpose.
  - The sign-in round trip is bound to the browser by a sealed state cookie. `return_to` is resolved against the app's origin and must stay on it; control characters and backslashes are refused.
  - Only a refresh token WorkOS refuses ends a session. Rate limits and outages keep it, and an org that asks for SSO or MFA refuses the switch without signing anyone out.
  - `/api/auth/*` POSTs are refused when their Origin is another site.
  - Live mode with missing sign-in config refuses sign-in and says why. It never falls back to dev mode.
- **Members.** Only owners invite, change roles and remove people, in the app: never with an access token. The Worker checks with WorkOS that the caller is still an owner before each change. A membership or invitation from another org reads as not found. The last owner can't be removed or demoted: role changes and removals in an org go one at a time (a lock in its WorkspaceCell), and a change that still leaves no owner is undone.
- **Access tokens** (`sat_…`) act as one person in one org. Only a SHA-256 hash is stored. The person's role is checked with WorkOS every 5 minutes, and the tokens of someone who left the org stop working. Making one needs the browser's session cookie, so a ticket alone (say, from a socket URL in a log) can't. Agents, guests and other tokens can't create tokens, invite or change members, or make share links. If WorkOS can't be reached, or live mode's config is broken, a token keeps its last-known role for an hour, then stops.
- **Isolation between orgs.** Cells are named `<org>:<artifact>`, and the org comes only from a signed ticket, a token's stored hash, or a share link's cell, so a principal can't address another org's artifact.
- **Share links** give a read-only guest access to one artifact. An owner can turn a link off.

### Dev mode (solo)

`AUTH_MODE=dev` has **no sign-in**: any request without a ticket acts as the local owner. It exists for running Standard Artifacts on your own machine. Never expose a dev-mode server to a network. If you tunnel it to test a remote MCP client, anyone with the URL can edit your workspace, so close the tunnel when you're done. Production deploys use `AUTH_MODE=live`, the default.

### HTML embeds

Embeds run arbitrary HTML and JavaScript. Each one renders in an iframe with:

- `sandbox="allow-scripts"` and **no** `allow-same-origin`. The embed gets an opaque origin and can't reach the app's DOM, cookies, storage or session. It also can't navigate the app, open popups, submit forms or show modal dialogs.
- **A Content-Security-Policy that comes first in the document:**
  - scripts and styles must be inline;
  - images may load from `https:`, `data:` and `blob:`;
  - fonts load only from `data:`;
  - there's no fetch, XHR, WebSocket, frame, worker or form action.
- `allow=""` (no powerful features) and `referrerpolicy="no-referrer"`.
- Navigation detection: an embed that navigates its own frame is replaced with a notice.

The rules are in `packages/board/src/html.ts`.

### Design frames

Design frames render in the app's own document, so their allowlists are the boundary (`packages/protocol/src/design.ts`).

- **What's allowed:**
  - 26 tags;
  - attributes allowed per tag;
  - CSS checked property by property: no `var()`, `expression()`, `@import`, `position: fixed`, comments or escapes;
  - URLs only over https, or data: for images.
- **Where it's checked:** the cell's reducer validates every frame, and the renderer filters it again.

### Agents and untrusted content

- **Agents can't wake agents.** Only a person's edit can file an `@claude` request. Agent writes never do, so agents can't trigger each other in loops.
- **Content is data, not instructions.** The agent skill and the runner's prompt treat anything read from a page, cell or note as data. Prompt injection is still the main risk for any agent that reads untrusted content: it can steer what that agent writes.
- **Hosted runs** (`apps/runner`, Cloudflare only) execute in a container with **no internet access and no secrets**.
  - Everything the container sends goes through a Worker (`runner-outbound.ts`), which adds the model API key and a short-lived ticket scoped to the person who asked.
  - Web access is GET-only, with credentials stripped, and every host is logged.
  - Runs are limited by budget, turns, wall-clock time and runs per day.

### Desktop app

The renderer is sandboxed with context isolation. The page can only *receive* commands from the main process; there are no `ipcMain` handlers, so the page can't reach the OS. A permission request is granted only if it's on a short allowlist and comes from the app's own main frame. Other sites open in the system browser.

## Known limitations

- **Changes take minutes to land.** A ticket can't be revoked, and the session's WorkOS access token is reused until it nearly expires. A removed member or a lowered role reaches new tickets within about 5 minutes, and old tickets expire within 5 more. A socket that's already open stays open until it disconnects.
- **Access tokens don't expire.** They last until revoked, or until their owner leaves the org.
- **https images load in viewers' browsers.** Embeds and design frames can load images over `https:`. Whoever controls an image's URL can see who viewed it and when, and a URL can carry data in its path.
- **GET requests can carry data.** A hosted run's GET-only web access limits a prompt-injected page, but a URL can still carry data out.
- **The remote MCP endpoint** (`/mcp`) uses bearer tickets. OAuth for ChatGPT and Claude connectors isn't built yet.

## Out of scope

- Anything that needs dev mode exposed to a network.
- Self-XSS, or attacks that require a compromised device.
- Missing security headers with no demonstrated impact.
- Rate limiting and volumetric denial of service against the hosted service.
- Vulnerabilities in third-party dependencies without a working path through Standard Artifacts. Report those upstream.
