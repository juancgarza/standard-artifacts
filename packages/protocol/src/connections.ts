import { Schema } from "effect"
import { SessionUser } from "./account.ts"
import { Role } from "./core.ts"

/**
 * Remote MCP clients that sign in with OAuth (Claude, ChatGPT, Codex, Cursor,
 * VS Code…): the consent page's data (`/api/oauth/consent`, outside the
 * HttpApi like `/api/auth/*`) and the "Connected agents" list in Settings.
 */

/** "write": read and write, as the person's role allows (never above Editor). "read": read only. */
export const GrantAccess = Schema.Literals(["write", "read"])
export type GrantAccess = typeof GrantAccess.Type

/** Who's asking to connect, as the consent page shows it. */
export const ConsentClient = Schema.Struct({
  id: Schema.String,
  /** From its registration or metadata document; null when it gave none. */
  name: Schema.NullOr(Schema.String),
  /** The agent it acts as in the workspace ("Claude Code"). */
  agentName: Schema.String,
  logoUri: Schema.NullOr(Schema.String),
  uri: Schema.NullOr(Schema.String),
  /** Where the answer goes: a web page, an app on this computer (loopback), or an installed app's own link. */
  redirectKind: Schema.Literals(["web", "loopback", "app"]),
  /** The host for a web page, "this computer", or the app's scheme. */
  redirectHost: Schema.String,
  verified: Schema.Boolean,
  /** Shown above the buttons when something looks off. */
  warning: Schema.NullOr(Schema.String),
})
export interface ConsentClient extends Schema.Schema.Type<typeof ConsentClient> {}

/** An org the person may connect the client to, and the most access they can give it there. */
export const ConsentOrg = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Role,
  current: Schema.Boolean,
  /** "read" when their role or the plan allows no more; `limit` says why. */
  maxAccess: GrantAccess,
  limit: Schema.NullOr(Schema.String),
})
export interface ConsentOrg extends Schema.Schema.Type<typeof ConsentOrg> {}

/** `GET /api/oauth/consent?request=…` */
export const ConsentInfo = Schema.Struct({
  request: Schema.String,
  client: ConsentClient,
  user: SessionUser,
  orgs: Schema.Array(ConsentOrg),
  /** Send it back with the answer. */
  csrf: Schema.String,
  /** When the request expires (ms since the epoch). */
  expiresAt: Schema.Number,
})
export interface ConsentInfo extends Schema.Schema.Type<typeof ConsentInfo> {}

/** `POST /api/oauth/consent` */
export const ConsentAnswer = Schema.Struct({
  request: Schema.String,
  csrf: Schema.String,
  decision: Schema.Literals(["approve", "deny"]),
  orgId: Schema.optionalKey(Schema.String),
  access: Schema.optionalKey(GrantAccess),
})
export interface ConsentAnswer extends Schema.Schema.Type<typeof ConsentAnswer> {}

/** Where the consent page sends the browser next: back to the client, with a code or an error. */
export const ConsentResult = Schema.Struct({ redirect: Schema.String, clientName: Schema.String, approved: Schema.Boolean })
export interface ConsentResult extends Schema.Schema.Type<typeof ConsentResult> {}

/**
 * Why the consent page can't go on. `signed-out` sends the browser to sign in;
 * the rest are shown as they are.
 */
export const ConsentProblem = Schema.Literals(["signed-out", "expired", "unknown-client", "redirect-mismatch", "bad-request", "no-membership", "forbidden", "unavailable", "not-enabled"])
export type ConsentProblem = typeof ConsentProblem.Type

/** An agent connected with OAuth, in Settings → Connections. */
export const ConnectedAgent = Schema.Struct({
  id: Schema.String,
  /** The app, as it registered ("Claude Code (stdartifacts)"), and the agent it acts as ("Claude Code"). */
  clientName: Schema.NullOr(Schema.String),
  agentName: Schema.String,
  logoUri: Schema.NullOr(Schema.String),
  clientUri: Schema.NullOr(Schema.String),
  /** Where it signs in from: a host, "this computer", or an app's link scheme. */
  redirectHost: Schema.String,
  access: GrantAccess,
  /** The person it acts for. */
  connectedBy: Schema.Struct({ id: Schema.String, name: Schema.String }),
  /** False once that person left the org: its requests are refused until they're back, or it's disconnected. */
  member: Schema.Boolean,
  connectedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
})
export interface ConnectedAgent extends Schema.Schema.Type<typeof ConnectedAgent> {}

export const Connections = Schema.Struct({
  /** The remote MCP address to give clients. */
  mcpUrl: Schema.String,
  /** False on a server without sign-in (dev, Solo): clients connect without OAuth there. */
  oauth: Schema.Boolean,
  /** Everyone's for an owner; otherwise the caller's own. */
  agents: Schema.Array(ConnectedAgent),
  /** Whether the list is the whole org's (the caller is an owner). */
  everyone: Schema.Boolean,
})
export interface Connections extends Schema.Schema.Type<typeof Connections> {}

/** `GET /mcp/whoami` with a bearer token: who it acts as. */
export const McpWhoami = Schema.Struct({
  person: Schema.Struct({ id: Schema.String, name: Schema.String }),
  organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
  /** The access the token has now: its grant's choice, under the person's role and the plan. */
  access: GrantAccess,
  role: Role,
  /** The OAuth client, or null for a personal access token. */
  client: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String), agentName: Schema.String })),
  /** How the token was made: OAuth sign-in or a personal access token from Settings. */
  via: Schema.Literals(["oauth", "access-token"]),
})
export interface McpWhoami extends Schema.Schema.Type<typeof McpWhoami> {}
