/** The recorder's script is the heaviest on the page, so it loads as the figure comes near. */
export function setupRecorder() {
  const root = document.getElementById("rr")
  if (!root) return
  const near = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      near.disconnect()
      void import("./figure.js").then(({ mountRecorder }) => mountRecorder(root))
    },
    { rootMargin: "600px 0px" },
  )
  near.observe(root)
}
