
# Desktop app

`apps/desktop` is a thin Electron host. Each window loads the app from its Worker, so sign-in, room sockets, share links and copied links work as they do in a browser, and the UI can't drift from the API. What it adds is native windows and menus, ⌘T / ⌘W / ⌘1–9 for tabs (a browser keeps those), `stdartifacts://docs/d_abc` links, and a page that waits and reconnects when the server is away.

```sh
pnpm dev                                               # the app, as usual
pnpm --filter @standard-artifacts/desktop dev          # a window on http://localhost:5173 (STDARTIFACTS_DESKTOP_URL to change it)
pnpm --filter @standard-artifacts/desktop package:dir  # an ad-hoc-signed .app in release/, which loads app.standardartifacts.com
pnpm --filter @standard-artifacts/desktop package      # installers; needs a Developer ID to run on other Macs
```

The page gets `window.standardArtifactsDesktop`, which can only receive commands (`DesktopCommand` in `@standard-artifacts/protocol`); there are no `ipcMain` handlers, so the page has no way to reach the OS. The renderer is sandboxed, permissions start from none, and other sites open in the person's browser.

Why Electron: a board's HTML embeds, the doc editor and the grid need a web engine, so a native UI (GPUI, as Discord is moving to) would mean rewriting them and still embedding one, on top of the web app guests open from share links. Tauri would run them on WebKit on a Mac while `tests/` covers Chrome.
