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

/** `window.standardArtifactsDesktop`: only there inside the desktop app. */
export interface DesktopBridge {
  readonly platform: string
  readonly onCommand: (listener: (command: DesktopCommand) => void) => () => void
}
