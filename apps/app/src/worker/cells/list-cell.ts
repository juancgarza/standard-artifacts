import type { ListOp, ListState } from "@standard-artifacts/protocol"
import type { Env } from "../env"
import { RoomCell } from "./room"

const listOpTypes: ReadonlySet<string> = new Set(["insert", "update", "remove", "move"])

/**
 * A cell holding an ordered list of records (board shapes, doc blocks).
 * Order is a REAL `pos` column, so an insert or move writes one row: the new
 * position is the midpoint between its neighbours.
 *
 * `X` is a surface's own ops beyond the list vocabulary (a board's design-frame
 * edits). They change records in place, so persisting one rewrites the rows
 * `touched` names.
 */
export abstract class ListCell<I extends { readonly id: string }, P, X extends { readonly type: string } = never> extends RoomCell<ListState<I>, ListOp<I, P> | X> {
  /** Records a brand-new cell starts with. */
  protected abstract seed(): ReadonlyArray<I>

  /** Ids of the records an `X` op changed. */
  protected touched(_op: X): ReadonlyArray<string> {
    return []
  }

  private isListOp(op: ListOp<I, P> | X): op is ListOp<I, P> {
    return listOpTypes.has(op.type)
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql.exec("CREATE TABLE IF NOT EXISTS l_items (id TEXT PRIMARY KEY, pos REAL NOT NULL, json TEXT NOT NULL)")
    this.sql.exec("CREATE TABLE IF NOT EXISTS l_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  }

  protected load(): ListState<I> {
    if (!this.sql.exec("SELECT 1 FROM l_meta WHERE key = 'seeded'").toArray().length) {
      this.seed().forEach((item, i) => this.write(item, i + 1))
      this.sql.exec("INSERT INTO l_meta (key, value) VALUES ('seeded', '1')")
    }
    const items = this.sql
      .exec<{ json: string }>("SELECT json FROM l_items ORDER BY pos")
      .toArray()
      .map((r) => JSON.parse(r.json) as I)
    return { items }
  }

  protected persist(op: ListOp<I, P> | X, after: ListState<I>) {
    if (!this.isListOp(op)) {
      for (const id of this.touched(op)) {
        const item = after.items.find((i) => i.id === id)
        if (item) this.sql.exec("UPDATE l_items SET json = ? WHERE id = ?", JSON.stringify(item), item.id)
      }
      return
    }
    switch (op.type) {
      case "insert":
      case "move": {
        const id = op.type === "insert" ? op.item.id : op.id
        const at = after.items.findIndex((i) => i.id === id)
        const item = after.items[at]
        if (!item) return
        return this.write(item, this.between(after.items[at - 1]?.id, after.items[at + 1]?.id))
      }
      case "update": {
        const item = after.items.find((i) => i.id === op.id)
        if (item) this.sql.exec("UPDATE l_items SET json = ? WHERE id = ?", JSON.stringify(item), item.id)
        return
      }
      case "remove": {
        // The reducer may cascade (e.g. arrows attached to a removed shape): delete whatever is gone.
        const keep = new Set(after.items.map((i) => i.id))
        for (const { id } of this.sql.exec<{ id: string }>("SELECT id FROM l_items").toArray()) {
          if (!keep.has(id)) this.sql.exec("DELETE FROM l_items WHERE id = ?", id)
        }
        return
      }
    }
  }

  private pos(id: string | undefined): number | undefined {
    if (!id) return undefined
    return this.sql.exec<{ pos: number }>("SELECT pos FROM l_items WHERE id = ?", id).toArray()[0]?.pos
  }

  private between(prevId: string | undefined, nextId: string | undefined): number {
    const prev = this.pos(prevId)
    const next = this.pos(nextId)
    if (prev !== undefined && next !== undefined) return (prev + next) / 2
    if (prev !== undefined) return prev + 1
    if (next !== undefined) return next - 1
    return 1
  }

  private write(item: I, pos: number) {
    this.sql.exec(
      "INSERT INTO l_items (id, pos, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET pos = excluded.pos, json = excluded.json",
      item.id, pos, JSON.stringify(item),
    )
  }
}
