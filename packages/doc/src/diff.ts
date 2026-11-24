/** A run of text that is unchanged, removed, or added. */
export type DiffPart = { kind: "same" | "del" | "add"; text: string }

/**
 * Beyond this many token pairs the LCS table gets too big for a keystroke-speed
 * render (a 20k-character block is ~4k tokens). Huge rewrites then show as
 * "all removed, all added", which is what they are anyway.
 */
const MAX_CELLS = 2_000_000

/** Words and the whitespace between them, so a diff never splits a word and spacing survives. */
const tokenize = (text: string) => text.match(/\s+|[^\s]+/g) ?? []

/**
 * Word-level diff of `before` → `after` (longest common subsequence over
 * word/space tokens). Within each changed stretch, removals come before
 * additions, so it reads "~~old words~~ new words" like a tracked change.
 */
export function wordDiff(before: string, after: string): Array<DiffPart> {
  if (before === after) return before ? [{ kind: "same", text: before }] : []
  const a = tokenize(before)
  const b = tokenize(after)
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return tidy([{ kind: "del", text: before }, { kind: "add", text: after }])

  // lcs[i * (m + 1) + j] = length of the LCS of a[i..] and b[j..].
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    }
  }

  const parts: Array<DiffPart> = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      parts.push({ kind: "same", text: a[i]! })
      i++
      j++
    } else if (j < m && (i === n || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
      parts.push({ kind: "add", text: b[j]! })
      j++
    } else {
      parts.push({ kind: "del", text: a[i]! })
      i++
    }
  }
  return tidy(parts)
}

/**
 * Make the diff readable: a lone space kept between two changes is folded into
 * them (otherwise "a b c" → "x y z" reads as three separate edits), and each
 * changed stretch is regrouped as one removal followed by one addition.
 */
function tidy(parts: Array<DiffPart>): Array<DiffPart> {
  const changed = (p: DiffPart | undefined) => !!p && p.kind !== "same"
  const folded = parts.flatMap((p, k): Array<DiffPart> =>
    p.kind === "same" && /^\s+$/.test(p.text) && changed(parts[k - 1]) && changed(parts[k + 1])
      ? [{ kind: "del", text: p.text }, { kind: "add", text: p.text }]
      : [p],
  )
  const out: Array<DiffPart> = []
  let del = ""
  let add = ""
  const flushChange = () => {
    // Whitespace both sides end with is unchanged; keep it out of the highlights so they hug the words.
    const space = del && add ? (/\s+$/.exec(del)?.[0] ?? "") : ""
    const shared = space && add.endsWith(space) ? space : ""
    if (shared) {
      del = del.slice(0, -shared.length)
      add = add.slice(0, -shared.length)
    }
    if (del) out.push({ kind: "del", text: del })
    if (add) out.push({ kind: "add", text: add })
    if (shared) out.push({ kind: "same", text: shared })
    del = add = ""
  }
  for (const p of folded) {
    if (p.kind === "del") del += p.text
    else if (p.kind === "add") add += p.text
    else {
      flushChange()
      const last = out.at(-1)
      if (last?.kind === "same") last.text += p.text
      else out.push({ ...p })
    }
  }
  flushChange()
  return out.filter((p) => p.text !== "")
}
