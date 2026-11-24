import { useEffect, useRef, type ClipboardEvent, type ReactNode } from "react"
import { XIcon } from "@phosphor-icons/react"
import { coerceCellValue, isTags, refText, refsOf, sameRef, type ArtifactRef, type CellValue, type Column, type TitleOf } from "@standard-artifacts/protocol"

/**
 * What the host gives a table so Artifact cells can show the rest of the
 * workspace: a chip for a reference, titles (so search, filters and sorting read
 * what people see), and a picker. Without it, cells show ids and edit as text.
 */
export type TableLinks = {
  readonly chip: (ref: ArtifactRef) => ReactNode
  readonly titleOf: TitleOf
  readonly picker: (props: {
    readonly initialQuery: string
    readonly onPick: (ref: ArtifactRef) => void
    /** Backspace with nothing left to delete in the search. */
    readonly onBackspace: () => void
    readonly onClose: () => void
  }) => ReactNode
}

const Chip = ({ links, target }: { links: TableLinks | undefined; target: ArtifactRef }) =>
  links ? links.chip(target) : <span className="truncate text-[12px] text-muted">{refText(target)}</span>

/**
 * Links in one line (a grid cell) or wrapped (a card, the record panel). A chip can
 * fill its cell, so in the grid it mustn't take the only way to select it: the first
 * click selects, a further click opens, a double-click edits, and Cmd/Ctrl-click always
 * opens. `selected` says whether this grid cell is selected; elsewhere links just open.
 */
export function RefChips({
  links,
  value,
  wrap = false,
  selected = true,
}: {
  links: TableLinks | undefined
  value: CellValue | undefined
  wrap?: boolean
  selected?: boolean
}) {
  // Read at mousedown: by the click, that press has already selected the cell.
  const opens = useRef(selected)
  return (
    <span className={`flex gap-1 ${wrap ? "flex-wrap" : "overflow-hidden"}`}>
      {refsOf(value).map((ref) => (
        <span
          key={refText(ref)}
          className="flex max-w-full min-w-0 shrink-0"
          onMouseDown={(e) => {
            // Focus stays put: on a link, Enter would open it instead of editing the cell.
            e.preventDefault()
            opens.current = selected
            if (selected) e.stopPropagation()
          }}
          onClickCapture={(e) => {
            if ((!opens.current || e.detail > 1) && !e.metaKey && !e.ctrlKey) e.preventDefault()
          }}
        >
          <Chip links={links} target={ref} />
        </span>
      ))}
    </span>
  )
}

/**
 * Edit an Artifact cell: what it links to now, above the host's picker. It stays
 * open to link several. Every change saves at once, as Select cells do.
 */
export function RefPicker({
  links,
  column,
  value,
  initialQuery = "",
  onChange,
  onClose,
  className = "absolute top-0 left-0 z-40",
}: {
  links: TableLinks
  column: Column
  value: CellValue | undefined
  initialQuery?: string
  onChange: (next: ReadonlyArray<string>) => void
  onClose: () => void
  className?: string
}) {
  const refs = refsOf(value)
  const save = (next: ReadonlyArray<ArtifactRef>) => onChange(next.map(refText))

  // The links above the search count too: near the bottom of the grid, bring all of it into view.
  // Too tall to fit, the links win: the list below scrolls, but they'd be out of reach.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    const port = el?.closest('[role="grid"]')
    el?.scrollIntoView({ block: port && el.offsetHeight > port.clientHeight ? "start" : "nearest" })
  }, [])

  /** Pasting an app link (or an id) adds it; anything else is a search. */
  const onPaste = (e: ClipboardEvent) => {
    const pasted = coerceCellValue(column, e.clipboardData.getData("text/plain"))
    if (!pasted.ok || !isTags(pasted.value)) return
    e.preventDefault()
    save([...refs, ...refsOf(pasted.value).filter((r) => !refs.some((x) => sameRef(x, r)))])
  }

  return (
    <div
      ref={root}
      className={`${className} flex flex-col gap-1 text-left text-[13px] whitespace-normal`}
      onPaste={onPaste}
      // Picker keys are the picker's; Tab goes on to the grid, which saves and moves.
      onKeyDown={(e) => {
        if (e.key !== "Tab") e.stopPropagation()
      }}
    >
      {refs.length > 0 && (
        <ul
          aria-label={`${column.name} links`}
          // Clicks here keep focus in the search, which closes the picker when it loses it.
          onMouseDown={(e) => e.preventDefault()}
          className="flex max-h-32 w-80 max-w-[calc(100vw-48px)] flex-wrap gap-1 overflow-y-auto rounded-lg border border-border bg-bg p-1.5 shadow-lg"
        >
          {refs.map((ref) => (
            <li key={refText(ref)} className="flex max-w-full min-w-0 items-center gap-0.5">
              <span className="pointer-events-none flex min-w-0">
                <Chip links={links} target={ref} />
              </span>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Remove ${links.titleOf(ref.artifactId) ?? refText(ref)}`}
                onClick={() => save(refs.filter((r) => !sameRef(r, ref)))}
                className="grid size-4 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover hover:text-text"
              >
                <XIcon size={10} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {links.picker({
        initialQuery,
        onPick: (ref) => {
          if (!refs.some((r) => sameRef(r, ref))) save([...refs, ref])
        },
        onBackspace: () => {
          if (refs.length) save(refs.slice(0, -1))
        },
        onClose,
      })}
    </div>
  )
}
