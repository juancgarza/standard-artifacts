import { setupNav } from "./nav.ts"
import { setupRecorder } from "./recorder/mount.ts"
import { setupTabs } from "./tabs.ts"
import { setupTheme } from "./theme.ts"

setupTheme()
setupNav()
setupRecorder()

for (const list of document.querySelectorAll<HTMLElement>('[role="tablist"]')) setupTabs(list)

// Replay the "first run" lines when the Connect tab changes.
const tape = document.querySelector<HTMLElement>(".tape")
document.querySelector(".ctabs")?.addEventListener("tabchange", () => {
  if (!tape) return
  tape.classList.remove("play")
  void tape.offsetWidth
  tape.classList.add("play")
})

// Copy, in the Connect panes and on each `npx stdartifacts serve`: the clipboard when it's allowed; otherwise select the text so copying is one keystroke away.
const copyStatus = document.querySelector<HTMLElement>("[data-copy-status]")
for (const button of document.querySelectorAll<HTMLButtonElement>(".copy")) {
  let reset = 0
  button.addEventListener("click", async () => {
    const pre = button.closest(".pane, .cmd")?.querySelector("pre, code")
    if (!pre) return
    let label = "Copied"
    try {
      await navigator.clipboard.writeText(pre.textContent ?? "")
    } catch {
      const range = document.createRange()
      range.selectNodeContents(pre)
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      label = "Selected"
    }
    button.textContent = label
    if (copyStatus) copyStatus.textContent = label === "Copied" ? "Copied to the clipboard." : "Text selected. Press Command or Control C to copy."
    clearTimeout(reset)
    reset = window.setTimeout(() => {
      button.textContent = "Copy"
      if (copyStatus) copyStatus.textContent = ""
    }, 1400)
  })
}
