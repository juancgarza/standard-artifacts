/**
 * The ARIA tabs pattern with automatic activation: one tab stop for the list,
 * arrow keys and Home/End move and select. Panels show through `data-active`
 * so the same markup also works in CSS before and without JavaScript.
 */
export function setupTabs(list: HTMLElement) {
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')]
  const panelOf = (tab: HTMLElement) => document.getElementById(tab.getAttribute("aria-controls") ?? "")

  const select = (next: HTMLElement) => {
    for (const tab of tabs) {
      const on = tab === next
      tab.setAttribute("aria-selected", String(on))
      tab.tabIndex = on ? 0 : -1
      panelOf(tab)?.toggleAttribute("data-active", on)
    }
    list.dispatchEvent(new Event("tabchange"))
  }

  tabs.forEach((tab, at) => {
    tab.addEventListener("click", () => select(tab))
    tab.addEventListener("keydown", (event) => {
      const to =
        event.key === "ArrowRight" ? (at + 1) % tabs.length
        : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
        : event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
        : -1
      const next = tabs[to]
      if (!next) return
      event.preventDefault()
      next.focus()
      select(next)
    })
  })
}
