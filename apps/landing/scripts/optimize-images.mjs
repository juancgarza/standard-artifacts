// Turns the master PNGs into the responsive WebP files the page ships.
// The masters (2-3 MB each) are not committed; only the output in public/img is.
//
//   pnpm --filter @standard-artifacts/landing images /path/to/masters
//
// The masters folder holds bg/, spots/ and lore-*.png, laid out as in SPEC below.
// Writes public/img/*.webp and src/images.json (what vite.config.ts builds srcset
// from), then runs og-image.mjs for src/og-base.jpg. The social image is made
// from public/img, so changing its words doesn't need the masters.
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const masters = process.argv[2]
if (!masters) throw new Error("Usage: optimize-images.mjs <masters folder>")

const app = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(app, "public/img")

const PAINTING = { widths: [800, 1200, 1536], quality: 76 }
const PLATE = { widths: [480, 800, 1200], quality: 72 }
const SCREEN = { widths: [640, 960, 1440, 1920], quality: 80, smartSubsample: true }

const SPEC = {
  "scene-day": ["bg/paint-anime-day2.png", PAINTING],
  "scene-dusk": ["bg/paint-anime.png", PAINTING],
  "close-day": ["spots/golden.png", PAINTING],
  "close-dusk": ["spots/night.png", PAINTING],
  ...Object.fromEntries(
    ["table", "board", "doc", "tracker"].flatMap((k) => [
      [`plate-${k}-day`, [`spots/${k}-day.png`, PLATE]],
      [`plate-${k}-dusk`, [`spots/${k}-dusk.png`, PLATE]],
      [`shot-${k}-day`, [`lore-${k}.png`, SCREEN]],
      [`shot-${k}-dusk`, [`lore-dark-${k}.png`, SCREEN]],
    ]),
  ),
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const manifest = {}
let total = 0
for (const [name, [file, { widths, quality, smartSubsample }]] of Object.entries(SPEC)) {
  const master = sharp(join(masters, file))
  const { width, height } = await master.metadata()
  for (const w of widths) {
    const buf = await master.clone().resize({ width: w }).webp({ quality, effort: 6, smartSubsample }).toBuffer()
    await writeFile(join(out, `${name}-${w}.webp`), buf)
    total += buf.length
  }
  manifest[name] = { width, height, widths }
}
await writeFile(join(app, "src/images.json"), JSON.stringify(manifest, null, 2) + "\n")

// The social image is made from the dusk painting just written.
await import("./og-image.mjs")

console.log(`${Object.keys(SPEC).length} images, ${(total / 1024 / 1024).toFixed(2)} MB of WebP in public/img`)
