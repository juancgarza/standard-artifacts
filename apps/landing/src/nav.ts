/** The small-screen menu, the "you are here" highlight, and the Markdown view. */
export function setupNav() {
  const button = document.querySelector<HTMLButtonElement>(".menu-btn")
  const menu = document.getElementById("site-nav")
  if (button && menu) {
    const setOpen = (open: boolean) => {
      button.setAttribute("aria-expanded", String(open))
      menu.toggleAttribute("data-open", open)
    }
    button.addEventListener("click", () => setOpen(button.getAttribute("aria-expanded") !== "true"))
    menu.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a, button")) setOpen(false)
    })
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && button.getAttribute("aria-expanded") === "true") {
        setOpen(false)
        button.focus()
      }
    })
  }

  // Which section is under the middle of the screen. Surfaces belongs to Overview.
  const links = new Map([...document.querySelectorAll<HTMLAnchorElement>("[data-spy]")].map((a) => [a.dataset.spy!, a]))
  const mark = (id: string) => {
    for (const [key, link] of links) {
      if (key === id) link.setAttribute("aria-current", "true")
      else link.removeAttribute("aria-current")
    }
  }
  mark("top")
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) mark(entry.target.id === "surfaces" ? "top" : entry.target.id)
      }
    },
    { rootMargin: "-45% 0px -50% 0px" },
  )
  for (const id of ["top", "surfaces", "runs", "connect", "plans", "faq"]) {
    const section = document.getElementById(id)
    if (section) spy.observe(section)
  }

  const markdown = document.getElementById("markdown")
  const views = [...document.querySelectorAll<HTMLButtonElement>("[data-view]")]
  const show = (asMarkdown: boolean) => {
    document.documentElement.toggleAttribute("data-markdown", asMarkdown)
    if (markdown) markdown.hidden = !asMarkdown
    for (const v of views) v.setAttribute("aria-pressed", String((v.dataset.view === "markdown") === asMarkdown))
  }
  for (const view of views) {
    view.addEventListener("click", () => {
      show(view.dataset.view === "markdown")
      scrollTo({ top: 0, behavior: "instant" })
    })
  }
  // The nav's anchors live in the page view, so following one comes back to it.
  document.addEventListener("click", (event) => {
    if ((event.target as Element).closest('a[href^="#"]')) show(false)
  })
}
