import { Schema } from "effect"
import { Id, Plan, Role } from "./core.ts"

/**
 * Accounts: who is in an org, their roles, invitations, and personal access
 * tokens. In Standard Artifacts Cloud (live mode with sign-in) the account
 * service is WorkOS, and it's the source of truth for members and roles; a
 * dev server has no accounts, so these read as unavailable there.
 */

/** A member of the org, as the account service knows them. */
export const OrgMember = Schema.Struct({
  /** The membership's id: what role changes and removal address. */
  id: Id,
  /** The person's actor id (`usr_…`), the same one attribution and presence use. */
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  role: Role,
  joinedAt: Schema.String,
})
export interface OrgMember extends Schema.Schema.Type<typeof OrgMember> {}

export const InvitationState = Schema.Literals(["pending", "accepted", "expired", "revoked"])
export type InvitationState = typeof InvitationState.Type

/** An email invitation to join the org with a role. The account service sends the email. */
export const OrgInvitation = Schema.Struct({
  id: Id,
  email: Schema.String,
  role: Role,
  state: InvitationState,
  expiresAt: Schema.String,
  createdAt: Schema.String,
})
export interface OrgInvitation extends Schema.Schema.Type<typeof OrgInvitation> {}

/** Members and pending invitations. Everyone in the org can read it; owners can change it. */
export const OrgMembers = Schema.Struct({
  members: Schema.Array(OrgMember),
  invitations: Schema.Array(OrgInvitation),
  /** Whether the caller can invite, change roles and remove people (owners). */
  canManage: Schema.Boolean,
})
export interface OrgMembers extends Schema.Schema.Type<typeof OrgMembers> {}

const Email = Schema.Trim.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))

export const InviteMember = Schema.Struct({ email: Email, role: Role })
export interface InviteMember extends Schema.Schema.Type<typeof InviteMember> {}

export const UpdateMember = Schema.Struct({ role: Role })
export interface UpdateMember extends Schema.Schema.Type<typeof UpdateMember> {}

/**
 * A personal access token for the CLI, MCP and scripts (`STDARTIFACTS_TOKEN`).
 * It acts as the person who made it, in one org, with their current role. Only a
 * hash is stored, so the token itself is shown once, when it's created.
 */
export const ApiToken = Schema.Struct({
  id: Id,
  name: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
})
export interface ApiToken extends Schema.Schema.Type<typeof ApiToken> {}

export const CreateApiToken = Schema.Struct({ name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)) })
export interface CreateApiToken extends Schema.Schema.Type<typeof CreateApiToken> {}

export const CreatedApiToken = Schema.Struct({ ...ApiToken.fields, token: Schema.String })
export interface CreatedApiToken extends Schema.Schema.Type<typeof CreatedApiToken> {}

/** Tokens start with this, so they're easy to recognize (and for secret scanners to find). */
export const API_TOKEN_PREFIX = "sat_"

// --- Browser session (/api/auth/*) -------------------------------------------------------

/** The signed-in person, as the web app shows them. */
export const SessionUser = Schema.Struct({
  /** Actor id (`usr_…`). */
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
})
export interface SessionUser extends Schema.Schema.Type<typeof SessionUser> {}

export const SessionOrg = Schema.Struct({ id: Schema.String, name: Schema.String, plan: Plan })
export interface SessionOrg extends Schema.Schema.Type<typeof SessionOrg> {}

/**
 * What `POST /api/auth/ticket` answers. A dev server has no sign-in. A live one
 * either hands the signed-in browser a short-lived ticket (sent as a bearer
 * token, and as `?ticket=` on sockets) or says why it can't: signed out, or
 * sign-in isn't configured (`problem`).
 */
export const SessionInfo = Schema.Union([
  Schema.Struct({ mode: Schema.tag("dev") }),
  Schema.Struct({ mode: Schema.tag("live"), signedIn: Schema.Literal(false), problem: Schema.optionalKey(Schema.String) }),
  Schema.Struct({
    mode: Schema.tag("live"),
    signedIn: Schema.Literal(true),
    ticket: Schema.String,
    /** When the ticket expires (ms since the epoch). Ask again before then. */
    expiresAt: Schema.Number,
    user: SessionUser,
    org: SessionOrg,
    role: Role,
  }),
])
export type SessionInfo = typeof SessionInfo.Type

/** An org the signed-in person belongs to, for the switcher (`GET /api/auth/orgs`). */
export const SessionOrgChoice = Schema.Struct({ id: Schema.String, name: Schema.String, role: Role, current: Schema.Boolean })
export interface SessionOrgChoice extends Schema.Schema.Type<typeof SessionOrgChoice> {}
