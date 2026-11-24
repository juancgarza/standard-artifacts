import { useLayoutEffect, useRef, useState } from "react"
import { CaretDownIcon, CheckIcon, SparkleIcon } from "@phosphor-icons/react"
import { isFigureType, type BlockType } from "@standard-artifacts/protocol"
import { slashItems } from "./slash-menu"

/** What a selection can turn into: every block type but the divider (which has no text to keep) and figures (which need a file or a link). */
const turnInto = slashItems.filter((i) => i.type !== "divider" && !isFigureType(i.type))

/**
 * The floating bar over a text selection (Notion's bubble menu): "Ask Claude"
 * first, then "Turn into" for the selected blocks' type. It never takes focus,
 * so the selection survives clicking it.
 */
export function SelectionBubble({
  x,
  top,
  width,
  types,
  canAsk,
  canEdit,
  onAsk,
  onTurnInto,
}: {
  /** Horizontal center of the selection and the top of its first line, relative to the doc column. */
  x: number
  top: number
  /** The doc column's width, to keep the bar inside it. */
  width: number
  /** Types of the selected blocks, in order. */
  types: ReadonlyArray<BlockType>
  canAsk: boolean
  canEdit: boolean
  onAsk: () => void
  onTurnInto: (type: BlockType) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(x)
  const [menu, setMenu] = useState(false)

  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0
    setLeft(Math.min(Math.max(0, x - w / 2), Math.max(0, width - w)))
  }, [x, width, canAsk, canEdit])

  const same = types.every((t) => t === types[0])
  const current = same ? turnInto.find((i) => i.type === types[0]) : undefined
  const CurrentIcon = current?.icon

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selection"
      // Keep the selection while clicking, so the bar knows what to edit.
      onMouseDown={(e) => e.preventDefault()}
      className="absolute z-30 flex items-center gap-0.5 rounded-lg border border-border bg-bg p-1 text-[13px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] select-none"
      style={{ left, top: Math.max(0, top - 44) }}
    >
      {canAsk && (
        <button type="button" onClick={onAsk} className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-accent hover:bg-accent/10">
          <SparkleIcon size={14} weight="fill" /> Ask Claude
          <kbd className="font-sans text-[11px] font-normal text-faint">⌘J</kbd>
        </button>
      )}
      {canAsk && canEdit && <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />}
      {canEdit && (
        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            title="Turn into"
            aria-label={`Turn into (now ${current?.label ?? "mixed"})`}
            onClick={() => setMenu(!menu)}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-text hover:bg-hover ${menu ? "bg-hover" : ""}`}
          >
            {CurrentIcon && <CurrentIcon size={14} className="text-muted" />}
            {current?.label ?? "Mixed"}
            <CaretDownIcon size={11} className="text-faint" />
          </button>
          {menu && (
            <div role="menu" aria-label="Turn into" className="absolute top-full left-0 mt-2 w-52 rounded-lg border border-border bg-bg p-1 shadow-lg">
              <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-faint">Turn into</div>
              {turnInto.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    onTurnInto(item.type)
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                >
                  <item.icon size={16} className="shrink-0 text-muted" />
                  <span className="flex-1">{item.label}</span>
                  {item === current && <CheckIcon size={13} className="text-accent" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
