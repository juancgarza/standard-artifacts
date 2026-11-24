import { handle } from "./app"
import { devGuard } from "./dev-guard"
import type { Env } from "./env"

/** Worker entry: the cells (Durable Objects) and the fetch handler. */
export { WorkspaceCell } from "./cells/workspace-cell"
export { TableCell } from "./cells/table-cell"
export { BoardCell } from "./cells/board-cell"
export { DocCell } from "./cells/doc-cell"
export { TrackerCell } from "./cells/tracker-cell"
export { McpCell } from "./cells/mcp-cell"
export { RunnerCell, RunnerOutbound } from "./cells/runner-cell"

export default {
  // Only requests from outside pass the dev guard; cells call `handle` directly.
  fetch: (request, env) => {
    const refused = devGuard(request, env)
    return refused ? Promise.resolve(refused) : handle(request, env)
  },
} satisfies ExportedHandler<Env>
