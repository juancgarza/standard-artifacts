import { useLayoutEffect, useRef, useState } from "react"
import type { Shape } from "@standard-artifacts/protocol"
import { ShapeView } from "./board-view"
import { contains } from "./geometry"

const center = (s: Shape) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 })

/**
 * One shape as it looks on the canvas, scaled down to fit its container: a frame
 * brings along what's inside it. Read-only and not connected to the board's room,
 * so looking at a preview doesn't show the viewer on that board.
 */
export function ShapePreview({ shape, shapes, maxHeight = 420 }: { shape: Shape; shapes: ReadonlyArray<Shape>; maxHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const inside = shape.kind === "frame" ? shapes.filter((s) => s.id !== shape.id && s.kind !== "arrow" && contains(shape, center(s))) : []
  const scale = width ? Math.min(1, width / shape.w, maxHeight / shape.h) : 0

  return (
    <div ref={ref} className="pointer-events-none relative w-full overflow-hidden" style={{ height: scale ? shape.h * scale : maxHeight / 2 }}>
      {scale > 0 && (
        <div className="absolute top-0 origin-top-left" style={{ left: (width - shape.w * scale) / 2, width: shape.w, height: shape.h, transform: `scale(${scale})` }}>
          {[shape, ...inside].map((s) => (
            <ShapeView
              key={s.id}
              shape={{ ...s, x: s.x - shape.x, y: s.y - shape.y }}
              selected={false}
              snapped={false}
              remote={undefined}
              editing={false}
              showHandle={false}
              interactive={false}
              live
              zoom={1}
              onCommitText={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  )
}
