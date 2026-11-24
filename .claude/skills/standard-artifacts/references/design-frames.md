# Design frames

The rules live in `packages/protocol/src/design.ts`. Anything not allowed is dropped when the HTML is parsed, with no error. The returned outline is the only sign, so read it.

## Limits

| Limit | Value | When exceeded |
|---|---|---|
| Whole frame, as JSON | 200,000 characters | Write fails with an error |
| One image URL | 150,000 characters | **`src` dropped with no error** |
| Layers | 3,000, but the JSON limit usually comes first (2,500 bare `<p>`s failed) | Extra layers dropped with no error |
| Depth | 48 | Deeper levels are flattened with no error |
| Text in one layer | 10,000 characters | Cut off with no error |
| Html embed source | 200,000 characters | Write fails with an error |

Repeated data URIs count every time, so reuse small ones sparingly.

## HTML

**Kept:** `div section header footer nav main article aside span p h1 h2 h3 h4 strong em small a button img input label ul ol li hr`

**Mapped:** `b`→`strong`, `i`→`em`, `h5`/`h6`→`h4`, `figure`/`blockquote`/`form`→`div`, `pre`/`figcaption`/`address`→`p`

**Unwrapped, keeping the text:** anything else, including `table`, `tr` and `td`. A table's cells run together (`cell1cell2`), so build rows with grid or flex.

**Converted:** an inline `<svg>` becomes an `<img>` of the same picture (its stylesheet paint, `currentColor` and tokens are written into it; scripts and handlers are removed). `<br>` becomes a line break in the text, and its element gets `white-space: pre-line`. `::before` and `::after` with `content` become `span` layers at the start and end of their element.

**Removed with their contents:** `script style canvas video audio iframe select textarea` and similar. `<style>` rules are inlined first.

## Images and links

- `src` and `background: url()` accept `https:` or `data:image/…`. `http:` is dropped.
- For icons, write an inline `<svg>` (it's stored as an image) or `<img src="data:image/svg+xml;base64,…">`. An SVG data URI in `url("…")` may be readable markup; it's stored as base64. Once stored, an icon is a picture: recoloring it means replacing it.
- Small JPEG data URIs work for thumbnails. Uploaded board assets (`/api/v1/…`) don't work in frames.
- `href` accepts `https:`, `mailto:` and `#anchor`.

## CSS

Inline `style=""` is the real storage, and `<style>` rules are inlined into it when HTML comes in, so a snippet built on a design system keeps its look:

- **Selectors:** tags, `.class`, `#id`, `[attr]` and `[attr="value"]`, `*`, descendant, `>`, `+` and `~`, `:first-child`, `:last-child`, `:nth-child()`, the `-of-type` ones, and `:not()`. `body`, `html` and `:root` rules move to the root.
- **Tokens:** `var(--x, fallback)` is replaced by the value the custom property has on that element (inherited, or set by a rule or inline). A declaration whose token is unknown is dropped. Custom properties themselves aren't stored, so changing a token later means editing the layers that used it.
- **Cascade:** specificity, source order and `!important` are respected. `font` (the shorthand) is spelled out as its longhands.
- **Skipped:** rules about a state (`:hover`, `:focus-visible`, `:checked`), `@media`, `@font-face` and other at-rules. `class`, `id` and `data-*` attributes aren't kept.

**Allowed:**

- **Layout:** `display` (block, inline, inline-block, flex, inline-flex, grid, inline-grid, none, contents, flow-root), flex and grid properties, except that `grid-template-areas` and `grid-area` aren't allowed; `gap`, `padding`, `margin`, `position` (not `fixed`), `top`/`right`/`bottom`/`left`/`inset`, `z-index`, `overflow`, `overflow-x`, `overflow-y`, `box-sizing`
- **Size:** `width`, `height`, min and max variants, `aspect-ratio`, `object-fit`, `object-position`, `transform`, `transform-origin` (a frame clips its own painting, so nothing leaves it)
- **Fill and border:** `background` and its parts including `background-clip`, `opacity`, `border` and its parts (per side too), `outline`, `border-radius`, `box-shadow`
- **Shape:** `clip-path` (basic shapes), `mask` and its parts (gradients, `https:` or data images)
- **Type:** `color`, `font-size`, `font-weight`, `font-style`, `font-family`, `line-height`, `letter-spacing`, `text-align`, `text-transform`, `text-decoration`, `white-space`, `word-break`, `text-overflow`, `vertical-align`, `list-style`, `font-variant-numeric`, `font-feature-settings`

**Dropped, which often surprises people:** `transition`, `animation`, `filter`, `backdrop-filter`, `cursor`, `float`, `visibility`, `pointer-events`. When patching a layer directly (`board_update_design` patches, the inspector), `var(--x)`, `font` and `!important` are refused: those are only resolved when HTML is parsed.

Value functions allowed: `rgb rgba hsl hsla hwb lab lch oklab oklch color-mix calc min max clamp minmax repeat fit-content`, the linear, radial and conic gradients, the transform functions (`translate scale rotate skew matrix`) and the basic shapes (`polygon circle ellipse inset`).

## Fonts

Allowed families: `system-ui -apple-system ui-sans-serif ui-serif ui-monospace sans-serif serif monospace cursive Inter Helvetica "Helvetica Neue" Arial "Segoe UI" Roboto Georgia "Times New Roman" "Courier New" Menlo Monaco "SF Pro Text" "SF Mono"`

Frames load no web fonts, so a listed family renders only if the viewer has it installed. Checked in headless Chrome on a Mac without them:

| CSS | Rendered as |
|---|---|
| no `font-family` | system font |
| `Inter, -apple-system, system-ui, sans-serif` | system font (not Inter) |
| `Inter` | **Times** |
| `Roboto` | **Times** |
| `Segoe UI` | **Times** |
| `Helvetica` | Helvetica |
| `Georgia` | Georgia |

## Frame or embed?

| | Design frame | Html embed |
|---|---|---|
| People edit layers | Yes | No |
| Scripts | No | Yes (sandboxed) |
| `<canvas>`, live `<svg>`, `:hover` and other states, web fonts | No | Yes |
| Network | `https:` images | `https:` images only; `fetch` and `http:` are blocked |
| Read back | `board_get_design` | `board_get_html` |
| Edit | `board_update_design` | `board_update` with `html` |
