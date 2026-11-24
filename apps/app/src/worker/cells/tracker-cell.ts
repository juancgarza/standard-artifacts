import { Result } from "effect"
import { applyTrackerOp, decodeTrackerOp, formatIssue, type RunStepOp, type TrackerItem, type TrackerOp, type TrackerPatch, type TrackerState } from "@standard-artifacts/protocol"
import { ListCell } from "./list-cell"
import type { ParseResult } from "./room"

/** One cell per tracker: issues in manual order, plus their runs and comments. */
export class TrackerCell extends ListCell<TrackerItem, TrackerPatch, RunStepOp> {
  protected parseOp(raw: unknown): ParseResult<TrackerOp> {
    const r = decodeTrackerOp(raw)
    return Result.isSuccess(r) ? { ok: true, op: r.success } : { ok: false, error: formatIssue(r.failure.issue) }
  }

  protected applyOp(state: TrackerState, op: TrackerOp, by: string) {
    return applyTrackerOp(state, op, by)
  }

  /** A step lands in its run's row. */
  protected touched(op: RunStepOp): ReadonlyArray<string> {
    return [op.run]
  }

  protected seed(): ReadonlyArray<TrackerItem> {
    return []
  }
}
