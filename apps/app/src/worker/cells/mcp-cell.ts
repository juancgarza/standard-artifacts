import { DurableObject } from "cloudflare:workers"
import { ConfigProvider, Layer } from "effect"
import { McpServer } from "effect/ai"
import { HttpRouter } from "effect/http"
import { StandardArtifactsClient } from "@standard-artifacts/client"
import { StandardArtifactsMcp, serverExtensions, serverInfo } from "@standard-artifacts/mcp"
import type { Principal } from "@standard-artifacts/protocol"
import { handle } from "../app"
import type { Env } from "../env"

/**
 * Remote MCP (Streamable HTTP at /mcp) for ChatGPT, Codex and other hosts that
 * connect over the network: the same tools and resources as `stdartifacts mcp`.
 *
 * One cell per principal. The MCP server keeps its sessions in memory, so the
 * requests of a session must reach the same instance, and its tools act as one
 * principal. The Worker authenticates each request and routes it here by
 * `mcpCellName`. If the cell is evicted, its sessions are gone and clients
 * start a new one (a 404 tells them to).
 *
 * Tools reach the API in-process (no network hop): `@standard-artifacts/client` is given a
 * fetch that calls the Worker's handler with the caller's latest credentials,
 * so validation, permissions, the op log and presence are the same as for
 * anyone else.
 */
export class McpCell extends DurableObject<Env> {
  private server: { readonly handler: (request: Request) => Promise<Response> } | undefined
  /** The caller's credentials from the latest request (tickets are short-lived and get refreshed). */
  private credentials = new Headers()

  override async fetch(request: Request): Promise<Response> {
    const credentials = new Headers()
    for (const name of credentialHeaders) {
      const value = request.headers.get(name)
      if (value !== null) credentials.set(name, value)
    }
    this.credentials = credentials
    this.server ??= this.start(new URL(request.url).origin)
    return this.server.handler(request)
  }

  private start(origin: string) {
    const env = this.env
    const api: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      this.credentials.forEach((value, name) => headers.set(name, value))
      return handle(new Request(request, { headers }), env)
    }
    return HttpRouter.toWebHandler(
      StandardArtifactsMcp.pipe(
        Layer.provide(McpServer.layerHttp({ ...serverInfo, extensions: serverExtensions, path: "/mcp" })),
        Layer.provide(StandardArtifactsClient.layer({ url: origin, fetch: api })),
        // Settings like STDARTIFACTS_SUGGEST_MENTION belong to the CLI's runner, not to remote sessions.
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
      { disableLogger: true },
    )
  }
}

const credentialHeaders = ["authorization", "cookie", "x-dev-as"] as const

/** Which McpCell serves a principal: one per org member (or agent, or share-link guest) and role. */
export const mcpCellName = (p: Principal) => [p.orgId, p.actor.type, p.actor.id, p.role, p.scope ?? ""].join("/")
