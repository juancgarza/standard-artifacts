import { imageTypes, maxImageBytes, newId, sniffImage } from "@standard-artifacts/protocol"
import type { Env } from "../env"
import { ListCell } from "./list-cell"

export type PutAsset = { ok: true; id: string } | { ok: false; error: string }
export type Asset = { mime: string; bytes: ArrayBuffer }

/**
 * A list cell that also holds its images (boards, docs). They live in the cell's
 * own SQLite (one row each, under 2 MB) so an artifact is self-contained and needs
 * no object store, which matters on celld.
 */
export abstract class AssetCell<I extends { readonly id: string }, P, X extends { readonly type: string } = never> extends ListCell<I, P, X> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql.exec("CREATE TABLE IF NOT EXISTS b_assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL)")
  }

  async putAsset(bytes: ArrayBuffer, mime: string): Promise<PutAsset> {
    if (!(imageTypes as ReadonlyArray<string>).includes(mime)) return { ok: false, error: `Unsupported type ${mime || "(none)"}: upload a PNG, JPEG, GIF or WebP image` }
    if (bytes.byteLength === 0) return { ok: false, error: "Empty upload" }
    if (bytes.byteLength > maxImageBytes) return { ok: false, error: `Image is ${(bytes.byteLength / 1e6).toFixed(1)} MB; the limit is 1.9 MB` }
    // The declared type is only a hint: the bytes decide, and the sniffed type is what's stored.
    const sniffed = sniffImage(new Uint8Array(bytes))
    if (!sniffed.ok) return { ok: false, error: sniffed.error }
    const id = newId("a_")
    this.sql.exec("INSERT INTO b_assets (id, mime, bytes, created_at) VALUES (?, ?, ?, ?)", id, sniffed.type, bytes, new Date().toISOString())
    return { ok: true, id }
  }

  /** Served with the type its bytes have, so rows stored before uploads were checked can't claim another. */
  async getAsset(id: string): Promise<Asset | null> {
    const row = this.sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM b_assets WHERE id = ?", id).toArray()[0]
    if (!row) return null
    const sniffed = sniffImage(new Uint8Array(row.bytes))
    return { mime: sniffed.ok ? sniffed.type : "application/octet-stream", bytes: row.bytes }
  }
}
