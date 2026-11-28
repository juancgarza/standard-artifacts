import { join } from "node:path"
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent, type Session, type WebContents } from "electron"
import type { DesktopCommand, DesktopWorkspaces } from "@standard-artifacts/protocol"
import markSvg from "../../../assets/brand/mark.svg"
import chooseHtml from "./choose.html"
import { authCallbackCode, deepLinkHref, deepLinkInArgs, destinationOf, isAuthLink, isSignInUrl, SCHEME } from "./links"
import { installMenu } from "./menu"
import offlineHtml from "./offline.html"
import { createSignIn, type SignIn } from "./signin"
import { loadWindowState, saveWindowState } from "./window-state"
import { createWorkspaceStore } from "./workspace-store"
import { isScreenUrl, partitionOf, screenAction, serverOrigin, toPublic, type ScreenAction, type Workspace } from "./workspaces"

/**
 * A thin host: each window loads the app from a server, so cookies, room sockets,
 * share links and "Copy link" behave as they do in a browser and the UI can't drift
 * from the API.
 *
 * Each window shows one workspace (workspaces.ts): Standard Artifacts Cloud, the Solo
 * server on this computer, or a server someone hosts. Each workspace has its own
 * session, so a Cloud sign-in never reaches the local server and switching signs no
 * one out. Cloud is the address the build was made for (STDARTIFACTS_DESKTOP_URL at
 * build time, app.standardartifacts.com by default); only an unpackaged run reads it
 * when it starts.
 */
const cloudOrigin = new URL((!app.isPackaged && process.env.STDARTIFACTS_DESKTOP_URL) || (app.isPackaged ? PACKAGED_APP_URL : "http://localhost:5173")).origin
const isMac = process.platform === "darwin"
const SHOW_WITHIN_MS = 1_000
const CONNECT_WITHIN_MS = 10_000

/** A packaged build and `pnpm dev` keep separate profiles, or each would wait on the other's single-instance lock. */
if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", `${app.getPath("userData")} Dev`)
}

const store = createWorkspaceStore(cloudOrigin)

// --- The app's own screens: data: URLs, because packaged builds turn off file:// privileges ---

const dataPage = (html: string, state: unknown) => `data:text/html;base64,${Buffer.from(html).toString("base64")}#${encodeURIComponent(JSON.stringify(state))}`
/** The chooser, with its state written into the page: `<` escaped, so nothing in it can close the script. */
const chooseScreen = (current?: Workspace, problem?: { error: string; address: string }) => {
  const state = JSON.stringify({ workspaces: store.all().map(toPublic), current: current?.id, ...problem }).replace(/</g, "\\u003c")
  const html = chooseHtml.replace("<!-- mark -->", markSvg).replace("/* state */ {}", () => state)
  return `data:text/html;base64,${Buffer.from(html).toString("base64")}`
}
const offlineScreen = (workspace: Workspace, url: string) => dataPage(offlineHtml, { url, kind: workspace.kind, label: workspace.label })
const isOwnScreen = (contents: WebContents) => contents.getURL().startsWith("data:text/html")

// --- Workspaces: a session and a sign-in each -------------------------------------------

interface Host {
  readonly session: Session
  readonly signIn: SignIn
}
const hosts = new Map<string, Host>()

/** Which workspace each window shows, by its webContents id. A window from the chooser has none. */
const shownIn = new Map<number, Workspace>()
const workspaceOf = (window: BrowserWindow) => shownIn.get(window.webContents.id)
const windowsOf = (workspace: Workspace) => BrowserWindow.getAllWindows().filter((w) => workspaceOf(w)?.id === workspace.id)
const pageUrl = (workspace: Workspace, href: string) => new URL(href, workspace.origin).toString()
const isAppPage = (window: BrowserWindow) => {
  const workspace = workspaceOf(window)
  return !!workspace && destinationOf(window.webContents.getURL(), workspace.origin) === "in-app"
}

/** Starts from nothing, since Electron grants everything by default. A grid's paste reads the clipboard. */
function restrictPermissions(target: Session, origin: string | null) {
  const allowed = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen"])
  const fromApp = (url: string) => {
    try {
      return origin !== null && new URL(url).origin === origin
    } catch {
      return false
    }
  }
  target.setPermissionRequestHandler((_, permission, callback, details) => {
    callback(allowed.has(permission) && details.isMainFrame && fromApp(details.requestingUrl))
  })
  target.setPermissionCheckHandler((_, permission, requestingOrigin, details) => allowed.has(permission) && details.isMainFrame && fromApp(requestingOrigin))
}

function hostFor(workspace: Workspace): Host {
  const known = hosts.get(workspace.id)
  if (known) return known
  const ses = session.fromPartition(partitionOf(workspace))
  restrictPermissions(ses, workspace.origin)
  // Sign-in runs in the person's browser and comes back through a `stdartifacts://auth/callback` link.
  const signIn = createSignIn({ appOrigin: workspace.origin, session: ses, show: (href) => showEverywhere(workspace, href) })
  signIn.watch()
  const host = { session: ses, signIn }
  hosts.set(workspace.id, host)
  return host
}

// --- Windows ----------------------------------------------------------------------------

/**
 * Links the page doesn't handle itself: in-app ones stay, the rest go to the person's browser.
 * Two exceptions: signing in goes to the browser too (with what it needs to come back here),
 * and AuthKit's sign-out right after the page signed out happens here, in the background.
 * The app's own screens send their choices as navigations to SCREEN_ORIGIN.
 */
function guardNavigation(window: BrowserWindow) {
  const contents = window.webContents
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isScreenUrl(url)) {
      event.preventDefault()
      const action = screenAction(url)
      if (action && isOwnScreen(contents)) handleScreen(window, action)
      return
    }
    const workspace = workspaceOf(window)
    if (!workspace) return event.preventDefault()
    const { signIn } = hostFor(workspace)
    if (isSignInUrl(url, workspace.origin)) {
      event.preventDefault()
      return signIn.start(url)
    }
    const destination = destinationOf(url, workspace.origin)
    if (destination === "in-app") return
    event.preventDefault()
    if (signIn.isSignOut(url)) return void signIn.signOut(url)
    if (destination === "external") void shell.openExternal(url)
  }
  contents.on("will-navigate", guard)
  contents.on("will-redirect", guard)
  // "Open in browser tab" means the browser here too; in-app tabs are the page's job.
  contents.setWindowOpenHandler(({ url }) => {
    const workspace = workspaceOf(window)
    if (!workspace || isScreenUrl(url)) return { action: "deny" }
    if (isSignInUrl(url, workspace.origin)) hostFor(workspace).signIn.start(url)
    else if (destinationOf(url, workspace.origin) !== "blocked") void shell.openExternal(url)
    return { action: "deny" }
  })
}

/** Electron has no right-click menu of its own, and the page only draws one for its own objects. */
function installContextMenu(window: BrowserWindow) {
  const contents = window.webContents
  contents.on("context-menu", (_, params) => {
    const origin = workspaceOf(window)?.origin ?? ""
    const external = params.linkURL && !isScreenUrl(params.linkURL) && destinationOf(params.linkURL, origin) !== "blocked"
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

interface OpenOptions {
  /** Without one, the window shows the workspace chooser. */
  readonly workspace?: Workspace | undefined
  readonly href?: string
  /** Where to put it: a window replacing another takes its place. */
  readonly bounds?: Electron.Rectangle
}

function openWindow({ workspace, href = "/", bounds: replacing }: OpenOptions = {}) {
  const saved = loadWindowState()
  // A second window steps off the one it came from, so it can be seen opening.
  const from = BrowserWindow.getFocusedWindow()?.getNormalBounds()
  const bounds = replacing ?? (from ? { ...from, x: from.x + 24, y: from.y + 24 } : saved?.bounds)
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
      // The chooser has no server, so it gets the default session, which permits nothing.
      session: workspace ? hostFor(workspace).session : session.defaultSession,
    },
  })
  if (saved?.maximized && !from && !replacing) window.maximize()

  const { webContents: contents } = window
  const id = contents.id
  if (workspace) shownIn.set(id, workspace)
  guardNavigation(window)
  installContextMenu(window)

  // Painted first if the server is quick, but a server that never answers fires no event at all.
  const showAnyway = setTimeout(() => window.show(), SHOW_WITHIN_MS)
  const giveUp = workspace ? setTimeout(() => void window.loadURL(offlineScreen(workspace, pageUrl(workspace, href))), CONNECT_WITHIN_MS) : undefined
  window.once("ready-to-show", () => {
    clearTimeout(showAnyway)
    window.show()
  })
  contents.once("did-navigate", () => clearTimeout(giveUp))
  window.once("closed", () => {
    clearTimeout(showAnyway)
    clearTimeout(giveUp)
    shownIn.delete(id)
    rebuildMenu()
  })
  window.on("close", () => saveWindowState(window))
  contents.on("did-fail-load", (_, code, __, url, isMainFrame) => {
    const shown = shownIn.get(id)
    // -3 is a load this one replaced, not a failure.
    if (!shown || !isMainFrame || code === -3 || destinationOf(url, shown.origin) !== "in-app") return
    clearTimeout(giveUp)
    void window.loadURL(offlineScreen(shown, url))
  })
  void window.loadURL(workspace ? pageUrl(workspace, href) : chooseScreen())
  rebuildMenu()
  return window
}

/**
 * Shows `target` for this window. A window already showing it comes forward instead;
 * otherwise a new window on that workspace's session takes this one's place (a window
 * can't change session).
 */
function switchTo(window: BrowserWindow, target: Workspace, href = "/") {
  store.setLast(target.id)
  const current = workspaceOf(window)
  if (current?.id === target.id) return void window.loadURL(pageUrl(target, href))
  const other = windowsOf(target)[0]
  if (other) {
    bringForward(other)
    // From the chooser: a window with a workspace goes back to it, a bare chooser closes.
    if (isAppPage(window)) return
    if (current) void window.loadURL(pageUrl(current, "/"))
    else window.close()
    return
  }
  const bounds = window.getNormalBounds()
  openWindow({ workspace: target, href, bounds })
  window.close()
}

/** What the chooser and the can't-connect page ask for. */
function handleScreen(window: BrowserWindow, action: ScreenAction) {
  const current = workspaceOf(window)
  if (action.type === "choose") return void window.loadURL(chooseScreen(current))
  if (action.type === "open") {
    const target = store.get(action.id)
    if (target) switchTo(window, target)
    return
  }
  const origin = serverOrigin(action.address)
  if (!origin) {
    const error = "That isn't a server address. Use one like artifacts.example.com; plain http works only for this computer."
    return void window.loadURL(chooseScreen(current, { error, address: action.address }))
  }
  switchTo(window, store.add(origin))
}

function sendCommand(window: BrowserWindow, command: DesktopCommand) {
  // Off the app (the chooser, the can't-connect page), nobody is listening, so ⌘W closes the window.
  if (!isAppPage(window)) {
    if (command.type === "close-tab") window.close()
    return
  }
  window.webContents.send("standard-artifacts:command", command)
}

function bringForward(window: BrowserWindow) {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return window
}

/** The window in front, brought forward, or undefined when there's none. */
function frontWindow() {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  return window ? bringForward(window) : undefined
}

/** Opens a page in the window in front, without reloading it when the page can take it as a new tab. */
function openLink(url: string) {
  const href = deepLinkHref(url)
  if (!href) return
  const window = frontWindow()
  const workspace = (window && workspaceOf(window)) ?? store.last()
  // Before anyone has picked a workspace, a link has nowhere to go: the chooser stays.
  if (!workspace) {
    if (!window) openWindow()
    return
  }
  if (!window || !workspaceOf(window)) return void openWindow({ workspace, href })
  if (isAppPage(window) && !window.webContents.isLoading()) sendCommand(window, { type: "open", href })
  else void window.loadURL(pageUrl(workspace, href))
}

/** After signing in or out of a workspace: its window in front goes to `href`, and its others start over where they are. */
function showEverywhere(workspace: Workspace, href: string) {
  const windows = windowsOf(workspace)
  if (windows.length === 0) return void openWindow({ workspace, href })
  const focused = BrowserWindow.getFocusedWindow()
  const front = bringForward(windows.find((w) => w === focused) ?? windows[0]!)
  for (const window of windows) {
    if (window === front) void window.loadURL(pageUrl(workspace, href))
    else window.webContents.reload()
  }
}

/** A `stdartifacts://` link: sign-in coming back from the browser, or a page to open. */
function handleLink(url: string) {
  if (!isAuthLink(url)) return openLink(url)
  const code = authCallbackCode(url)
  // The workspace whose sign-in is waiting; with two, the newer one started this.
  const waiting = [...hosts.values()]
    .map((host) => ({ host, since: host.signIn.pendingSince() }))
    .filter((h): h is { host: Host; since: number } => h.since !== null)
    .sort((a, b) => b.since - a.since)[0]
  if (!frontWindow() && !waiting) openWindow({ workspace: store.last() })
  if (code && waiting) void waiting.host.signIn.finish(code)
}

// --- The page's one way to ask: the workspace switcher -----------------------------------

/**
 * The workspace a page asking through the bridge is on, or undefined. Only the top frame of
 * an app page qualifies: not an embed, and not a page that navigated somewhere else.
 */
function askingWorkspace(event: IpcMainInvokeEvent): Workspace | undefined {
  const workspace = shownIn.get(event.sender.id)
  const frame = event.senderFrame
  if (!workspace || !frame || frame.parent !== null) return undefined
  try {
    return new URL(frame.url).origin === workspace.origin ? workspace : undefined
  } catch {
    return undefined
  }
}

function handleWorkspaceAsks() {
  const refuse = () => {
    throw new Error("Workspaces aren't available on this page.")
  }
  ipcMain.handle("standard-artifacts:workspaces", (event): DesktopWorkspaces => {
    const workspace = askingWorkspace(event) ?? refuse()
    return { current: workspace.id, workspaces: store.all().map(toPublic) }
  })
  // An id from the list above, never an address: the page can't point the app anywhere new.
  ipcMain.handle("standard-artifacts:open-workspace", (event, id: unknown) => {
    if (!askingWorkspace(event)) refuse()
    const window = BrowserWindow.fromWebContents(event.sender)
    const target = typeof id === "string" ? store.get(id) : undefined
    if (!window || !target) throw new Error("There's no such workspace.")
    switchTo(window, target)
  })
  ipcMain.handle("standard-artifacts:add-workspace", (event) => {
    const workspace = askingWorkspace(event) ?? refuse()
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) void window.loadURL(chooseScreen(workspace))
  })
}

function rebuildMenu() {
  if (!app.isReady()) return
  const front = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  installMenu({
    newWindow: () => {
      const focused = BrowserWindow.getFocusedWindow()
      openWindow({ workspace: (focused && workspaceOf(focused)) ?? store.last() })
    },
    command: sendCommand,
    workspaces: store.all(),
    current: front ? workspaceOf(front)?.id : undefined,
    openWorkspace: (id) => {
      const target = store.get(id)
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!target) return
      if (window) switchTo(window, target)
      else openWindow({ workspace: target })
    },
    addWorkspace: () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (window) void window.loadURL(chooseScreen(workspaceOf(window)))
      else openWindow()
    },
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // macOS delivers a launch link before `ready`.
  let launchLink = deepLinkInArgs(process.argv)
  app.on("open-url", (event, url) => {
    event.preventDefault()
    if (app.isReady()) handleLink(url)
    else launchLink = url
  })
  app.on("second-instance", (_, args) => {
    const link = deepLinkInArgs(args)
    if (link) return handleLink(link)
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return openWindow({ workspace: store.last() })
    bringForward(window)
  })
  app.on("window-all-closed", () => {
    if (!isMac) app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow({ workspace: store.last() })
  })
  app.on("browser-window-focus", () => rebuildMenu())
  store.onChange(() => rebuildMenu())

  void app.whenReady().then(() => {
    // The registered handler for unpackaged builds would be the bare Electron binary.
    if (app.isPackaged) app.setAsDefaultProtocolClient(SCHEME)
    restrictPermissions(session.defaultSession, null)
    handleWorkspaceAsks()
    rebuildMenu()
    // A sign-in link can't finish here: a new process has no verifier for it.
    const href = (launchLink && !isAuthLink(launchLink) && deepLinkHref(launchLink)) || "/"
    openWindow({ workspace: store.last(), href })
  })
}
