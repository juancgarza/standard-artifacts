import { cloneSubtree, htmlToDesign, htmlToDesignNodes, isVoidTag, newId, parentOf, type DesignOp, type DesignTree } from "@standard-artifacts/protocol"

/** What the toolbar's design button creates: small, but shows layers, auto layout and type. */
export const starterDesignHtml = `<div style="display: flex; flex-direction: column; gap: 12px; padding: 28px; background: #ffffff; font-family: system-ui, sans-serif; color: #1f1f1d">
  <h2 style="margin: 0; font-size: 22px; font-weight: 700">Design frame</h2>
  <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #6b6b66">Real HTML and CSS. Double-click to select a layer, then edit it in the inspector.</p>
  <button style="align-self: flex-start; padding: 8px 16px; border: 0; border-radius: 8px; background: #2f6fed; color: #ffffff; font-size: 14px; font-weight: 600">Get started</button>
</div>`

export const designDefaults = { w: 420, h: 240 }
/** Pasted designs are usually pages or sections: start bigger. */
export const pastedDesignSize = { w: 560, h: 400 }

export const layerId = () => newId("n_")

/** Placeholder for a new image layer: a light box, as an inline data URI (designs only load https and data images). */
const placeholderImage =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='100'%3E%3Crect width='160' height='100' fill='%23e9e9e6'/%3E%3Cpath d='M52 70l20-24 14 16 10-10 16 18z' fill='%23c4c4bf'/%3E%3C/svg%3E"

export type LayerKind = "frame" | "text" | "image" | "button"

const templates: Record<LayerKind, string> = {
  frame: `<div style="display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: 8px; background: #f3f3f1"></div>`,
  text: `<p style="margin: 0; font-size: 14px">Text</p>`,
  image: `<img src="${placeholderImage}" alt="Image" style="width: 160px; height: 100px; object-fit: cover; border-radius: 6px">`,
  button: `<button style="padding: 8px 16px; border: 0; border-radius: 8px; background: #1f1f1d; color: #ffffff; font-size: 14px; font-weight: 600">Button</button>`,
}

/** Where a new layer goes: inside the selected layer if it can hold layers, else right after it. */
export function insertionPoint(tree: DesignTree, selected: string | null): { parent: string; index?: number } {
  const node = selected ? tree.nodes[selected] : undefined
  if (!node) return { parent: tree.root }
  if (!isVoidTag(node.tag) && node.text === undefined) return { parent: node.id }
  const parent = parentOf(tree, node.id)
  if (!parent) return { parent: tree.root }
  return { parent, index: tree.nodes[parent]!.children.indexOf(node.id) + 1 }
}

/** Ops to add a new layer of `kind`, and its id. */
export function addLayer(shape: string, tree: DesignTree, selected: string | null, kind: LayerKind): { ops: Array<DesignOp>; id: string } {
  const { roots, nodes } = htmlToDesignNodes(templates[kind], { newId: layerId, reserved: new Set(Object.keys(tree.nodes)) })
  const root = roots[0]!
  const at = insertionPoint(tree, selected)
  return { ops: [{ type: "designInsert", shape, parent: at.parent, ...(at.index !== undefined && { index: at.index }), root, nodes }], id: root }
}

/** Ops to duplicate a layer right after itself, and the copy's id. */
export function duplicateLayer(shape: string, tree: DesignTree, id: string): { ops: Array<DesignOp>; id: string } | null {
  const parent = parentOf(tree, id)
  if (!parent) return null
  const copy = cloneSubtree(tree, id, layerId)
  const index = tree.nodes[parent]!.children.indexOf(id) + 1
  return { ops: [{ type: "designInsert", shape, parent, index, root: copy.root, nodes: copy.nodes }], id: copy.root }
}

/** Ops to wrap a layer in a new auto-layout frame at its place, and the frame's id. */
export function wrapLayer(shape: string, tree: DesignTree, id: string): { ops: Array<DesignOp>; id: string } | null {
  const parent = parentOf(tree, id)
  if (!parent) return null
  const index = tree.nodes[parent]!.children.indexOf(id)
  const frame = layerId()
  return {
    ops: [
      { type: "designInsert", shape, parent, index, root: frame, nodes: [{ id: frame, tag: "div", style: { display: "flex", "flex-direction": "column", gap: "8px" }, children: [] }] },
      { type: "designMove", shape, id, parent: frame, index: 0 },
    ],
    id: frame,
  }
}

/** Ops to move a layer one step up or down among its siblings. */
export function nudgeLayer(shape: string, tree: DesignTree, id: string, by: -1 | 1): DesignOp | null {
  const parent = parentOf(tree, id)
  if (!parent) return null
  const siblings = tree.nodes[parent]!.children
  const at = siblings.indexOf(id) + by
  if (at < 0 || at >= siblings.length) return null
  // The index counts siblings without the moved layer, which is exactly its new position.
  return { type: "designMove", shape, id, parent, index: at }
}

export const starterDesign = () => htmlToDesign(starterDesignHtml, { newId: layerId })
