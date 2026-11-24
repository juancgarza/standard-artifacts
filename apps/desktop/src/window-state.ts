import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app, screen, type BrowserWindow, type Rectangle } from "electron"

interface WindowState {
  readonly bounds: Rectangle
  readonly maximized: boolean
}

const file = () => join(app.getPath("userData"), "window-state.json")

const isRect = (v: unknown): v is Rectangle =>
  typeof v === "object" && v !== null && ["x", "y", "width", "height"].every((k) => typeof (v as Record<string, unknown>)[k] === "number")

/** Where the last window was, unless that screen is gone. */
export function loadWindowState(): WindowState | null {
  try {
    const state = JSON.parse(readFileSync(file(), "utf8")) as { bounds?: unknown; maximized?: unknown }
    if (!isRect(state.bounds)) return null
    const { bounds } = state
    const area = screen.getDisplayMatching(bounds).workArea
    const visible = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y
    return visible ? { bounds, maximized: state.maximized === true } : null
  } catch {
    return null
  }
}

export function saveWindowState(window: BrowserWindow) {
  try {
    writeFileSync(file(), JSON.stringify({ bounds: window.getNormalBounds(), maximized: window.isMaximized() }))
  } catch {
    // A convenience: the next window just opens at the default size.
  }
}
