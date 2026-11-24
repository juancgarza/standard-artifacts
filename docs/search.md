
# Search

Search covers the whole workspace by meaning and keywords: doc blocks, table rows, board shapes and issues. It's in ⌘K ("In content"), over MCP (`search_workspace`), in the CLI (`stdartifacts search "what did we decide on pricing"`) and at `GET /api/v1/search`.

- **Index.** [turbopuffer](https://turbopuffer.com), which also does the embedding, with one namespace per org. It's optional: without `TURBOPUFFER_API_KEY`, nothing is indexed and search matches titles only (`mode: "title"`), so dev needs no cloud account. If a query fails, search falls back to titles the same way.
- **Writes.** A commit marks the cell dirty, and an alarm flushes up to 15 seconds later. Each flush hashes the items and sends only what changed, so editing one row re-embeds one row. Failed flushes retry with backoff, up to an hour apart. Deleting an artifact deletes its documents.
- **Access.** The workspace cell has the last word: hits in anything deleted, archived or out of a share-link guest's scope are dropped, however stale the index is. Guests search only the artifact they were shared.
- **What's not indexed.** Run steps, and the source of html embeds and design frames (their titles are). Content from before search was turned on stays out until an owner runs `stdartifacts reindex`.

Configuration: `TURBOPUFFER_API_KEY` (secret), `TURBOPUFFER_URL` (the region's host; default `https://aws-us-east-1.turbopuffer.com`), `SEARCH_PREFIX` (keeps stages apart in one account). To change the embedding model in `search-index.ts`, also change the prefix and reindex.
