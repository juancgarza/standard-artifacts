import { Result } from "effect"
import { applyDocOp, decodeDocOp, formatIssue, newId, type Block, type BlockPatch, type DocOp, type DocState } from "@standard-artifacts/protocol"
import { AssetCell } from "./asset-cell"
import type { ParseResult } from "./room"

/** One cell per doc: blocks in reading order, plus the doc's images. */
export class DocCell extends AssetCell<Block, BlockPatch> {
  protected parseOp(raw: unknown): ParseResult<DocOp> {
    const r = decodeDocOp(raw)
    return Result.isSuccess(r) ? { ok: true, op: r.success } : { ok: false, error: formatIssue(r.failure.issue) }
  }

  protected applyOp(state: DocState, op: DocOp, by: string) {
    return applyDocOp(state, op, by)
  }

  protected seed(): ReadonlyArray<Block> {
    return [{ id: newId("k_"), type: "paragraph", text: "" }]
  }
}
