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
4. **Organizations.** Nothing to create: someone who signs in without one gets "<First name>'s workspace" as its owner. An org's plan is its metadata key `plan` (`free`, the default, or `team`). Without billing configured, set it by hand; with billing, Stripe's webhook writes it (see [Billing](#billing-cloud)).
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

## Billing (Cloud)

Standard Artifacts Cloud bills with [Stripe](https://stripe.com). The rules live in `apps/app/src/worker/plans.ts`, the Stripe calls in `stripe.ts` and the service in `billing.ts`; [Architecture](architecture.md#access-model) has the model.

- **Free:** one human edits (the owner), plus unlimited agents and read-only share links.
- **Team:** $10 per seat a month billed annually, $12 monthly. A seat is an Owner or an Editor; viewers, agents and access tokens are free.
- **Hosted `@claude` runs** come with Team. A trial includes 25. Your own agent (`stdartifacts agent serve`) works on every plan.
- **Trial:** 14 days of Team with no card, once per workspace. Without a card by the end, the subscription pauses: Free limits apply (Editors read only) and nothing is deleted.

**Billing is off unless all four Stripe settings are set**, along with sign-in. With none of them (Solo, `stdartifacts serve`, dev, self-hosting), nothing changes: plans come from the `plan` metadata key, nothing is gated, and Settings has no Billing section. With only some of them, billing stays off and the Worker logs what's missing.

| Variable | |
| --- | --- |
| `STRIPE_SECRET_KEY` | Secret. `sk_…` (or a restricted `rk_…` with write access to Customers, Subscriptions, Checkout Sessions and Customer portal). |
| `STRIPE_WEBHOOK_SECRET` | Secret. The webhook endpoint's signing secret, `whsec_…`. |
| `STRIPE_PRICE_MONTHLY` | The Team monthly price id, per seat. |
| `STRIPE_PRICE_ANNUAL` | The Team annual price id, per seat. |

**Setting up Stripe.** `scripts/stripe-setup.mjs` makes everything, and running it again finds what's there:

```sh
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs --app-url https://staging.standardartifacts.com --out stripe-staging.env
```

It creates the "Standard Artifacts Team" product, its two prices by lookup key (`sa_team_monthly`, `sa_team_annual`), a customer portal configuration (switch between monthly and annual, change seats, cancel, update the payment method, see invoices), and a webhook endpoint at `<app-url>/api/billing/webhook`. The price ids and the signing secret go to the `--out` file (mode 600), or to stdout with `--print-secrets`. It refuses a live key unless you pass `--live`. Stripe shows a webhook's signing secret only once, so a second run doesn't have it: `--rotate-webhook` recreates the endpoint and hands over a new one. Delete the `.env` file once its values are in the GitHub environment.

**How it works.**

- *Checkout and the portal.* Owners start Team from Settings → Billing: Stripe Checkout in subscription mode, for as many seats as there are Owners and Editors. The first time it comes with the trial and asks for no card. After that, Manage billing opens Stripe's customer portal.
- *The webhook* (`POST /api/billing/webhook`) checks Stripe's signature (HMAC-SHA256 with Web Crypto, five minutes' tolerance, any of several `v1` signatures). It then lists the customer's subscriptions afresh and mirrors the current one into the WorkOS organization's metadata (`plan`, `seats`, `billingStatus`, `billingInterval`, `trialEndsAt`, `stripeCustomerId`, `stripeSubscriptionId`) and into the org's WorkspaceCell. Writing current state rather than the event's change makes retries and out-of-order events harmless. If anything fails after the signature checks out, it answers 500 and Stripe retries.
- *Fresh plans.* Tickets, access tokens, hosted runs and share links read the plan from the WorkspaceCell, so an upgrade or a lapse shows on the next ticket without signing in again.
- *Seats.* Inviting, promoting or removing an Owner or Editor, and someone accepting an invitation, updates the subscription's quantity, prorated. A pending invitation isn't a seat yet.
- *Hosted @claude runs* are for Team that's active, or trialing, which gets 25 in all. On Free, past due, paused or canceled, a mention is still filed for the person's own agent (`stdartifacts agent serve`), and says why the hosted runner didn't take it. See [Hosted runs](agents.md#hosted-runs).
- *Enforcement.* On Free, and while Team is past due or paused, inviting or promoting an Editor or Owner answers `UpgradeRequired` (402), which the app shows as an upgrade prompt. Editors' tickets and tokens act as viewer until it's fixed. Owners keep editing, so they can fix it.

**Testing.** Unit and live tests use a fake Stripe (`tests/src/fake-stripe.ts`), with no keys: `cd tests && node --test src/billing*.test.ts src/stripe-setup.test.ts` (after `pnpm --filter @standard-artifacts/server build`). To try the real thing on staging, run the setup script with a test-mode key, set the four values in the `staging` environment, deploy, and check out with Stripe's test card `4242 4242 4242 4242`. `stripe listen --forward-to localhost:<port>/api/billing/webhook` forwards test events to a local live-mode server.

## Tests

`tests/` holds the API, CLI and MCP, two-browser UI and desktop suites. They run against local dev with Node's test runner and Playwright driving Google Chrome. CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` and `pnpm test` on every pull request.

```sh
pnpm test                                   # everything
cd tests && node --test src/board.*.test.ts # one area
```

## Smoke test

`pnpm smoke [url]` checks a hosted server (staging, prod, or any live-mode deploy) end to end, with an access token from Settings → Access tokens: auth (no token, garbage and forged tokens, and that a token can't mint tokens, manage members or make share links), create/write/read/delete for each kind, live sync on a room socket, remote MCP over HTTP and `stdartifacts mcp` over stdio, image assets, and a hosted `@claude` run. It prints one PASS, FAIL or SKIP line per check with its time, and exits non-zero if any check fails.

```sh
SMOKE_URL=https://staging.standardartifacts.com SMOKE_TOKEN=sat_… pnpm smoke
```

- **Config.** `SMOKE_URL` and `SMOKE_TOKEN` come from the environment, or from `.env.local` in the repo root (gitignored). The URL argument overrides `SMOKE_URL`. The token is never printed.
- **What it leaves behind.** Nothing. Everything it makes is titled `smoke-<timestamp> …` and goes in a `smoke` folder. It's all deleted at the end, even after a failure or Ctrl-C, and the last check confirms the workspace no longer lists any of it. Leftovers of a killed run that are over an hour old are swept up on the next run. Deleting an artifact deletes its mentions too.
- **The agent run** spends model credit and takes a couple of minutes, because the container starts cold. `SMOKE_SKIP_AGENT=1` skips it, and `SMOKE_AGENT_TIMEOUT_MS` (default 6 minutes) sets how long to wait. When the run fails, the check prints the error the run reported.
- **stdio MCP** uses `apps/cli/dist/stdartifacts.mjs`, and builds it (`pnpm cli`) if it's missing.
- **Not covered.** Revoking a token, because tokens are only made from a signed-in browser session, never with another token. Browser tickets (`?ticket=`), which need that session too: sockets are opened with the access token as a bearer header instead.

## Releasing

Five packages go to npm: `@standard-artifacts/protocol`, `client`, `mcp` and `server`, and the `stdartifacts` CLI. `pnpm pack-check` packs them, installs the tarballs into a fresh project and checks that they import, run and typecheck.

1. Bump the `version` of each package that changed, in a pull request. The CLI also states its version in `apps/cli/src/main.ts`, and MCP does in `serverInfo` in `packages/mcp/src/index.ts`.
2. Merge it, then run the **Release** workflow from the Actions tab. It stages every package version that isn't on npm yet, with provenance, through npm trusted publishing, so the repo holds no npm token.
3. Approve the staged versions on npmjs.com, or with `npm stage list` and `npm stage approve <id>` (npm 12, with 2FA). Nothing is live until then.

## Deploying Cloud

Standard Artifacts Cloud is this repo, deployed by Alchemy (`apps/app/alchemy.run.ts`) to Cloudflare from `.github/workflows/deploy.yml`. Nothing about it is secret except the values in the GitHub environments.

| Stage | Where | Auth | Deploy state |
|---|---|---|---|
| `dev*` (`pnpm dev` uses `dev_$USER`) | localhost | `AUTH_MODE=dev`, no sign-in | `apps/app/.alchemy`, on your machine |
| `staging` | https://staging.standardartifacts.com, on every push to `main` | `live` | Cloudflare State Store |
| `prod` | https://app.standardartifacts.com, when you run **Deploy** from the Actions tab | `live` | Cloudflare State Store |

Every non-dev stage gets `AUTH_MODE=live` and hosted agent runs (`RunnerCell`, a Cloudflare Container built from `apps/runner/Dockerfile`, so deploying needs Docker). Any other non-dev stage, such as `live_$USER` (what `alchemy deploy` picks without `--stage`), gets a workers.dev URL instead of a domain. Containers need the Workers Paid plan.

**Domains.** `staging` and `prod` set the Worker's `domain` (in `hostedDomain`), so Cloudflare attaches a Workers custom domain and creates its DNS record and certificate. Don't create those DNS records yourself: an existing record on the hostname makes the attach fail. The standardartifacts.com zone must be in the account you deploy to (the one that also serves the landing page). workers.dev and version preview URLs are off for both stages, so each has one origin.

**Deploy state.** Alchemy's state holds each resource's ids. Hosted Workers have fixed names, `standard-artifacts-staging` and `standard-artifacts-prod` (set in `alchemy.run.ts`), and their Durable Object namespaces hang off them; never rename one, or the app starts over with empty Durable Objects. If the state is lost, the next deploy no longer knows it owns that Worker, so recover the state rather than redeploying blind. Dev stages keep state in `apps/app/.alchemy`, as before. Every other stage uses `Cloudflare.state()`: a Worker named `alchemy-state-store` on the account's workers.dev subdomain, which keeps state in a Durable Object, encrypted with a key that lives in the account's Secrets Store next to its bearer token. The deploy workflow passes `--yes`, so the first deploy creates the store and later Alchemy upgrades update it. To look at it, with the token and account id in your environment: `cd apps/app && pnpm exec alchemy state list --backend cloudflare -r`. Don't tear it down while a stage is deployed. Outside CI, even `alchemy plan` creates the store if it's missing.

### Cloudflare API token

In the Cloudflare dashboard, on the account that holds standardartifacts.com: **My Profile → API Tokens → Create Token → Custom token**, with exactly these permissions:

| Scope | Permission | Why |
|---|---|---|
| Account | Workers Scripts: Edit | upload the Worker, its assets and Durable Objects, attach the custom domain, run the state store |
| Account | Containers: Edit | push the runner image and create its container application |
| Account | Secrets Store: Edit | the state store's bearer token and encryption key |
| Zone | Zone: Read | find the standardartifacts.com zone for the custom domain |

Account resources: include only that account. Zone resources: include only standardartifacts.com. Leave IP filtering off (GitHub's runners have no fixed addresses). `CLOUDFLARE_ACCOUNT_ID` is on the account's Workers overview page.

### GitHub environments and secrets

In the repo, **Settings → Environments**, create `staging` and `production`:

- **production:** turn on **Required reviewers** (yourself), and under **Deployment branches and tags** choose **Selected branches** and add `main`.
- **staging:** **Selected branches**, `main`.

Give each environment its own values. Never reuse `TICKET_SECRET` or `WORKOS_COOKIE_PASSWORD` between staging and prod.

| Secret | Needed | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | yes | the token above (one token can serve both) |
| `CLOUDFLARE_ACCOUNT_ID` | yes | |
| `TICKET_SECRET` | yes | signs the HMAC tickets the cells check: `openssl rand -base64 48` |
| `WORKOS_API_KEY` | for sign-in | from the WorkOS environment (staging and production are separate WorkOS environments) |
| `WORKOS_CLIENT_ID` | for sign-in | |
| `WORKOS_COOKIE_PASSWORD` | for sign-in | encrypts the session cookie, 32 characters or more: `openssl rand -base64 48` |
| `ANTHROPIC_API_KEY` | for hosted runs | without it, `@claude` mentions wait for a `stdartifacts agent serve` |
| `TURBOPUFFER_API_KEY`, `TURBOPUFFER_URL` | optional | content search; without them search matches titles |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | for billing | test-mode keys on staging, live ones on production; see [Billing](#billing-cloud). Without all four Stripe values, billing is off |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL` | for billing | the price ids `scripts/stripe-setup.mjs` writes |

The workflow sets `APP_URL` itself, to the stage's URL. The deploy job is the only one that sees these secrets. The workflow never runs on pull requests, deploys only from `main` in this repository, and doesn't run in forks.

### First deploy

1. Create the token, the two environments and their secrets, as above. Check that the account has a workers.dev subdomain (Workers overview; it's set when the first Worker deploys) and the Workers Paid plan.
2. Merge to `main`. The **Deploy** workflow typechecks, then deploys `staging`: it creates the state store, builds and pushes the runner image, deploys the Worker and attaches staging.standardartifacts.com. The custom domain's certificate can take a few minutes. Open https://staging.standardartifacts.com.
3. **Actions → Deploy → Run workflow**, stage `prod`, then approve it. Open https://app.standardartifacts.com.

To deploy from a laptop instead (Docker running): `cd apps/app && CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… TICKET_SECRET=… pnpm exec alchemy deploy --stage staging`, plus the other variables from the table. `alchemy plan --stage staging` shows what would change. It uses the same state store as CI.

### Rollback

- **Code:** revert the change on `main`. The push redeploys staging; then run **Deploy** for prod. The workflow only deploys `main`, so this is the normal path.
- **Fast:** in the Cloudflare dashboard, open the Worker (`ahcomponents-app-prod-…`), **Deployments**, and roll back to an earlier version. It's instant, but it doesn't roll back the runner image, and the next deploy replaces it, so follow it with a revert.
- **Data** is in Durable Objects, and neither path rolls it back. Keep cell storage changes readable by the previous release.
- Never run `alchemy destroy --stage prod`: it deletes the Worker and its Durable Objects, with all their data.

### The stack id

The stack is still named `AhComponents`, from the project's first name, and the name is part of everything Alchemy creates:

- **Local dev:** Durable Object files live in `apps/app/.alchemy/local/ahcomponents-app-dev-<user>-<suffix>-<Cell>`, and state in `apps/app/.alchemy/state/AhComponents/`.
- **Cloud:** state is keyed `AhComponents/<stage>`, the Worker is `standard-artifacts-<stage>`, and its Durable Object namespaces belong to that Worker.

Alchemy treats a renamed stack as a new one. Dev starts empty, and a deploy creates a second Worker with empty Durable Objects while the old one keeps running and keeps the custom domain. The name only shows in the Cloudflare dashboard. To rename it later: export every workspace (there's no export yet, so that comes first), rename the stack, deploy the new Worker without a domain, import the data, move the domain over, then destroy the old stage. Local dev needs the same export and import, or a fresh start.

## Notes

- Effect is pinned to 4.0.x, because `alchemy@2.0.0-beta.84` imports `effect/Crypto`, which effect 4.1 removed (see `pnpm-workspace.yaml`).
- The Alchemy stack id is still `AhComponents`, from the project's first name. See [The stack id](#the-stack-id) before changing it.
- Where things live: [Architecture](architecture.md).

## Landing page

`apps/landing` is the standardartifacts.com landing page: Vite, static HTML and plain CSS, no framework. `pnpm landing` runs it; `pnpm --filter @standard-artifacts/landing build` writes `apps/landing/dist`, which any static host can serve (asset URLs are relative). `tests/src/landing.test.ts` checks the production build and needs no app running: `cd tests && node --test src/landing.test.ts`.

- **URLs:** `apps/landing/src/config.ts` holds every outside URL (site, GitHub, npm, the Cloud waitlist, license and docs links). Each export is filled into the page, the Markdown view, robots.txt and sitemap.xml as `%NAME%`. The waitlist is a mailto until there's a form.
- **Logo:** `apps/landing/src/logo.svg` is the only copy. The nav inlines it, and the favicon, touch icon and social image are built from it.
- **Markdown view:** `apps/landing/src/page.md` is the page as plain text, shown by the View Markdown toggle and published as `index.md`. Keep it in step with `index.html`.
- **Images:** `public/img` is generated by `pnpm --filter @standard-artifacts/landing images <masters folder>`. The 2-3 MB masters aren't in the repo. The product screenshots were taken from the app with demo data and show no product name.
- **Social image:** `pnpm --filter @standard-artifacts/landing og` rebuilds `src/og-base.jpg` (name and headline over the dusk painting) from `public/img`, so changing its words doesn't need the masters. Fonts come from the machine; the committed one was made on macOS.
- **Deploying:** `pnpm --filter @standard-artifacts/landing run deploy` builds it and uploads `dist/` as a static-assets Worker (`apps/landing/wrangler.jsonc`), with `CLOUDFLARE_ACCOUNT_ID` set when your login reaches more than one account. standardartifacts.com and www point at that Worker; the hosted app is on app.standardartifacts.com (see [Deploying Cloud](#deploying-cloud)). `apps/landing/redirect` is a second Worker that sends stdartifacts.com and www.stdartifacts.com there with a 301.
