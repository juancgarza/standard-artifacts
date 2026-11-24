/**
 * Copy and paste between the grid and spreadsheets. Copies are TSV, which
 * Sheets, Excel, Airtable and Notion all paste as cells; pastes accept TSV,
 * CSV, or plain lines of text.
 */

/** Rows of text as TSV, quoting fields with tabs, newlines or quotes the way spreadsheets do. */
export function toTSV(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const field = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return rows.map((r) => r.map(field).join("\t")).join("\n")
}

/** Split delimited text into rows of fields, honoring "quoted" fields that hold delimiters, quotes or newlines. */
function parseDelimited(text: string, delimiter: string): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === "") quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += ch
  }
  row.push(field)
  rows.push(row)
  return rows
}

/**
 * Clipboard text as a grid of strings. Tabs mean TSV (what spreadsheets copy).
 * Several lines with the same number of commas mean CSV. Anything else is one
 * column, one value per line, so a sentence with commas stays one value.
 */
export function parseClipboard(raw: string): Array<Array<string>> {
  // Spreadsheets end a copy with a newline; it isn't an extra empty row.
  const text = raw.replace(/\r?\n$/, "")
  if (text.includes("\t")) return parseDelimited(text, "\t")
  if (/[\r\n]/.test(text)) {
    const csv = parseDelimited(text, ",")
    const width = csv[0]?.length ?? 0
    if (width > 1 && csv.every((r) => r.length === width)) return csv
    return text.split(/\r?\n/).map((line) => [line])
  }
  return [[text]]
}
