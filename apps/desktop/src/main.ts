import { join } from "node:path"
import { app, BrowserWindow, Menu, nativeTheme, session, shell, type WebContents } from "electron"
import type { DesktopCommand } from "@standard-artifacts/protocol"
import { deepLinkHref, deepLinkInArgs, destinationOf, SCHEME } from "./links"
import { installMenu } from "./menu"
import offlineHtml from "./offline.html"
import { loadWindowState, saveWindowState } from "./window-state"

/**
 * A thin host: each window loads the app from its Worker, so cookies, room sockets,
 * share links and "Copy link" behave as they do in a browser and the UI can't drift
 * from the API. The app needs its server to do anything, so bundling the UI wouldn't
 * buy offline use. Only local dev can point it elsewhere.
 */
const appUrl = new URL((!app.isPackaged && process.env.STDARTIFACTS_DESKTOP_URL) || (app.isPackaged ? "https://app.standardartifacts.com" : "http://localhost:5173"))
const appOrigin = appUrl.origin
const isMac = process.platform === "darwin"
const SHOW_WITHIN_MS = 1_000
const CONNECT_WITHIN_MS = 10_000
/** A data: URL because packaged builds turn off file:// privileges, and the app has no local pages otherwise. */
const offlinePage = `data:text/html;base64,${Buffer.from(offlineHtml).toString("base64")}`

/** A packaged build and `pnpm dev` keep separate profiles, or each would wait on the other's single-instance lock. */
if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", `${app.getPath("userData")} Dev`)
}

const pageUrl = (href: string) => new URL(href, appOrigin).toString()
const isAppPage = (contents: WebContents) => destinationOf(contents.getURL(), appOrigin) === "in-app"

/** Links the page doesn't handle itself: in-app ones stay, the rest go to the person's browser. */
function guardNavigation(contents: WebContents) {
  const guard = (event: { preventDefault(): void }, url: string) => {
    const destination = destinationOf(url, appOrigin)
    if (destination === "in-app") return
    event.preventDefault()
    if (destination === "external") void shell.openExternal(url)
  }
  contents.on("will-navigate", guard)
  contents.on("will-redirect", guard)
  // "Open in browser tab" means the browser here too; in-app tabs are the page's job.
  contents.setWindowOpenHandler(({ url }) => {
    if (destinationOf(url, appOrigin) !== "blocked") void shell.openExternal(url)
    return { action: "deny" }
  })
}

/** Electron has no right-click menu of its own, and the page only draws one for its own objects. */
function installContextMenu(contents: WebContents) {
  contents.on("context-menu", (_, params) => {
    const external = params.linkURL && destinationOf(params.linkURL, appOrigin) !== "blocked"
    const template: Array<Electron.MenuItemConstructorOptions> = [
      ...params.dictionarySuggestions.map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) })),
      ...(params.misspelledWord ? [{ type: "separator" as const }] : []),
      ...(external
        ? [
            { label: "Open Link in Browser", click: () => void shell.openExternal(params.linkURL) },
            { type: "separator" as const },
          ]
        : []),
      ...(params.isEditable ? [{ role: "cut" as const }] : []),
      ...(params.isEditable || params.selectionText ? [{ role: "copy" as const }] : []),
      ...(params.isEditable ? [{ role: "paste" as const }, { role: "selectAll" as const }] : []),
    ]
    if (template.length > 0) Menu.buildFromTemplate(template).popup()
  })
}

/** Starts from nothing, since Electron grants everything by default. A grid's paste reads the clipboard. */
function restrictPermissions() {
  const allowed = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen"])
  const fromApp = (url: string) => {
    try {
      return new URL(url).origin === appOrigin
    } catch {
      return false
    }
  }
  session.defaultSession.setPermissionRequestHandler((_, permission, callback, details) => {
    callback(allowed.has(permission) && details.isMainFrame && fromApp(details.requestingUrl))
  })
  session.defaultSession.setPermissionCheckHandler((_, permission, origin, details) => allowed.has(permission) && details.isMainFrame && fromApp(origin))
}

function openWindow(href = "/") {
  const saved = loadWindowState()
  // A second window steps off the one it came from, so it can be seen opening.
  const from = BrowserWindow.getFocusedWindow()?.getNormalBounds()
  const bounds = from ? { ...from, x: from.x + 24, y: from.y + 24 } : saved?.bounds
  const window = new BrowserWindow({
    ...(bounds ?? { width: 1440, height: 900 }),
    minWidth: 800,
    minHeight: 600,
    show: false,
    // --bg from styles.css, so a new window doesn't flash the wrong color.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191918" : "#ffffff",
    ...(isMac && { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 12, y: 11 } }),
    webPreferences: {
      preload: join(app.getAppPath(), "dist/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (saved?.maximized && !from) window.maximize()

  const { webContents: contents } = window
  guardNavigation(contents)
  installContextMenu(contents)
  const showOffline = (url: string) => void window.loadURL(`${offlinePage}#${encodeURIComponent(url)}`)

  // Painted first if the server is quick, but a server that never answers fires no event at all.
  const showAnyway = setTimeout(() => window.show(), SHOW_WITHIN_MS)
  const giveUp = setTimeout(() => showOffline(pageUrl(href)), CONNECT_WITHIN_MS)
  window.once("ready-to-show", () => {
    clearTimeout(showAnyway)
    window.show()
  })
  contents.once("did-navigate", () => clearTimeout(giveUp))
  window.once("closed", () => {
    clearTimeout(showAnyway)
    clearTimeout(giveUp)
  })
  window.on("close", () => saveWindowState(window))
  contents.on("did-fail-load", (_, code, __, url, isMainFrame) => {
    // -3 is a load this one replaced, not a failure.
    if (!isMainFrame || code === -3 || destinationOf(url, appOrigin) !== "in-app") return
    clearTimeout(giveUp)
    showOffline(url)
  })
  void window.loadURL(pageUrl(href))
  return window
}

function sendCommand(window: BrowserWindow, command: DesktopCommand) {
  // Off the app (the can't-connect page), nobody is listening, so ⌘W closes the window.
  if (!isAppPage(window.webContents)) {
    if (command.type === "close-tab") window.close()
    return
  }
  window.webContents.send("standard-artifacts:command", command)
}

/** Opens a page in the window in front, without reloading it when the page can take it as a new tab. */
function openLink(url: string) {
  const href = deepLinkHref(url)
  if (!href) return
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window) return openWindow(href)
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  if (isAppPage(window.webContents) && !window.webContents.isLoading()) sendCommand(window, { type: "open", href })
  else void window.loadURL(pageUrl(href))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // macOS delivers a launch link before `ready`.
  let launchLink = deepLinkInArgs(process.argv)
  app.on("open-url", (event, url) => {
    event.preventDefault()
    if (app.isReady()) openLink(url)
    else launchLink = url
  })
  app.on("second-instance", (_, args) => {
    const link = deepLinkInArgs(args)
    if (link) return openLink(link)
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return openWindow()
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.on("window-all-closed", () => {
    if (!isMac) app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })

  void app.whenReady().then(() => {
    // The registered handler for unpackaged builds would be the bare Electron binary.
    if (app.isPackaged) app.setAsDefaultProtocolClient(SCHEME)
    restrictPermissions()
    installMenu({ newWindow: () => openWindow(), command: sendCommand })
    openWindow((launchLink && deepLinkHref(launchLink)) ?? "/")
  })
}
