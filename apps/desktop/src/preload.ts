import { contextBridge, ipcRenderer } from "electron"
import type { DesktopBridge, DesktopCommand } from "@standard-artifacts/protocol"

/**
 * All the page gets from the app. It only listens: there are no ipcMain handlers,
 * so nothing here gives the page a way to reach the file system or the OS.
 */
const bridge: DesktopBridge = {
  platform: process.platform,
  onCommand: (listener) => {
    const handler = (_: unknown, command: DesktopCommand) => listener(command)
    ipcRenderer.on("standard-artifacts:command", handler)
    return () => ipcRenderer.removeListener("standard-artifacts:command", handler)
  },
}

contextBridge.exposeInMainWorld("standardArtifactsDesktop", bridge)
