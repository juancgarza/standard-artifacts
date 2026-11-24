import { Result } from "effect"
import {
  applyTableOp,
  decodeTableOp,
  formatIssue,
  cellKey,
  newId,
  type Cell,
  type Column,
  type TableOp,
  type TableState,
} from "@standard-artifacts/protocol"
import type { Env } from "../env"
import { RoomCell, type ParseResult } from "./room"

/**
 * One cell per table. Columns, rows (ordered by `pos`) and cells are stored
 * normalized, so a cell edit is a single-row write even on large tables.
 */
export class TableCell extends RoomCell<TableState, TableOp> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql.exec("CREATE TABLE IF NOT EXISTS t_columns (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, json TEXT NOT NULL)")
    this.sql.exec("CREATE TABLE IF NOT EXISTS t_rows (id TEXT PRIMARY KEY, pos REAL NOT NULL)")
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS t_cells (row_id TEXT NOT NULL, col_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (row_id, col_id))",
    )
    this.sql.exec("CREATE TABLE IF NOT EXISTS t_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  }

  protected parseOp(raw: unknown): ParseResult<TableOp> {
    const r = decodeTableOp(raw)
    return Result.isSuccess(r) ? { ok: true, op: r.success } : { ok: false, error: formatIssue(r.failure.issue) }
  }

  protected applyOp(state: TableState, op: TableOp, by: string) {
    return applyTableOp(state, op, by)
  }

  protected load(): TableState {
    this.seedOnce()
    const columns = this.sql
      .exec<{ json: string }>("SELECT json FROM t_columns ORDER BY pos")
      .toArray()
      .map((r) => JSON.parse(r.json) as Column)
    const rowIds = this.sql
      .exec<{ id: string }>("SELECT id FROM t_rows ORDER BY pos")
      .toArray()
      .map((r) => r.id)
    const cells: Record<string, Cell> = {}
    for (const r of this.sql.exec<{ row_id: string; col_id: string; json: string }>("SELECT * FROM t_cells")) {
      cells[cellKey(r.row_id, r.col_id)] = JSON.parse(r.json) as Cell
    }
    return { columns, rowIds, cells }
  }

  protected persist(op: TableOp, after: TableState) {
    switch (op.type) {
      case "addColumn":
        return this.writeColumns(after.columns)
      case "updateColumn":
        // A type change converts the column's values in the reducer ("42" to 42), so store those too.
        if (op.patch.type) for (const rowId of after.rowIds) this.writeCell(after, rowId, op.id)
        return this.writeColumns(after.columns)
      case "removeColumn":
        this.sql.exec("DELETE FROM t_cells WHERE col_id = ?", op.id)
        return this.writeColumns(after.columns)
      case "addRows": {
        let pos = this.sql.exec<{ p: number | null }>("SELECT MAX(pos) AS p FROM t_rows").one().p ?? 0
        for (const rowId of op.rowIds) {
          this.sql.exec("INSERT INTO t_rows (id, pos) VALUES (?, ?)", rowId, ++pos)
          for (const col of after.columns) this.writeCell(after, rowId, col.id)
        }
        return
      }
      case "removeRows":
        for (const rowId of op.rowIds) {
          this.sql.exec("DELETE FROM t_rows WHERE id = ?", rowId)
          this.sql.exec("DELETE FROM t_cells WHERE row_id = ?", rowId)
        }
        return
      case "setCell":
        return this.writeCell(after, op.rowId, op.colId)
      case "setCells":
        for (const c of op.cells) this.writeCell(after, c.rowId, c.colId)
        return
      case "moveColumn":
        return this.writeColumns(after.columns)
      case "renameOption":
        // Cells holding the old name were rewritten by the reducer.
        for (const rowId of after.rowIds) this.writeCell(after, rowId, op.id)
        return this.writeColumns(after.columns)
    }
  }

  private writeColumns(columns: ReadonlyArray<Column>) {
    this.sql.exec("DELETE FROM t_columns")
    columns.forEach((c, i) => this.sql.exec("INSERT INTO t_columns (id, pos, json) VALUES (?, ?, ?)", c.id, i, JSON.stringify(c)))
  }

  private writeCell(state: TableState, rowId: string, colId: string) {
    const cell = state.cells[cellKey(rowId, colId)]
    if (cell) {
      this.sql.exec(
        "INSERT INTO t_cells (row_id, col_id, json) VALUES (?, ?, ?) ON CONFLICT(row_id, col_id) DO UPDATE SET json = excluded.json",
        rowId, colId, JSON.stringify(cell),
      )
    } else {
      this.sql.exec("DELETE FROM t_cells WHERE row_id = ? AND col_id = ?", rowId, colId)
    }
  }

  /** A new table starts like a fresh lead list: name, website, a status lane, and a few empty rows. */
  private seedOnce() {
    if (this.sql.exec("SELECT 1 FROM t_meta WHERE key = 'seeded'").toArray().length) return
    const columns: Column[] = [
      { id: newId("c_"), name: "Name", type: "text", width: 220 },
      { id: newId("c_"), name: "Website", type: "url", width: 200 },
      { id: newId("c_"), name: "Status", type: "select", width: 140, options: ["Lead", "Contacted", "Replied", "Won"] },
    ]
    this.writeColumns(columns)
    for (let i = 1; i <= 5; i++) this.sql.exec("INSERT INTO t_rows (id, pos) VALUES (?, ?)", newId("r_"), i)
    this.sql.exec("INSERT INTO t_meta (key, value) VALUES ('seeded', '1')")
  }
}
