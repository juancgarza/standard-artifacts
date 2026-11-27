# Desktop app

`apps/desktop` is a thin Electron host. Each window loads the app from its Worker, so sign-in, room sockets, share links and copied links work as they do in a browser, and the UI can't drift from the API. What it adds is native windows and menus, ⌘T / ⌘W / ⌘1–9 for tabs (a browser keeps those), `stdartifacts://docs/d_abc` links, and a page that waits and reconnects when the server is away.

## Install (preview)

Desktop previews are on [GitHub Releases](https://github.com/juancgarza/standard-artifacts/releases?q=desktop&expanded=true), marked "Desktop preview vX" and pre-release. They connect to Standard Artifacts Cloud (app.standardartifacts.com).

| | File |
|---|---|
| macOS, Apple silicon | `Standard-Artifacts-<version>-mac-arm64.dmg` |
| macOS, Intel | `Standard-Artifacts-<version>-mac-x64.dmg` |
| Windows | `Standard-Artifacts-<version>-win-x64.exe` |
| Linux | `Standard-Artifacts-<version>-linux-x86_64.AppImage` (`chmod +x` it, then run it) |

`SHA256SUMS.txt` in each release has every file's checksum.

The previews aren't signed yet, so the OS warns about them once:

- **macOS.** Open the dmg and drag Standard Artifacts to Applications. The first time you open it, macOS says it can't verify the app.
  - On macOS Sequoia (15) and later: open it once and dismiss the warning, then go to **System Settings → Privacy & Security**, scroll down to the message about Standard Artifacts, and click **Open Anyway**. Confirm with your password.
  - Or, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Standard Artifacts.app"`, then open it as usual.
- **Windows.** When SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.

The app doesn't update itself yet: download new previews from Releases.

## Signing in

AuthKit can't run inside the app's window (Google, for one, refuses sign-in in embedded browsers), so the app signs in through your browser and gets the session back with a one-time code. This is the pattern in [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)):

1. When the page navigates to `/api/auth/login`, the app stops it, makes a random verifier, keeps it in memory, and opens `/api/auth/login?desktop=<base64url(SHA-256(verifier))>` in your browser instead.
2. The Worker carries that challenge through AuthKit in its `state` (`<random>.<challenge>`). The whole state is sealed in the sign-in cookie, as for any sign-in, so the callback only accepts the challenge the login started with.
3. After AuthKit, the callback doesn't sign the browser in. It seals the session, keeps it in the org's WorkspaceCell under a one-time code (60 seconds, single use, stored as a hash, bound to the challenge), and shows a "Return to Standard Artifacts" page that opens `stdartifacts://auth/callback?code=…` (with a button in case the browser didn't).
4. The app catches that link (`open-url` on macOS, `second-instance` elsewhere), POSTs the code and verifier as JSON to `/api/auth/desktop/exchange` from its own session (`session.fetch`), and the response sets the usual sealed session cookie there. Then the windows reload.

Any app can claim a URL scheme, so another app could catch the link; without the verifier the code is useless to it, and a wrong verifier burns the code. A code that's reused, expired, or arrives when the app started no sign-in is refused. The auth link has its own handler: `deepLinkHref` still refuses `/api` and `/mcp` for page links.

Switching workspaces doesn't go through AuthKit (`POST /api/auth/switch` refreshes the session in place), and anything that does, like a workspace that requires SSO, goes through the same handoff. Signing out clears the app's cookies and storage, and ends the AuthKit session with a background request rather than in your browser: the one navigation off the app that stays in it is AuthKit's sign-out right after the page signed out.

In dev mode (`AUTH_MODE=dev`) there's no sign-in, so none of this runs. The server's half is `apps/app/src/worker/desktop-handoff.ts`; the app's is `apps/desktop/src/signin.ts`.

## Development

```sh
pnpm dev                                               # the app, as usual
pnpm --filter @standard-artifacts/desktop dev          # a window on http://localhost:5173 (STDARTIFACTS_DESKTOP_URL to change it)
pnpm --filter @standard-artifacts/desktop package:dir  # an ad-hoc-signed .app in release/, which loads app.standardartifacts.com
pnpm --filter @standard-artifacts/desktop package      # installers (see Releases below for signing)
```

A packaged build loads the address it was built for: app.standardartifacts.com, or `STDARTIFACTS_DESKTOP_URL` when it's set at build time. Only an unpackaged run reads `STDARTIFACTS_DESKTOP_URL` when it starts. Signing in needs the `stdartifacts://` link to reach the app, which only a packaged build registers (macOS reads URL schemes from the app's Info.plist), so to try sign-in against staging, build one for it:

```sh
STDARTIFACTS_DESKTOP_URL=https://staging.standardartifacts.com pnpm --filter @standard-artifacts/desktop package:dir
open "apps/desktop/release/mac-arm64/Standard Artifacts.app"
```

It shares the installed app's profile and `stdartifacts://` handler, so delete it afterwards (or open the real app once) to hand the links back.

The page gets `window.standardArtifactsDesktop`, which can only receive commands (`DesktopCommand` in `@standard-artifacts/protocol`); there are no `ipcMain` handlers, so the page has no way to reach the OS. The renderer is sandboxed, permissions start from none, and other sites open in the person's browser. Sign-in and sign-out are handled in the main process from navigations the page already makes, so they add nothing to that bridge.

## Releases

`.github/workflows/desktop-release.yml` builds the macOS dmgs (arm64 and x64, on `macos-14`), the Windows NSIS installer and the Linux AppImage, and attaches them to a GitHub pre-release named "Desktop preview v<version>", with checksums and install notes.

1. Bump `version` in `apps/desktop/package.json` in a PR and merge it. The workflow refuses a tag that doesn't match.
2. Push the tag: `git tag desktop-v0.1.0 origin/main && git push origin desktop-v0.1.0`. Or run **Desktop release** from the Actions tab with the version, which tags the commit it ran on.

Re-running it for the same version replaces the files on the existing release.

**Signing.** Without secrets, macOS builds are ad-hoc signed (`-c.mac.identity=-`, as `package:dir` does) and not notarized, and Windows builds are unsigned. Adding these repository secrets turns signing on, with no change to the workflow:

- `CSC_LINK` and `CSC_KEY_PASSWORD`: a Developer ID Application certificate (`.p12`, base64) and its password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`: notarization, which electron-builder does when all three are set.
- Optionally `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for a Windows code-signing certificate.

**Auto-update** is left out until the Mac builds are signed: Squirrel.Mac only installs updates signed by the same Developer ID. Then add `electron-updater` with GitHub as the provider, publish its `latest*.yml` files with the installers, and drop the "download new previews" line above.

## Why Electron

A board's HTML embeds, the doc editor and the grid need a web engine, so a native UI (GPUI, as Discord is moving to) would mean rewriting them and still embedding one, on top of the web app guests open from share links. Tauri would run them on WebKit on a Mac while `tests/` covers Chrome.
