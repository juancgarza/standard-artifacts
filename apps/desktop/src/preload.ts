import { contextBridge, ipcRenderer } from "electron"
import type { DesktopBridge, DesktopCommand, DesktopWorkspaces } from "@standard-artifacts/protocol"

/**
 * All the page gets from the app. It mostly listens. The workspace switcher is the
 * one way it can ask for something, and main.ts answers only an app page's top
 * frame: it can read the workspace list and pick an id from it, never name an
 * address, a file or anything else on this computer.
 */
const bridge: DesktopBridge = {
  platform: process.platform,
  onCommand: (listener) => {
    const handler = (_: unknown, command: DesktopCommand) => listener(command)
    ipcRenderer.on("standard-artifacts:command", handler)
    return () => ipcRenderer.removeListener("standard-artifacts:command", handler)
  },
  workspaces: () => ipcRenderer.invoke("standard-artifacts:workspaces") as Promise<DesktopWorkspaces>,
  openWorkspace: async (id) => {
    await ipcRenderer.invoke("standard-artifacts:open-workspace", String(id))
  },
  addWorkspace: async () => {
    await ipcRenderer.invoke("standard-artifacts:add-workspace")
  },
}

contextBridge.exposeInMainWorld("standardArtifactsDesktop", bridge)
