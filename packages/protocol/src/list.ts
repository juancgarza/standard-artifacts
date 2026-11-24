import { Schema } from "effect"
import { Id } from "./core.ts"

/**
 * Ordered collections of records with stable ids: board shapes (order = z-order)
 * and doc blocks (order = reading order). One op vocabulary and one reducer, so
 * every list-shaped surface syncs, persists, and replays the same way.
 */

export type ListOp<I, P> =
  /** `after`: omitted = append, null = prepend, id = insert after that item. */
  | { readonly type: "insert"; readonly item: I; readonly after?: string | null }
  | { readonly type: "update"; readonly id: string; readonly patch: P }
  | { readonly type: "remove"; readonly ids: ReadonlyArray<string> }
  | { readonly type: "move"; readonly id: string; readonly after: string | null }

export interface ListState<I> {
  readonly items: ReadonlyArray<I>
}

export const listOpSchema = <I extends Schema.Top, P extends Schema.Top>(item: I, patch: P) =>
  Schema.Union([
    Schema.Struct({ type: Schema.tag("insert"), item, after: Schema.optionalKey(Schema.NullOr(Id)) }),
    Schema.Struct({ type: Schema.tag("update"), id: Id, patch }),
    Schema.Struct({ type: Schema.tag("remove"), ids: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(500)) }),
    Schema.Struct({ type: Schema.tag("move"), id: Id, after: Schema.NullOr(Id) }),
  ])

export type ListResult<I> = { ok: true; state: ListState<I> } | { ok: false; error: string }

/** Pure: returns a new state, never mutates. */
export function applyListOp<I extends { readonly id: string }, P>(
  state: ListState<I>,
  op: ListOp<I, P>,
  merge: (item: I, patch: P) => I,
): ListResult<I> {
  const items = state.items
  const index = (id: string) => items.findIndex((i) => i.id === id)
  const insertAt = (list: ReadonlyArray<I>, item: I, after: string | null | undefined): ListResult<I> => {
    if (after === undefined) return ok([...list, item])
    if (after === null) return ok([item, ...list])
    const at = list.findIndex((i) => i.id === after)
    if (at < 0) return fail("Unknown anchor")
    return ok([...list.slice(0, at + 1), item, ...list.slice(at + 1)])
  }

  switch (op.type) {
    case "insert":
      if (index(op.item.id) >= 0) return fail("Item already exists")
      return insertAt(items, op.item, op.after)
    case "update": {
      const at = index(op.id)
      if (at < 0) return fail("Unknown item")
      const next = [...items]
      next[at] = merge(items[at]!, op.patch)
      return ok(next)
    }
    case "remove": {
      const drop = new Set(op.ids)
      const next = items.filter((i) => !drop.has(i.id))
      return next.length === items.length ? fail("Unknown item") : ok(next)
    }
    case "move": {
      const at = index(op.id)
      if (at < 0 || op.after === op.id) return fail("Unknown item")
      const without = items.filter((i) => i.id !== op.id)
      return insertAt(without, items[at]!, op.after)
    }
  }
}

const ok = <I>(items: ReadonlyArray<I>): ListResult<I> => ({ ok: true, state: { items } })
const fail = <I>(error: string): ListResult<I> => ({ ok: false, error })

/** Shallow patch merge that treats `undefined` as "leave unchanged". */
export function mergePatch<I extends object>(item: I, patch: Partial<I>): I {
  const next = { ...item }
  for (const key of Object.keys(patch) as Array<keyof I>) {
    const value = patch[key]
    if (value !== undefined) next[key] = value
  }
  return next
}
