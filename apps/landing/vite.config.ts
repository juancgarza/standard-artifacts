import { readFileSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { defineConfig, type Plugin } from "vite"
import * as config from "./src/config.ts"
import images from "./src/images.json" with { type: "json" }

const app = import.meta.dirname
const read = (path: string) => readFileSync(join(app, path), "utf8")

/** The `%NAME%` values shared by the page and the Markdown view: every export of config.ts. */
const fill = (text: string) => Object.entries(config).reduce((out, [name, value]) => out.replaceAll(`%${name}%`, value), text)
const { SITE_URL } = config

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

type ImageName = keyof typeof images

function srcset(name: string, prefix: string) {
  const image = images[name as ImageName]
  if (!image) throw new Error(`No image called "${name}". Is it in scripts/optimize-images.mjs?`)
  return image.widths.map((w) => `${prefix}img/${name}-${w}.webp ${w}w`).join(", ")
}

/** Layers of the hero that the head script preloads, one per theme. */
const HERO_SIZES = "(min-width: 1024px) max(980px, calc((100vw - 220px) * .928)), (min-width: 560px) 980px, 1240px"

/**
 * `<x-img name sizes alt class priority>`: an <img> with srcset, intrinsic size
 * and lazy loading, from the manifest the image script writes. Images are lazy
 * so the theme that isn't showing (display: none) never downloads.
 */
function expandImages(html: string) {
  return html.replace(/<x-img\s+([^>]*?)\s*\/?>/g, (_, attrs: string) => {
    const get = (key: string) => attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1]
    const name = get("name")!
    const image = images[name as ImageName]
    if (!image) throw new Error(`No image called "${name}"`)
    const sizes = get("sizes") ?? (name.startsWith("scene-") ? HERO_SIZES : undefined)
    const rest = attrs.replace(/(?:^|\s)(?:name|sizes)="[^"]*"/g, "").trim()
    const middle = image.widths[Math.floor(image.widths.length / 2)]
    return `<img src="/img/${name}-${middle}.webp" srcset="${srcset(name, "/")}" sizes="${sizes}" width="${image.width}" height="${image.height}" loading="lazy" decoding="async" ${rest}>`
  })
}

/** `<!-- include path -->`; `.md` is escaped for a <pre>. */
function expandIncludes(html: string) {
  return html.replace(/<!--\s*include\s+(\S+)\s*-->/g, (_, path: string) => {
    const text = fill(read(path))
    return path.endsWith(".md") ? escapeHtml(text) : text.trim()
  })
}

function heroPreload(script: string) {
  return script
    .replace("%HERO_DAY%", JSON.stringify(srcset("scene-day", "")))
    .replace("%HERO_DUSK%", JSON.stringify(srcset("scene-dusk", "")))
    .replace("%HERO_SIZES%", JSON.stringify(HERO_SIZES))
}

/** librsvg has no custom properties, so the logo's `var(--x, #hex)` fills become plain hex. */
const flatLogo = () => Buffer.from(read("src/logo.svg").replace(/var\(--[\w-]+,\s*(#[0-9a-fA-F]+)\)/g, "$1"))

function landing(): Plugin {
  return {
    name: "landing",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => heroPreload(fill(expandImages(expandIncludes(html)))),
    },
    // The generated files: everything that comes from the logo, or from config.ts.
    async generateBundle() {
      const emit = (fileName: string, source: string | Buffer) => this.emitFile({ type: "asset", fileName, source })
      const logo = flatLogo()
      const mark = async (size: number, inset: number) =>
        sharp({ create: { width: size, height: size, channels: 4, background: "#ffffff" } })
          .composite([{ input: await sharp(logo).resize(size - inset * 2).toBuffer() }])
          .png()
          .toBuffer()
      emit("favicon-32.png", await sharp(logo).resize(32).png().toBuffer())
      emit("apple-touch-icon.png", await mark(180, 34))
      emit(
        "og.jpg",
        await sharp(join(app, "src/og-base.jpg"))
          .composite([{ input: await sharp(logo).resize(40).toBuffer(), left: 64, top: 70 }])
          .jpeg({ quality: 82, mozjpeg: true })
          .toBuffer(),
      )
      emit("index.md", fill(read("src/page.md")))
      emit("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`)
      emit(
        "sitemap.xml",
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc></url>\n</urlset>\n`,
      )
    },
  }
}

export default defineConfig({
  // Relative URLs: dist/ can be served from any host or path.
  base: "./",
  plugins: [landing()],
})
