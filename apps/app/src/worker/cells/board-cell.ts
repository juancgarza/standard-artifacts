import { Result } from "effect"
import {
  applyBoardOp,
  decodeBoardOp,
  formatIssue,
  newId,
  type BoardOp,
  type BoardState,
  type DesignOp,
  type Shape,
  type ShapePatch,
} from "@standard-artifacts/protocol"
import { AssetCell } from "./asset-cell"
import type { ParseResult } from "./room"

/** One cell per board: shapes in z-order, plus the board's images. */
export class BoardCell extends AssetCell<Shape, ShapePatch, DesignOp> {
  protected parseOp(raw: unknown): ParseResult<BoardOp> {
    const r = decodeBoardOp(raw)
    return Result.isSuccess(r) ? { ok: true, op: r.success } : { ok: false, error: formatIssue(r.failure.issue) }
  }

  protected applyOp(state: BoardState, op: BoardOp, by: string) {
    return applyBoardOp(state, op, by)
  }

  /** A design op edits one frame's tree, which is stored in that shape's row. */
  protected touched(op: DesignOp): ReadonlyArray<string> {
    return [op.shape]
  }

  protected seed(): ReadonlyArray<Shape> {
    return [{ id: newId("s_"), kind: "note", x: 0, y: 0, w: 200, h: 140, color: "yellow", text: "Drop ideas here. Agents can too." }]
  }
}
