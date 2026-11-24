import { createContext, useContext, type ReactNode } from "react"
import { kindOfId } from "@standard-artifacts/protocol"
import { artifactHref } from "./model"

/**
 * Where links in issue text go. `stdartifacts://board/b_…` (and table, doc, tracker)
 * opens that artifact in the app; `stdartifacts://tracker/<id>/<n>` and "#12" open an
 * issue. Anything else (https:) opens in a new tab. Text written under the old
 * names says `ah://`, `common-artifacts://` or `commonartifacts://`, which still work.
 */
export interface MarkdownLinks {
  readonly openArtifact?: (artifactId: string) => void
  /** An issue in this tracker, by number. */
  readonly openIssue?: (number: number) => void
  /** Whether "#n" names a real issue here (so "#1" in prose links only when it should). */
  readonly hasIssue?: (number: number) => boolean
  readonly trackerId?: string
}

export const MarkdownLinksContext = createContext<MarkdownLinks>({})

const listLine = /^\s*([-*•]|\d+\.)\s+/

/** Light markdown for descriptions, comments and run summaries: paragraphs, lists, headings, **bold**, `code`, [links](…), #12. */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const links = useContext(MarkdownLinksContext)
  const blocks: Array<ReactNode> = []
  for (const [i, b] of text.split(/\n{2,}/).entries()) {
    // Within a block, runs of list lines are a list; other lines stay lines.
    const lines = b.split("\n")
    const parts: Array<{ list: boolean; lines: Array<string> }> = []
    for (const l of lines) {
      const list = listLine.test(l)
      const last = parts.at(-1)
      if (last && last.list === list) last.lines.push(l)
      else parts.push({ list, lines: [l] })
    }
    blocks.push(
      <div key={i} className="space-y-1">
        {parts.map((p, j) =>
          p.list ? (
            <ul key={j} className="list-disc space-y-0.5 pl-4">
              {p.lines.map((l, k) => (
                <li key={k}>{inline(l.replace(listLine, ""), links)}</li>
              ))}
            </ul>
          ) : /^#{1,4}\s+/.test(p.lines[0] ?? "") ? (
            <p key={j} className="font-semibold">
              {inline(p.lines.join("\n").replace(/^#{1,4}\s+/, ""), links)}
            </p>
          ) : (
            <p key={j} className="whitespace-pre-wrap">
              {inline(p.lines.join("\n"), links)}
            </p>
          ),
        )}
      </div>,
    )
  }
  return <div className={`space-y-1.5 ${className}`}>{blocks}</div>
}

const linkClass = "text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"

function inline(s: string, links: MarkdownLinks): Array<ReactNode> {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w/#])#\d+\b)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={i} className="rounded bg-surface px-1 text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      )
    const md = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (md) return <Link key={i} label={md[1]!} href={md[2]!} links={links} />
    const issue = /^#(\d+)$/.exec(part)
    if (issue && links.openIssue && links.hasIssue?.(Number(issue[1]))) {
      const n = Number(issue[1])
      return (
        <a
          key={i}
          href={links.trackerId ? `${artifactHref(links.trackerId)}/${n}` : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) return
            e.preventDefault()
            links.openIssue?.(n)
          }}
          className={linkClass}
        >
          {part}
        </a>
      )
    }
    return part
  })
}

function Link({ label, href, links }: { label: string; href: string; links: MarkdownLinks }) {
  const internal = /^(?:stdartifacts|common-artifacts|commonartifacts|ah):\/\/(?:board|table|doc|tracker)\/([\w-]+)(?:\/(\d+))?$/.exec(href)
  if (internal) {
    const [, artifactId, number] = internal
    const sameTracker = number && artifactId === links.trackerId
    const path = artifactHref(artifactId!)
    return (
      <a
        href={path ? `${path}${number ? `/${number}` : ""}` : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return
          if (sameTracker && links.openIssue) {
            e.preventDefault()
            links.openIssue(Number(number))
          } else if (!number && links.openArtifact && kindOfId(artifactId!)) {
            e.preventDefault()
            links.openArtifact(artifactId!)
          }
        }}
        className={linkClass}
      >
        {label}
      </a>
    )
  }
  if (/^(https?:|mailto:)/i.test(href))
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={linkClass}>
        {label}
      </a>
    )
  return <>{label}</>
}
