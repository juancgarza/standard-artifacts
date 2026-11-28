/** What the desktop app's menus and deep links ask of the page. The page owns the tabs, so the app only sends these. */
export type DesktopCommand =
  | { readonly type: "new-tab" }
  | { readonly type: "close-tab" }
  | { readonly type: "next-tab" }
  | { readonly type: "previous-tab" }
  /** A position in the strip; -1 is the last tab. */
  | { readonly type: "select-tab"; readonly index: number }
  /** An in-app path. */
  | { readonly type: "open"; readonly href: string }

/**
 * Where a desktop workspace lives. `cloud` is Standard Artifacts Cloud, `local` the
 * Solo server on this computer (`stdartifacts serve`), `server` one someone hosts.
 * A Cloud workspace's orgs are the page's business: the app only knows the server.
 */
export type DesktopWorkspaceKind = "cloud" | "local" | "server"

export interface DesktopWorkspace {
  /** The app's own id for it. The page passes it back to switch; it never sees or sends an address. */
  readonly id: string
  readonly kind: DesktopWorkspaceKind
  readonly label: string
  /** The host, for a self-hosted server, so two of them can be told apart. */
  readonly detail?: string
}

export interface DesktopWorkspaces {
  /** The workspace this window shows. */
  readonly current: string
  readonly workspaces: ReadonlyArray<DesktopWorkspace>
}

/**
 * `window.standardArtifactsDesktop`: only there inside the desktop app.
 *
 * The page mostly listens. The workspace calls are the one way it can ask the app
 * for something, and they're narrow on purpose: the page can read the list and
 * pick an id from it, and the app opens addresses only from its own list or from
 * what the person typed into the app's own screen.
 */
export interface DesktopBridge {
  readonly platform: string
  readonly onCommand: (listener: (command: DesktopCommand) => void) => () => void
  /** Absent in desktop builds from before workspaces. */
  readonly workspaces?: () => Promise<DesktopWorkspaces>
  /** Show this workspace in this window, or bring forward the window that already shows it. */
  readonly openWorkspace?: (id: string) => Promise<void>
  /** The app's own screen for adding one: Cloud, this computer, or a server's address. */
  readonly addWorkspace?: () => Promise<void>
}
