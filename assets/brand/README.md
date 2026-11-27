# Brand

The mark is a Talavera tile: a cream glazed square, a quarter-disc of each artifact colour in the corners, and a cobalt italic S. Lay tiles side by side and the corners meet in four-colour circles, which is the pattern. A standard artifact is one unit that repeats into something bigger.

Every file here, and the copies in the apps, comes from `scripts/brand.mjs`. Change the definitions there and run `node scripts/brand.mjs`; don't edit the SVGs by hand.

| File | Use |
|---|---|
| `mark.svg`, `mark-512.png` | The logo. Favicons, the landing header, the sign-in page, the social image. Holds up at 16px. |
| `mark-mono.svg` | One colour (`currentColor`), with the corners and the S cut out. Print, stamps, embossing, template icons. |
| `app-icon.svg`, `app-icon.png` | The desktop app icon: the tile on a 1024 canvas with macOS's margin and shadow. |
| `pattern.svg` | One square tile of the pattern: three petals around each corner, so four tiles meet in a four-colour flower. Repeat it as a border or a background. |
| `watermark.svg` | The pattern tile in one colour on transparent, for a faint watermark behind text (use it as a CSS mask). |

Where the copies go: `apps/landing/src/logo.svg` and `apps/landing/src/brand/` (the landing build makes its favicons and `og.jpg` from `logo.svg`), `apps/app/public/` (favicons), `apps/desktop/build/icon.png` (electron-builder makes the `.icns` and `.ico`).

## Colours

| | Hex | Means |
|---|---|---|
| Cream | `#f3ecdc` | the glazed ground |
| Cobalt | `#1d3fa6` | the S, the ink |
| Jade | `#1f9d6b` | tables |
| Ochre | `#e0a100` | boards |
| Blue | `#2457f5` | docs |
| Terracotta | `#c2410c` | trackers |

The corners always run table, board / doc, tracker, left to right and top to bottom, as in the app.

## Rules

- Keep the tile cream on both light and dark backgrounds; it reads like a glazed tile either way.
- The four colours are accents in the corners, never four equal squares.
- At small sizes use the mark alone. The pattern and anything with fine lines belongs at 40px and up.

The S is outlined from Fraunces 700 Italic by Undercase Type, under the SIL Open Font License 1.1.
