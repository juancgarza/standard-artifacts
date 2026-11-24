type Theme = "light" | "dark"

const KEY = "theme"
/** A little longer than the crossfade in styles.css. */
const FADE_MS = 800
/** How long the old hour stays up while the new painting loads. */
const LOAD_WAIT_MS = 500

function saved(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function save(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Storage blocked: the choice lasts for this page view.
  }
}

/**
 * CSS does the theming: it follows the system unless `data-theme` is set. The
 * hour that isn't showing is `display: none`, so its images never download.
 * `data-both` shows both for the length of a crossfade.
 */
export function setupTheme() {
  const root = document.documentElement
  const system = matchMedia("(prefers-color-scheme: dark)")
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-set]")]

  const current = (): Theme => {
    const set = root.dataset.theme
    return set === "light" || set === "dark" ? set : system.matches ? "dark" : "light"
  }
  const sync = () => {
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.themeSet === current()))
  }

  let fading = 0
  let request = 0

  const fade = async (apply: () => void, next: Theme) => {
    const mine = ++request
    clearTimeout(fading)
    root.dataset.both = ""
    // Give the painting on screen a moment to arrive, so the fade isn't to an empty frame.
    const incoming = [...document.querySelectorAll<HTMLImageElement>(next === "dark" ? ".dusk img, img.dusk" : ".day img, img.day")].filter((img) => {
      const box = img.getBoundingClientRect()
      return box.width > 0 && box.bottom > 0 && box.top < innerHeight
    })
    for (const img of incoming) img.loading = "eager"
    await Promise.race([Promise.allSettled(incoming.map((img) => img.decode())), new Promise((done) => setTimeout(done, LOAD_WAIT_MS))])
    if (mine !== request) return
    apply()
    sync()
    fading = window.setTimeout(() => delete root.dataset.both, FADE_MS)
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const next = button.dataset.themeSet as Theme
      save(next)
      if (next === current()) {
        root.dataset.theme = next
        sync()
        return
      }
      void fade(() => (root.dataset.theme = next), next)
    })
  }

  system.addEventListener("change", (event) => {
    const value = saved()
    if (value === "light" || value === "dark") return
    // The CSS has already flipped; `data-both` keeps both hours up for the fade.
    void fade(() => {}, event.matches ? "dark" : "light")
  })

  sync()
}
