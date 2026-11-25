# Development

You need Node 24.11.1 or newer (`nvm use`), because Alchemy requires it, and pnpm 10.

```sh
pnpm install
pnpm dev          # alchemy dev: the Worker and cells in local workerd (:1337), Vite with HMR (:5173)
pnpm typecheck
pnpm test         # starts local dev if it isn't running, then runs tests/
```

Open http://localhost:5173. Everything runs locally, with no cloud account. In dev, Settings has a **View as** switch (Owner / Viewer / Guest), and API calls accept `x-dev-as: agent` to act as an agent.

To just use it, without a clone: `npx stdartifacts serve` runs the whole app on http://127.0.0.1:4747 (Miniflare, no Cloudflare account), keeps your workspace in `~/.stdartifacts`, and opens the browser. Flags: `--port`, `--data <dir>`, `--name <your name>`, `--no-open`. From a clone: `pnpm --filter @standard-artifacts/server build`, then `pnpm cli && node apps/cli/dist/stdartifacts.mjs serve`.

Dev mode has no sign-in: anyone who can reach the server is the owner. It answers only localhost; `DEV_ALLOWED_HOSTS` (comma-separated) adds hosts, for example a tunnel. See [SECURITY.md](../SECURITY.md).

## Self-hosting with sign-in

Live mode (`AUTH_MODE=live`, the default outside dev stages) signs people in with [WorkOS](https://workos.com) AuthKit, and uses WorkOS Organizations for orgs, members, roles and invitations. This is how Standard Artifacts Cloud runs. [Architecture](architecture.md#access-model) explains the session, tickets and ids.

**In the WorkOS dashboard** (try it in the Staging environment first):

1. **Authentication.** Turn on AuthKit, with the sign-in methods you want.
2. **Redirects** (Applications → Redirects).
   - Redirect URI: `<APP_URL>/api/auth/callback`, for example `https://app.example.com/api/auth/callback`.
   - Initiate login URI (where AuthKit sends people whose sign-in didn't start in the app, such as from an invitation or a password reset): `<APP_URL>/api/auth/login`.
   - Sign-out URI: `<APP_URL>/`. Without it, signing out ends on a WorkOS error page.
3. **Roles.** Create three roles with the slugs `owner`, `editor` and `viewer`, and make `editor` the default role for new members. Without them the app falls back to WorkOS's default `admin` (owner) and `member` (editor) roles; inviting a viewer then fails with a message saying the role is missing, rather than granting more. Any other slug counts as viewer.
4. **Organizations.** Nothing to create: someone who signs in without one gets "<First name>'s workspace" as its owner. An org's plan is its metadata key `plan` (`free`, the default, or `team`).
5. **Invitations.** Owners invite from Settings → Members, and WorkOS sends the email. Its link signs the person in through AuthKit and lands them in that org. If you point the invitation link at the app instead, `<APP_URL>/?invitation_token=…` works too.

**Configuration** (in the Worker's environment; for Alchemy deploys, the shell or CI environment running `alchemy deploy`, such as GitHub environment secrets):

| Variable | |
| --- | --- |
| `TICKET_SECRET` | Secret. Signs tickets. Any long random string: `openssl rand -base64 32`. |
| `WORKOS_API_KEY` | Secret. `sk_…` from API Keys. |
| `WORKOS_CLIENT_ID` | `client_…` from API Keys. |
| `WORKOS_COOKIE_PASSWORD` | Secret. Seals the session cookie. At least 32 characters: `openssl rand -base64 32`. Changing it signs everyone out. |
| `APP_URL` | The address people use, like `https://app.example.com`. Redirect URIs are built from it. Without it, the request's own origin is used, which is wrong behind a proxy that changes the host. |

If any of these is missing in live mode, nothing falls back to dev: the sign-in screen and `/api/auth/*` say exactly what's missing, and the API refuses requests without a valid ticket or token. Serve live mode over HTTPS: the session cookie is `Secure` everywhere except plain http to localhost. On celld, set the same names in `wrangler.jsonc` (`vars`) and as secrets.

The tests run live mode without WorkOS: `tests/src/live-harness.ts` starts the built server in Miniflare against a fake WorkOS (`tests/src/fake-workos.ts`).

## Tests

`tests/` holds the API, CLI and MCP, two-browser UI and desktop suites. They run against local dev with Node's test runner and Playwright driving Google Chrome. CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` and `pnpm test` on every pull request.

```sh
pnpm test                                   # everything
cd tests && node --test src/board.*.test.ts # one area
```

## Releasing

Five packages go to npm: `@standard-artifacts/protocol`, `client`, `mcp` and `server`, and the `stdartifacts` CLI. `pnpm pack-check` packs them, installs the tarballs into a fresh project and checks that they import, run and typecheck.

1. Bump the `version` of each package that changed, in a pull request. The CLI also states its version in `apps/cli/src/main.ts`, and MCP does in `serverInfo` in `packages/mcp/src/index.ts`.
2. Merge it, then run the **Release** workflow from the Actions tab. It stages every package version that isn't on npm yet, with provenance, through npm trusted publishing, so the repo holds no npm token.
3. Approve the staged versions on npmjs.com, or with `npm stage list` and `npm stage approve <id>` (npm 12, with 2FA). Nothing is live until then.

## Notes

- Effect is pinned to 4.0.x, because `alchemy@2.0.0-beta.84` imports `effect/Crypto`, which effect 4.1 removed (see `pnpm-workspace.yaml`).
- The Alchemy stack id is still `AhComponents`, from the project's first name. Local Durable Object files are keyed by it, so renaming it starts local dev with an empty database.
- Where things live: [Architecture](architecture.md).

## Landing page

`apps/landing` is the standardartifacts.com landing page: Vite, static HTML and plain CSS, no framework. `pnpm landing` runs it; `pnpm --filter @standard-artifacts/landing build` writes `apps/landing/dist`, which any static host can serve (asset URLs are relative). `tests/src/landing.test.ts` checks the production build and needs no app running: `cd tests && node --test src/landing.test.ts`.

- **URLs:** `apps/landing/src/config.ts` holds every outside URL (site, GitHub, npm, the Cloud waitlist, license and docs links). Each export is filled into the page, the Markdown view, robots.txt and sitemap.xml as `%NAME%`. The waitlist is a mailto until there's a form.
- **Logo:** `apps/landing/src/logo.svg` is the only copy. The nav inlines it, and the favicon, touch icon and social image are built from it.
- **Markdown view:** `apps/landing/src/page.md` is the page as plain text, shown by the View Markdown toggle and published as `index.md`. Keep it in step with `index.html`.
- **Images:** `public/img` is generated by `pnpm --filter @standard-artifacts/landing images <masters folder>`. The 2-3 MB masters aren't in the repo. The product screenshots were taken from the app with demo data and show no product name.
- **Social image:** `pnpm --filter @standard-artifacts/landing og` rebuilds `src/og-base.jpg` (name and headline over the dusk painting) from `public/img`, so changing its words doesn't need the masters. Fonts come from the machine; the committed one was made on macOS.
- **Deploying:** `pnpm --filter @standard-artifacts/landing run deploy` builds it and uploads `dist/` as a static-assets Worker (`apps/landing/wrangler.jsonc`), with `CLOUDFLARE_ACCOUNT_ID` set when your login reaches more than one account. standardartifacts.com and www point at that Worker, so the hosted app needs its own host (the desktop app and docs still say standardartifacts.com). `apps/landing/redirect` is a second Worker that sends stdartifacts.com and www.stdartifacts.com there with a 301.
