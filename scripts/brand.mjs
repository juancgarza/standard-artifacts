// Writes every logo, icon and pattern file from the definitions below, so the brand has one source:
//
//   node scripts/brand.mjs
//
// The mark is a Talavera tile: a cream glazed square, a quarter-disc of each artifact colour in the
// corners (table, board, doc, tracker) and a cobalt italic S. Tiles laid side by side meet in
// four-colour circles, which is the pattern. See assets/brand/README.md.
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const root = join(import.meta.dirname, "..")
// sharp is the landing page's dependency; borrowing it keeps this script dependency-free at the root.
const sharp = createRequire(join(root, "apps/landing/package.json"))("sharp")

export const COLORS = { cream: "#f3ecdc", cobalt: "#1d3fa6", table: "#1f9d6b", board: "#e0a100", doc: "#2457f5", tracker: "#c2410c" }
const C = COLORS
const CORNERS = [[0, 0, C.table], [24, 0, C.board], [0, 24, C.doc], [24, 24, C.tracker]]

/** The S from Fraunces 700 Italic (SIL Open Font License), outlined so it renders without the font. Ink is 14 units tall, centred on (12, 12.1). */
const S_PATH = "M11.36 19.10L11.36 19.10Q10.54 19.10 9.99 18.94Q9.43 18.78 9.09 18.58Q8.74 18.37 8.53 18.21Q8.32 18.05 8.17 18.05L8.17 18.05Q8.04 18.05 7.85 18.19Q7.66 18.34 7.45 18.53Q7.23 18.72 7.01 18.87Q6.80 19.02 6.58 19.02L6.58 19.02Q6.26 19.02 6.09 18.84Q5.93 18.67 5.96 18.28L5.96 18.28L6.38 14.87Q6.41 14.47 6.59 14.25Q6.78 14.04 7.07 14.04L7.07 14.04Q7.35 14.04 7.52 14.23Q7.69 14.42 7.86 14.80L7.86 14.80L8.13 15.93Q8.37 16.90 9.05 17.40Q9.74 17.90 10.64 17.90L10.64 17.90Q11.17 17.90 11.56 17.71Q11.95 17.53 12.19 17.19Q12.43 16.86 12.50 16.41L12.50 16.41Q12.64 15.63 12.20 14.93Q11.76 14.23 10.50 13.47L10.50 13.47Q9.02 12.57 8.41 11.58Q7.80 10.60 7.95 9.27L7.95 9.27Q8.08 8.14 8.75 7.19Q9.42 6.25 10.62 5.67Q11.82 5.10 13.55 5.10L13.55 5.10Q15.04 5.10 16.05 5.57Q17.07 6.04 17.58 6.79Q18.08 7.54 18.04 8.34L18.04 8.34Q18.00 8.99 17.67 9.41Q17.34 9.84 16.73 9.84L16.73 9.84Q16.26 9.84 15.96 9.57Q15.65 9.30 15.44 8.66L15.44 8.66L15.23 7.86Q15.00 7.01 14.51 6.59Q14.03 6.18 13.34 6.18L13.34 6.18Q12.74 6.18 12.28 6.43Q11.83 6.68 11.56 7.10Q11.29 7.52 11.23 8.05L11.23 8.05Q11.11 8.87 11.54 9.57Q11.98 10.27 13.17 11.05L13.17 11.05Q14.41 11.86 15.07 12.58Q15.72 13.29 15.94 14.03Q16.16 14.77 16.06 15.61L16.06 15.61Q15.95 16.64 15.33 17.42Q14.71 18.20 13.69 18.65Q12.67 19.10 11.36 19.10Z"
const s = (attrs, scale = 1) => `<path d="${S_PATH}" ${attrs}${scale === 1 ? "" : ` transform="translate(12 12.1) scale(${scale}) translate(-12 -12.1)"`}/>`

/** The logo: one tile, big corners, heavy S. Holds up at 16px. */
const markBody = (id) =>
  `<clipPath id="${id}"><rect width="24" height="24" rx="4"/></clipPath>` +
  `<g clip-path="url(#${id})"><rect width="24" height="24" fill="${C.cream}"/>${CORNERS.map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="7.2" fill="${c}"/>`).join("")}</g>` +
  // A cream keyline keeps the S off the corner discs.
  s(`fill="${C.cobalt}" stroke="${C.cream}" stroke-width="1.4" stroke-linejoin="round" paint-order="stroke"`)
const svg = (body, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${attrs}>${body}</svg>\n`
const mark = svg(markBody("sa-mark"), 'width="24" height="24"')

/** One colour (currentColor): a thin cut rings each corner and the S is cut out, so the tile keeps its square outline. For print, stamps and template icons. */
const markMono = svg(
  `<mask id="sa-mono"><rect width="24" height="24" rx="4" fill="#fff"/>${CORNERS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8.6" fill="#000"/><circle cx="${x}" cy="${y}" r="7.2" fill="#fff"/>`).join("")}${s('fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round" paint-order="stroke"')}</mask><rect width="24" height="24" rx="4" fill="currentColor" mask="url(#sa-mono)"/>`,
  'width="24" height="24"',
)

/** The pattern tile: square-cornered, with three petals around each corner, so four tiles meet in a four-colour flower. */
const petals = (x, y, c, base) =>
  `<circle cx="${x}" cy="${y}" r="3.2" fill="${c}"/>` +
  [15, 45, 75].map((a) => { const r = ((base + a) * Math.PI) / 180; return `<circle cx="${(x + 6.4 * Math.cos(r)).toFixed(2)}" cy="${(y + 6.4 * Math.sin(r)).toFixed(2)}" r="2" fill="${c}"/>` }).join("")
const BASES = [0, 90, 270, 180]
const patternBody = (ground, ink, colors) =>
  `<clipPath id="sa-tile"><rect width="24" height="24"/></clipPath><g clip-path="url(#sa-tile)">${ground ? `<rect width="24" height="24" fill="${ground}"/>` : ""}${CORNERS.map(([x, y, c], i) => petals(x, y, colors ? c : ink, BASES[i])).join("")}</g>${s(`fill="${ink}"`, 0.78)}`
const pattern = svg(patternBody(C.cream, C.cobalt, true), 'width="24" height="24"')
/** The same tile in one colour on transparent, for a faint watermark behind text. */
const watermark = svg(patternBody(null, "#000", false), 'width="24" height="24"')

/** A macOS-style app icon: the tile on a 1024 canvas with the system's margin and a soft shadow. */
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".28"/></filter></defs>
<g filter="url(#sh)"><g transform="translate(100 100) scale(${824 / 24})">${markBody("sa-icon").replace('rx="4"', 'rx="5.4"')}</g></g></svg>`

const write = (path, data) => { const p = join(root, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); console.log(path) }
const png = (src, size) => sharp(Buffer.from(src), { density: 72 * Math.ceil(size / 24) }).resize(size, size).png().toBuffer()

write("assets/brand/mark.svg", mark)
write("assets/brand/mark-mono.svg", markMono)
write("assets/brand/pattern.svg", pattern)
write("assets/brand/watermark.svg", watermark)
write("assets/brand/app-icon.svg", appIcon)
write("assets/brand/mark-512.png", await png(mark, 512))
write("assets/brand/app-icon.png", await sharp(Buffer.from(appIcon)).png().toBuffer())
// The landing page builds its favicons and social image from src/logo.svg.
write("apps/landing/src/logo.svg", mark)
write("apps/landing/src/brand/pattern.svg", pattern)
write("apps/landing/src/brand/watermark.svg", watermark)
// The app.
write("apps/app/public/favicon.svg", mark)
write("apps/app/public/favicon-32.png", await png(mark, 32))
// iOS rounds the corners itself, so this one is square and full-bleed.
write("apps/app/public/apple-touch-icon.png", await png(svg(markBody("sa-touch").replace('rx="4"', 'rx="0"')), 180))
// The desktop app: electron-builder makes the .icns and .ico from this.
write("apps/desktop/build/icon.png", await sharp(Buffer.from(appIcon)).png().toBuffer())
