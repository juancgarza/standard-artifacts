/**
 * HTML embeds: a live snippet (mockup, chart, widget, mini-app) rendered on the
 * canvas in a sandboxed iframe.
 *
 * Security model, in layers:
 * - `sandbox="allow-scripts"` without `allow-same-origin` gives the snippet an
 *   opaque origin: it can't reach the app's DOM, cookies, storage or session,
 *   and API calls it made would carry no credentials. No `allow-top-navigation`,
 *   `allow-popups`, `allow-forms` or `allow-modals`, so it can't navigate the
 *   app, open windows, submit forms or block the page with alert().
 * - A CSP inside the document keeps snippets self-contained: inline scripts and
 *   styles only, images over https or data:, and no network otherwise (no
 *   fetch/XHR/WebSocket, no external scripts, styles, frames or workers). A
 *   board is shared, so a snippet should look the same for everyone and not turn
 *   into a beacon or a remote-controlled page for each viewer; https images are
 *   the one deliberate exception, because mockups need them. The CSP meta comes
 *   first in the document, so nothing in the snippet runs before it applies, and
 *   any CSP a snippet adds can only tighten it.
 * - If the snippet navigates its own frame away (location = …, meta refresh),
 *   the view notices the second load and replaces it with a notice instead of
 *   showing a page from elsewhere on the board.
 */

export const htmlSandbox = "allow-scripts"

export const htmlCsp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src https: data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

/** Posted by the frame when Escape is pressed inside it, so the canvas can leave interact mode (keys inside the frame never reach the app). */
export const exitMessage = "standard-artifacts:html-exit"

/**
 * The iframe document. The snippet is appended after our head and an opened
 * body: a full document's own doctype, <html>, <head> and <body> tags are then
 * merged or ignored by the parser, and its <style>, <script> and <title> still
 * work, so fragments and whole pages both render.
 */
export function srcdoc(html: string): string {
  return (
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${htmlCsp}">` +
    `<meta charset="utf-8"><meta name="color-scheme" content="light">` +
    `<style>body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f1f1d;background:#fff}</style>` +
    `<script>addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage({type:"${exitMessage}"},"*")},true)</script>` +
    `</head><body>${html}`
  )
}

/**
 * Whether pasted text is HTML someone meant to embed: a document, or markup that
 * starts with a common element and closes something. Plain prose with a stray
 * "<" doesn't qualify, and neither does a single self-closing tag.
 */
export function looksLikeHtml(text: string): boolean {
  const t = text.trim()
  if (t.length < 7 || !t.startsWith("<") || !t.endsWith(">")) return false
  if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) return true
  const tags =
    "div|svg|canvas|style|script|section|main|article|header|footer|nav|aside|table|ul|ol|p|h[1-6]|span|button|form|input|label|img|a|figure|details|body|head|template|pre|blockquote"
  return new RegExp(`^<(?:${tags})[\\s>/]`, "i").test(t) && /<\/[a-z][a-z0-9-]*\s*>/i.test(t)
}

/** A snippet's <title> (or first heading) as the shape's caption. */
export function titleOf(html: string): string | undefined {
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html) ?? /<h[1-3][^>]*>([^<]{1,120})<\/h[1-3]>/i.exec(html)
  const t = m?.[1]?.trim()
  return t || undefined
}

export const htmlDefaults = { w: 480, h: 360 }

/** What the toolbar button creates: small, but shows that embeds are live. */
export const starterHtml = `<style>
  body { display: grid; place-items: center; height: 100vh; background: linear-gradient(135deg, #eef2ff, #fdf2f8); }
  .card { text-align: center; padding: 24px 32px; border-radius: 14px; background: #fff; box-shadow: 0 6px 24px rgb(0 0 0 / 0.08); }
  h1 { margin: 0 0 4px; font-size: 18px; }
  p { margin: 0 0 16px; color: #6b6b66; }
  button { font: inherit; padding: 8px 16px; border: 0; border-radius: 8px; background: #2f6fed; color: #fff; cursor: pointer; }
</style>
<div class="card">
  <h1>Hello from HTML</h1>
  <p>Double-click to interact. Edit HTML to change me.</p>
  <button id="b">Clicked 0 times</button>
</div>
<script>
  let n = 0
  const b = document.getElementById("b")
  b.onclick = () => { n++; b.textContent = "Clicked " + n + " time" + (n === 1 ? "" : "s") }
</script>
`
