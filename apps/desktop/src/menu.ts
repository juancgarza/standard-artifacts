import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron"
import type { DesktopCommand } from "@standard-artifacts/protocol"
import type { Workspace } from "./workspaces"

interface MenuActions {
  readonly newWindow: () => void
  /** Sends a command to a window's page, which owns the tabs. */
  readonly command: (window: BrowserWindow, command: DesktopCommand) => void
  readonly workspaces: ReadonlyArray<Workspace>
  /** The workspace the window in front shows, ticked in the menu. */
  readonly current: string | undefined
  readonly openWorkspace: (id: string) => void
  readonly addWorkspace: () => void
}

/** Installed again whenever the front window or the workspace list changes, so the tick follows. */
export function installMenu({ newWindow, command, workspaces, current, openWorkspace, addWorkspace }: MenuActions) {
  const isMac = process.platform === "darwin"
  const send = (next: DesktopCommand) => (_: unknown, window: unknown) => {
    if (window instanceof BrowserWindow) command(window, next)
  }

  const template: Array<MenuItemConstructorOptions> = [
    ...(isMac ? [{ role: "appMenu" } satisfies MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: send({ type: "new-tab" }) },
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => newWindow() },
        { type: "separator" },
        {
          label: "Workspace",
          submenu: [
            ...workspaces.map(
              (w): MenuItemConstructorOptions => ({ label: w.label, type: "radio", checked: w.id === current, click: () => openWorkspace(w.id) }),
            ),
            { type: "separator" },
            { label: "Add Workspace…", click: () => addWorkspace() },
          ],
        },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: send({ type: "close-tab" }) },
        { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", role: "close" },
        ...(isMac ? [] : [{ type: "separator" } satisfies MenuItemConstructorOptions, { role: "quit" } satisfies MenuItemConstructorOptions]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } satisfies MenuItemConstructorOptions]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Tabs",
      submenu: [
        { label: "Next Tab", accelerator: "CmdOrCtrl+Shift+]", click: send({ type: "next-tab" }) },
        { label: "Previous Tab", accelerator: "CmdOrCtrl+Shift+[", click: send({ type: "previous-tab" }) },
        { label: "Next Tab", accelerator: "Ctrl+Tab", visible: false, click: send({ type: "next-tab" }) },
        { label: "Previous Tab", accelerator: "Ctrl+Shift+Tab", visible: false, click: send({ type: "previous-tab" }) },
        { type: "separator" },
        ...[1, 2, 3, 4, 5, 6, 7, 8].map(
          (n): MenuItemConstructorOptions => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: send({ type: "select-tab", index: n - 1 }) }),
        ),
        // As in a browser, ⌘9 is the last tab however many there are.
        { label: "Last Tab", accelerator: "CmdOrCtrl+9", click: send({ type: "select-tab", index: -1 }) },
      ],
    },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
