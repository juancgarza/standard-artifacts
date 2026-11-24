// Writes src/og-base.jpg: the social image without its logo (the build adds the
// logo from src/logo.svg). It starts from the committed dusk painting, so the
// name or headline can change without the masters:
//
//   pnpm --filter @standard-artifacts/landing og
//
// The fonts come from the machine it runs on; the committed file was made on macOS.
import { join } from "node:path"
import sharp from "sharp"

const app = join(import.meta.dirname, "..")

// The dusk hero, cropped around the figures. Horizon and figures sit in the lower quarter, so the crop keeps the bottom.
const OG = { width: 1200, height: 630 }
const PAINTING = join(app, "public/img/scene-dusk-1536.webp")
const scale = OG.width / 1536
const painted = await sharp(PAINTING)
  .extract({ left: 0, top: 150, width: 1536, height: Math.round(OG.height / scale) })
  .resize(OG)
  .toBuffer()

const headline = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG.width}" height="${OG.height}">
  <defs><linearGradient id="w" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".62"/><stop offset=".75" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
  <rect width="${OG.width}" height="${OG.height}" fill="url(#w)"/>
  <text x="118" y="101" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600">Standard Artifacts</text>
  <g fill="#fff" font-family="'Iowan Old Style', Georgia, serif" font-size="64">
    <text x="64" y="236">Open-source artifacts</text>
    <text x="64" y="310">you and your agents</text>
    <text x="64" y="384">work on <tspan fill="#ffd3ae" font-style="italic">together</tspan>.</text>
  </g>
</svg>`

await sharp(painted)
  .composite([{ input: Buffer.from(headline) }])
  .jpeg({ quality: 82, mozjpeg: true })
  .toFile(join(app, "src/og-base.jpg"))
console.log("src/og-base.jpg")
