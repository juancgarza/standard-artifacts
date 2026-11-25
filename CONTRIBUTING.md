# Contributing

Thanks for helping with Standard Artifacts. Issues and pull requests are welcome.

## Before your first pull request

Read the [Contributor License Agreement](CLA.md). It's an individual CLA modeled on Apache's, and it lets the project owner relicense contributions. It covers all your contributions, so you sign it once: when you open your first pull request, a bot asks you to, and you sign by commenting exactly this on the pull request:

```
I have read CLA.md and I hereby sign the CLA
```

The bot records your GitHub account in `signatures/cla.json` on the `cla-signatures` branch, and the **CLA** check turns green. Comment `recheck` if it doesn't. If you contribute as part of your job, make sure your employer allows it (CLA section 5). Pull requests can't be merged until everyone who committed to them has signed.

## Licenses

What you contribute is licensed like the package it lands in: AGPL-3.0-only for the server, web app, runner, desktop app and artifact UI packages, and Apache-2.0 for `packages/protocol`, `packages/client`, `packages/mcp` and `apps/cli`. See [LICENSING.md](LICENSING.md).

## Working on it

[docs/development.md](docs/development.md) covers setup and tests, and [docs/architecture.md](docs/architecture.md) explains how the pieces fit. Before opening a pull request, run:

```sh
pnpm install
pnpm typecheck
pnpm test        # starts local dev if it isn't running, then runs tests/
```

Keep pull requests small and focused, and add or update tests in `tests/` for behavior you change.

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md), not as issues.
