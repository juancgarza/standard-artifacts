import { Effect, Redacted, Schema } from "effect"

/**
 * A small WorkOS client over plain `fetch`: just the User Management and
 * Organizations calls sign-in and member management need. No SDK, so the
 * Worker stays light and runs anywhere Workers do (Cloudflare, celld).
 *
 * WORKOS_API_URL points it somewhere other than https://api.workos.com, which
 * is how the tests run it against a fake.
 */

export class WorkOSError extends Schema.TaggedError<WorkOSError>()("WorkOSError", {
  /** HTTP status, or 0 when WorkOS couldn't be reached or answered with something unreadable. */
  status: Schema.Number,
  /** WorkOS's `code` or `error` (`invalid_grant`, `organization_selection_required`…), or "" */
  code: Schema.String,
  message: Schema.String,
  /** The error body, for errors that carry more (a pending authentication token). */
  body: Schema.Unknown,
}) {}

const Nullable = (s: Schema.String) => Schema.optionalKey(Schema.NullOr(s))

export const WorkOSUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  first_name: Nullable(Schema.String),
  last_name: Nullable(Schema.String),
  profile_picture_url: Nullable(Schema.String),
})
export interface WorkOSUser extends Schema.Schema.Type<typeof WorkOSUser> {}

export const Authenticated = Schema.Struct({
  user: WorkOSUser,
  organization_id: Nullable(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.String,
})
export interface Authenticated extends Schema.Schema.Type<typeof Authenticated> {}

export const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})
export interface Organization extends Schema.Schema.Type<typeof Organization> {}

const Slug = Schema.Struct({ slug: Schema.String })

export const Membership = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  organization_id: Schema.String,
  organization_name: Nullable(Schema.String),
  status: Schema.String,
  role: Schema.optionalKey(Schema.NullOr(Slug)),
  roles: Schema.optionalKey(Schema.NullOr(Schema.Array(Slug))),
  created_at: Schema.String,
  user: Schema.optionalKey(Schema.NullOr(WorkOSUser)),
})
export interface Membership extends Schema.Schema.Type<typeof Membership> {}

export const Invitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  state: Schema.String,
  organization_id: Nullable(Schema.String),
  role_slug: Nullable(Schema.String),
  expires_at: Schema.String,
  created_at: Schema.String,
})
export interface Invitation extends Schema.Schema.Type<typeof Invitation> {}

const List = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    data: Schema.Array(item),
    list_metadata: Schema.optionalKey(Schema.NullOr(Schema.Struct({ after: Nullable(Schema.String) }))),
  })

const Roles = Schema.Struct({ data: Schema.Array(Slug) })
const Empty = Schema.Unknown

/** Who picked which org, when WorkOS asks (`organization_selection_required`). */
export interface OrgSelection {
  readonly pendingToken: string
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export function orgSelection(e: WorkOSError): OrgSelection | undefined {
  if (e.code !== "organization_selection_required" || typeof e.body !== "object" || e.body === null) return undefined
  const body = e.body as { pending_authentication_token?: unknown; organizations?: unknown }
  if (typeof body.pending_authentication_token !== "string" || !Array.isArray(body.organizations)) return undefined
  const organizations = body.organizations.flatMap((o: unknown) =>
    typeof o === "object" && o !== null && typeof (o as { id?: unknown }).id === "string"
      ? [{ id: (o as { id: string }).id, name: String((o as { name?: unknown }).name ?? "") }]
      : [],
  )
  return { pendingToken: body.pending_authentication_token, organizations }
}

export interface WorkOSOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly clientId: string
  /** Default https://api.workos.com. */
  readonly apiUrl: string
}

type Query = Record<string, string | ReadonlyArray<string> | number | undefined>

export type WorkOSClient = ReturnType<typeof makeWorkOS>

export function makeWorkOS(options: WorkOSOptions) {
  const base = options.apiUrl.replace(/\/+$/, "")

  const call = <S extends Schema.Top & { readonly DecodingServices: never }>(
    method: string,
    path: string,
    schema: S,
    input: { readonly query?: Query; readonly body?: Record<string, unknown> } = {},
  ): Effect.Effect<S["Type"], WorkOSError> =>
    Effect.gen(function* () {
      const url = new URL(`${base}${path}`)
      for (const [k, v] of Object.entries(input.query ?? {})) {
        if (v === undefined) continue
        if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item))
        else url.searchParams.set(k, String(v))
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method,
            headers: {
              authorization: `Bearer ${Redacted.value(options.apiKey)}`,
              accept: "application/json",
              ...(input.body && { "content-type": "application/json" }),
            },
            ...(input.body && { body: JSON.stringify(input.body) }),
          }),
        catch: (e) => new WorkOSError({ status: 0, code: "", message: `Couldn't reach WorkOS: ${String(e)}`, body: null }),
      })
      const text = yield* Effect.promise(() => response.text())
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        // not JSON: handled below
      }
      if (!response.ok) {
        const b = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>
        const code = typeof b.code === "string" ? b.code : typeof b.error === "string" ? b.error : ""
        const message =
          typeof b.message === "string" ? b.message : typeof b.error_description === "string" ? b.error_description : `WorkOS answered ${response.status}`
        return yield* new WorkOSError({ status: response.status, code, message, body: json })
      }
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError((e) => new WorkOSError({ status: 0, code: "", message: `Unexpected answer from WorkOS ${method} ${path}: ${e.message}`, body: json })),
      )
    }).pipe(Effect.withSpan(`WorkOS ${method} ${path.replace(/\/(?:user|org|om|invitation)_[\w]+/g, "/:id")}`))

  const secret = () => ({ client_id: options.clientId, client_secret: Redacted.value(options.apiKey) })

  return {
    /** The AuthKit hosted sign-in page, which comes back to `redirectUri` with `?code&state`. */
    authorizeUrl: (p: { readonly redirectUri: string; readonly state: string; readonly screenHint?: "sign-in" | "sign-up"; readonly invitationToken?: string; readonly loginHint?: string }) => {
      const url = new URL(`${base}/user_management/authorize`)
      url.searchParams.set("client_id", options.clientId)
      url.searchParams.set("redirect_uri", p.redirectUri)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("provider", "authkit")
      url.searchParams.set("state", p.state)
      if (p.screenHint) url.searchParams.set("screen_hint", p.screenHint)
      if (p.invitationToken) url.searchParams.set("invitation_token", p.invitationToken)
      if (p.loginHint) url.searchParams.set("login_hint", p.loginHint)
      return url.toString()
    },
    /** Where to send the browser to end the AuthKit session too. */
    logoutUrl: (sessionId: string, returnTo: string) => {
      const url = new URL(`${base}/user_management/sessions/logout`)
      url.searchParams.set("session_id", sessionId)
      url.searchParams.set("return_to", returnTo)
      return url.toString()
    },
    authenticateWithCode: (code: string, userAgent?: string) =>
      call("POST", "/user_management/authenticate", Authenticated, {
        body: { ...secret(), grant_type: "authorization_code", code, ...(userAgent && { user_agent: userAgent }) },
      }),
    authenticateWithOrgSelection: (pendingToken: string, organizationId: string) =>
      call("POST", "/user_management/authenticate", Authenticated, {
        body: { ...secret(), grant_type: "urn:workos:oauth:grant-type:organization-selection", pending_authentication_token: pendingToken, organization_id: organizationId },
      }),
    /** A new access token (and, often, a new refresh token: always keep the latest). With `organizationId`, for that org. */
    refresh: (refreshToken: string, organizationId?: string) =>
      call("POST", "/user_management/authenticate", Authenticated, {
        body: { ...secret(), grant_type: "refresh_token", refresh_token: refreshToken, ...(organizationId && { organization_id: organizationId }) },
      }),
    getUser: (id: string) => call("GET", `/user_management/users/${encodeURIComponent(id)}`, WorkOSUser),
    getOrganization: (id: string) => call("GET", `/organizations/${encodeURIComponent(id)}`, Organization),
    createOrganization: (name: string) => call("POST", "/organizations", Organization, { body: { name } }),
    /** The roles an org can hand out (environment roles plus its own). */
    listRoles: (organizationId: string) =>
      Effect.map(call("GET", `/organizations/${encodeURIComponent(organizationId)}/roles`, Roles), (r) => r.data.map((x) => x.slug)),
    /** Every active membership matching the filter, following pages (up to 1,000). */
    listMemberships: (filter: { readonly userId?: string; readonly organizationId?: string }) =>
      Effect.gen(function* () {
        const all: Array<Membership> = []
        let after: string | undefined
        for (let page = 0; page < 10; page++) {
          const res = yield* call("GET", "/user_management/organization_memberships", List(Membership), {
            query: { user_id: filter.userId, organization_id: filter.organizationId, statuses: ["active"], limit: 100, after, order: "asc" },
          })
          all.push(...res.data)
          after = res.list_metadata?.after ?? undefined
          if (!after || res.data.length === 0) break
        }
        return all
      }),
    getMembership: (id: string) => call("GET", `/user_management/organization_memberships/${encodeURIComponent(id)}`, Membership),
    createMembership: (p: { readonly userId: string; readonly organizationId: string; readonly roleSlug: string | undefined }) =>
      call("POST", "/user_management/organization_memberships", Membership, {
        body: { user_id: p.userId, organization_id: p.organizationId, ...(p.roleSlug && { role_slug: p.roleSlug }) },
      }),
    updateMembership: (id: string, roleSlug: string) =>
      call("PUT", `/user_management/organization_memberships/${encodeURIComponent(id)}`, Membership, { body: { role_slug: roleSlug } }),
    deleteMembership: (id: string) => Effect.asVoid(call("DELETE", `/user_management/organization_memberships/${encodeURIComponent(id)}`, Empty)),
    listInvitations: (organizationId: string) =>
      Effect.map(
        call("GET", "/user_management/invitations", List(Invitation), { query: { organization_id: organizationId, limit: 100, order: "desc" } }),
        (r) => r.data,
      ),
    getInvitation: (id: string) => call("GET", `/user_management/invitations/${encodeURIComponent(id)}`, Invitation),
    sendInvitation: (p: { readonly email: string; readonly organizationId: string; readonly roleSlug: string | undefined; readonly inviterUserId: string | undefined }) =>
      call("POST", "/user_management/invitations", Invitation, {
        body: {
          email: p.email,
          organization_id: p.organizationId,
          ...(p.roleSlug && { role_slug: p.roleSlug }),
          ...(p.inviterUserId && { inviter_user_id: p.inviterUserId }),
        },
      }),
    resendInvitation: (id: string) => call("POST", `/user_management/invitations/${encodeURIComponent(id)}/resend`, Invitation),
    revokeInvitation: (id: string) => call("POST", `/user_management/invitations/${encodeURIComponent(id)}/revoke`, Invitation),
  }
}
