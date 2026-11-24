import { useSyncExternalStore } from "react"

export type Theme = "light" | "dark" | "system"

/** Read by the script in index.html too, which sets the theme before first paint. */
const KEY = "standard-artifacts:theme"

const system = window.matchMedia("(prefers-color-scheme: dark)")
const listeners = new Set<() => void>()

/** Storage can be missing or throw (private windows, previews): then the system's theme applies. */
function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === "light" || stored === "dark" ? stored : "system"
  } catch {
    return "system"
  }
}

let current = read()

function apply() {
  document.documentElement.dataset.theme = current === "system" ? (system.matches ? "dark" : "light") : current
}

function change(next: Theme) {
  current = next
  apply()
  for (const listener of listeners) listener()
}

export function setTheme(next: Theme) {
  try {
    if (next === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    // per-browser convenience: it still applies to this page view
  }
  change(next)
}

// Follow the system while on "system", and a choice made in another window.
system.addEventListener("change", apply)
window.addEventListener("storage", (e) => {
  if (e.key === KEY || e.key === null) change(read())
})

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}
