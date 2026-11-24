(function () {
  // Runs before first paint. CSS follows the system on its own; a saved choice
  // sets data-theme here, so the wrong theme never flashes. Then only the hero
  // painting for the theme on screen is preloaded.
  var root = document.documentElement
  var theme = null
  root.classList.add("js")
  try {
    theme = localStorage.getItem("theme")
  } catch (e) {}
  if (theme === "light" || theme === "dark") root.dataset.theme = theme
  else theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  var link = document.createElement("link")
  link.rel = "preload"
  link.as = "image"
  link.type = "image/webp"
  link.fetchPriority = "high"
  link.imageSrcset = theme === "dark" ? %HERO_DUSK% : %HERO_DAY%
  link.imageSizes = %HERO_SIZES%
  document.head.appendChild(link)
})()
