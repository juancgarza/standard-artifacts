import { Schema } from "effect"

/**
 * The workspace search index, on turbopuffer. One namespace per org keeps orgs
 * apart at the storage level. Each searchable item (a doc block, table row,
 * board shape or issue) is one document, embedded by turbopuffer itself.
 *
 * Plain fetch and Web Crypto only, because cells and celld both call this. It's
 * optional: with no TURBOPUFFER_API_KEY nothing is indexed and search matches
 * titles only, so dev stages need no cloud account.
 */

/** To change it, also change SEARCH_PREFIX and reindex: turbopuffer can't change `embed` on a namespace or re-embed existing rows. */
const embedding = { model: "voyage/voyage-4-lite", dims: 512 } as const

const schema = {
  artifact_id: { type: "string" },
  kind: { type: "string" },
  item: { type: "string", filterable: false },
  text: { type: "string", filterable: false, full_text_search: true, embed: embedding },
}

/** Embedding limits accept or reject a whole request, so big artifacts go up in pieces. */
export const writeBatchSize = 500

export interface SearchConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly prefix: string
  readonly fetch: typeof globalThis.fetch
}

interface SearchEnv {
  readonly TURBOPUFFER_API_KEY?: string
  /** The region's host; a namespace lives in one region. */
  readonly TURBOPUFFER_URL?: string
  /** Keeps stages apart when they share an account. */
  readonly SEARCH_PREFIX?: string
}

export function searchConfig(env: SearchEnv, fetcher: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init)): SearchConfig | null {
  if (!env.TURBOPUFFER_API_KEY) return null
  return {
    apiKey: env.TURBOPUFFER_API_KEY,
    baseUrl: env.TURBOPUFFER_URL ?? "https://aws-us-east-1.turbopuffer.com",
    prefix: env.SEARCH_PREFIX ?? "standard-artifacts",
    fetch: fetcher,
  }
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Org ids are ours but namespace names are restricted, and hashing also keeps them out of a vendor's dashboard. */
export const namespaceFor = async (config: SearchConfig, orgId: string) => `${config.prefix}-${(await sha256(orgId)).slice(0, 32)}`

/** Document ids are capped at 64 bytes; artifact and item ids can each reach that. */
export const documentId = async (artifactId: string, item: string) => (await sha256(`${artifactId}\0${item}`)).slice(0, 32)

export const contentHash = sha256

export class SearchError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`turbopuffer ${status}: ${detail.slice(0, 300)}`)
    this.status = status
  }
}

/** A namespace appears on its first write, so 404 means "nothing here yet": `missing` lets callers treat it that way. */
async function post(config: SearchConfig, path: string, body: unknown, missing?: unknown): Promise<unknown> {
  const res = await config.fetch(`${config.baseUrl}/v2/namespaces/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.status === 404 && missing !== undefined) return missing
  if (!res.ok) throw new SearchError(res.status, await res.text())
  return res.json()
}

export interface IndexItem {
  readonly item: string
  readonly text: string
}

/** Upsert and delete one artifact's documents. Idempotent, so a failed write can simply run again. */
export async function writeItems(
  config: SearchConfig,
  orgId: string,
  artifactId: string,
  kind: string,
  upserts: ReadonlyArray<IndexItem>,
  removed: ReadonlyArray<string>,
): Promise<void> {
  const rows = await Promise.all(
    upserts.map(async ({ item, text }) => ({ id: await documentId(artifactId, item), artifact_id: artifactId, kind, item, text })),
  )
  const deletes = await Promise.all(removed.map((item) => documentId(artifactId, item)))
  await post(config, await namespaceFor(config, orgId), {
    ...(rows.length && { upsert_rows: rows, distance_metric: "cosine_distance", schema }),
    ...(deletes.length && { deletes }),
  })
}

export async function deleteArtifact(config: SearchConfig, orgId: string, artifactId: string): Promise<void> {
  await post(config, await namespaceFor(config, orgId), { delete_by_filter: ["artifact_id", "Eq", artifactId] }, null)
}

const QueryResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      rows: Schema.optionalKey(Schema.Array(Schema.Struct({ artifact_id: Schema.String, item: Schema.String, text: Schema.String }))),
    }),
  ),
})
const decodeQueryResponse = Schema.decodeUnknownPromise(QueryResponse)

export interface IndexHit {
  readonly artifactId: string
  readonly item: string
  readonly text: string
}

/** Hybrid search: meaning and exact words each find what the other misses (names, ids), fused by rank. */
export async function queryItems(
  config: SearchConfig,
  orgId: string,
  input: { readonly query: string; readonly limit: number; readonly kind?: string | undefined; readonly artifactId?: string | undefined },
): Promise<ReadonlyArray<IndexHit>> {
  const conditions = [
    ...(input.artifactId ? [["artifact_id", "Eq", input.artifactId]] : []),
    ...(input.kind ? [["kind", "Eq", input.kind]] : []),
  ]
  const filters = conditions.length > 1 ? { filters: ["And", conditions] } : conditions.length ? { filters: conditions[0] } : {}
  const subquery = { limit: input.limit * 2, include_attributes: ["artifact_id", "item", "text"], ...filters }
  const raw = await post(
    config,
    `${await namespaceFor(config, orgId)}/query`,
    {
      queries: [
        { ...subquery, rank_by: ["text", "ANN", ["Embed", input.query]] },
        { ...subquery, rank_by: ["text", "BM25", input.query] },
      ],
      rerank_by: ["RRF", { rank_constant: 60 }],
      limit: input.limit,
    },
    { results: [] },
  )
  const { results } = await decodeQueryResponse(raw)
  return (results[0]?.rows ?? []).map((r) => ({ artifactId: r.artifact_id, item: r.item, text: r.text }))
}
