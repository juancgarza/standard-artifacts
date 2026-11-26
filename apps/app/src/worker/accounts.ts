import { Cache, Config, Context, Duration, Effect, Exit, Layer, Redacted, Schema } from "effect"
import {
  Forbidden,
  Invalid,
  NotFound,
  Unavailable,
  type InvitationState,
  type InviteMember,
  type OrgInvitation,
  type OrgMember,
  type OrgMembers,
  type Principal,
  type Role,
  type SessionOrgChoice,
} from "@standard-artifacts/protocol"
import {
  REFRESH_MARGIN_S,
  STATE_MAX_AGE_S,
  TICKET_TTL_S,
  accessClaims,
  cookieKey,
  displayName,
  isSession,
  isSignInState,
  randomState,
  roleFromSlugs,
  safeReturnTo,
  seal,
  signInProblem,
  slugForRole,
  unseal,
  userActorId,
  workosUserId,
  workspaceName,
  type Session,
} from "./session"
import { Bindings } from "./env"
import { signTicket } from "./tickets"
import { makeWorkOS, orgSelection, type Authenticated, type Invitation, type Membership, type WorkOSClient, type WorkOSError, type WorkOSUser } from "./workos"

/**
 * Accounts: sign-in, orgs, members, roles and invitations, with WorkOS as the
 * source of truth (Standard Artifacts Cloud's `live` auth mode).
 *
 * - Session. The browser holds an httpOnly cookie sealed with
 *   WORKOS_COOKIE_PASSWORD: the WorkOS refresh token plus the claims of the
 *   latest access token (user, org, role). It never reaches a cell.
 * - Tickets. Cells trust only HMAC tickets (celld can't verify WorkOS's RS256
 *   tokens). `mint` turns the session into a 5-minute ticket, refreshing the
 *   WorkOS access token first when it's about to expire, so a role change or a
 *   removal reaches tickets within minutes.
 * - Orgs. A session is scoped to one WorkOS organization. Switching asks WorkOS
 *   for a token in another org the person belongs to. Someone signing in with
 *   no org gets one ("Ada's workspace") with an owner membership.
 * - Roles. WorkOS role slugs owner, editor and viewer map to ours; admin and
 *   member (WorkOS's defaults) map to owner and editor (see session.ts).
 *
 * In dev mode, or live mode without the config, none of this runs: `problem`
 * says why, and live mode never falls back to dev.
 */

export class SignInError extends Schema.TaggedError<SignInError>()("SignInError", {
  /** signed-out: show the sign-in screen. The rest are shown as they are. */
  reason: Schema.Literals(["signed-out", "forbidden", "invalid", "unavailable", "misconfigured"]),
  message: Schema.String,
}) {}

export type AccountError = Forbidden | NotFound | Invalid | Unavailable

export interface SignInStart {
  /** Where to send the browser (AuthKit). */
  readonly location: string
  /** The sealed sign-in state, for the state cookie. */
  readonly stateCookie: string
}

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly mode: "dev" | "live"
    /** Why sign-in can't work here (live mode with missing config), or undefined. */
    readonly problem: string | undefined
    /** The app's address: APP_URL, or the request's origin. */
    readonly appOrigin: (request: Request) => string
    readonly startSignIn: (
      request: Request,
      options: { readonly returnTo?: string | null; readonly invitationToken?: string | null; readonly screenHint?: "sign-in" | "sign-up" },
    ) => Effect.Effect<SignInStart, SignInError>
    readonly finishSignIn: (
      request: Request,
      input: { readonly code: string; readonly state: string; readonly stateCookie: string | undefined; readonly lastOrg: string | undefined },
    ) => Effect.Effect<{ readonly session: Session; readonly returnTo: string }, SignInError>
    readonly readSession: (cookie: string | undefined) => Effect.Effect<Session | undefined>
    readonly sealSession: (session: Session) => Effect.Effect<string, SignInError>
    /** The session, with a new access token if the last one is about to expire. */
    readonly fresh: (session: Session) => Effect.Effect<Session, SignInError>
    readonly mint: (session: Session) => Effect.Effect<{ readonly ticket: string; readonly expiresAt: number; readonly principal: Principal }, SignInError>
    readonly orgs: (session: Session) => Effect.Effect<ReadonlyArray<SessionOrgChoice>, SignInError>
    readonly switchOrg: (session: Session, orgId: string) => Effect.Effect<Session, SignInError>
    readonly createOrg: (session: Session, name: string) => Effect.Effect<Session, SignInError>
    /** Where to send the browser after clearing our cookies: AuthKit's sign-out, which comes back to the app. */
    readonly signOutUrl: (request: Request, session: Session | undefined) => string

    readonly members: (p: Principal) => Effect.Effect<OrgMembers, AccountError>
    readonly invite: (p: Principal, input: InviteMember) => Effect.Effect<OrgInvitation, AccountError>
    readonly resendInvitation: (p: Principal, id: string) => Effect.Effect<OrgInvitation, AccountError>
    readonly revokeInvitation: (p: Principal, id: string) => Effect.Effect<void, AccountError>
    readonly updateMember: (p: Principal, id: string, role: Role) => Effect.Effect<OrgMember, AccountError>
    /** Removes the membership and returns the person's actor id, so their tokens can go too. */
    readonly removeMember: (p: Principal, id: string) => Effect.Effect<string, AccountError>
    /** A person's role in an org right now, or null if they aren't a member. Undefined when there are no accounts (dev). */
    readonly currentRole: (orgId: string, actorId: string) => Effect.Effect<Role | null | undefined, Unavailable>
  }
>()("@standard-artifacts/Accounts") {
  static readonly layer = Layer.effect(
    Accounts,
    Effect.gen(function* () {
      const text = (name: string) => Config.String(name).pipe(Config.withDefault(""))
      const secret = (name: string) => Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")))
      const env = yield* Bindings
      const mode = (yield* Config.String("AUTH_MODE").pipe(Config.withDefault("live"))) === "dev" ? "dev" : "live"
      const ticketSecret = Redacted.value(yield* secret("TICKET_SECRET"))
      const apiKey = yield* secret("WORKOS_API_KEY")
      const clientId = (yield* text("WORKOS_CLIENT_ID")).trim()
      const password = Redacted.value(yield* secret("WORKOS_COOKIE_PASSWORD"))
      const appUrl = (yield* text("APP_URL")).trim()
      const apiUrl = (yield* text("WORKOS_API_URL")).trim() || "https://api.workos.com"

      const problem =
        mode === "live"
          ? signInProblem({ TICKET_SECRET: ticketSecret, WORKOS_API_KEY: Redacted.value(apiKey), WORKOS_CLIENT_ID: clientId, WORKOS_COOKIE_PASSWORD: password, APP_URL: appUrl })
          : undefined
      if (problem) console.error(`Standard Artifacts: ${problem} Every sign-in will fail until it's fixed.`)
      const ready = mode === "live" && !problem
      const wos: WorkOSClient | undefined = ready ? makeWorkOS({ apiKey, clientId, apiUrl }) : undefined
      const key = ready ? yield* Effect.promise(() => cookieKey(password)) : undefined

      const appOrigin = (request: Request) => (appUrl ? new URL(appUrl).origin : new URL(request.url).origin)
      const nowS = () => Math.floor(Date.now() / 1000)

      const notReady = () =>
        mode === "dev"
          ? new SignInError({ reason: "misconfigured", message: "This server has no sign-in (AUTH_MODE=dev)." })
          : new SignInError({ reason: "misconfigured", message: problem ?? "Sign-in isn't configured." })

      /** WorkOS and the cookie key, or a clear failure. */
      const client = Effect.suspend(() => (wos && key ? Effect.succeed({ wos, key }) : Effect.fail(notReady())))

      const unavailable = (e: WorkOSError) => {
        console.error(`WorkOS: ${e.status} ${e.code} ${e.message}`)
        return new SignInError({ reason: "unavailable", message: "The account service didn't answer. Try again in a moment." })
      }
      const signedOut = () => new SignInError({ reason: "signed-out", message: "Your session ended. Sign in again." })
      /**
       * Refreshing the session in its own org. Only a refresh token WorkOS
       * refused (`invalid_grant`, 400, 401) ends the session, and so does a
       * sign-in step the org now asks for (SSO, MFA), which only a fresh trip
       * through AuthKit can do. Anything else, rate limits and outages
       * included, keeps the cookie and says to try again.
       */
      const refreshFailed = (e: WorkOSError) =>
        isTransient(e) ? unavailable(e) : e.code === "invalid_grant" || e.status === 400 || e.status === 401 || STEP_UP.has(e.code) ? signedOut() : unavailable(e)
      /**
       * Refreshing into another org (switching). The session is still fine where it
       * is, so only a dead refresh token signs out. An org that wants SSO or MFA,
       * or any other refusal, is an answer about that org.
       */
      const switchFailed = (e: WorkOSError) => {
        if (isTransient(e)) return unavailable(e)
        if (e.code === "invalid_grant" || e.status === 401) return signedOut()
        if (STEP_UP.has(e.code)) {
          return new SignInError({ reason: "forbidden", message: "That workspace asks you to sign in with its own method (like SSO or MFA). Sign out, then sign in to it." })
        }
        return new SignInError({ reason: "invalid", message: e.message || "Couldn't switch to that workspace." })
      }
      const signInFailed = (e: WorkOSError) =>
        isTransient(e) ? unavailable(e) : new SignInError({ reason: "invalid", message: e.message || "Sign-in failed. Try again." })

      // The roles an org can hand out barely change; look them up once in a while, not per invite.
      const roleSlugs = yield* Cache.makeWith(
        (orgId: string) =>
          wos ? wos.listRoles(orgId).pipe(Effect.map((slugs): ReadonlySet<string> | undefined => new Set(slugs)), Effect.orElseSucceed(() => undefined)) : Effect.succeed(undefined),
        { capacity: 1000, timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value ? Duration.minutes(5) : Duration.zero) },
      )

      const roleOf = (m: Membership): Role => roleFromSlugs(m.roles?.length ? m.roles.map((r) => r.slug) : [m.role?.slug])

      // --- Sessions ------------------------------------------------------------------------------

      const sessionUser = (u: WorkOSUser): Session["user"] => ({ id: u.id, name: displayName(u), email: u.email, avatarUrl: u.profile_picture_url ?? null })

      /** A session from a fresh WorkOS answer: its access token says the org and role; WorkOS says the org's name and plan. */
      const toSession = Effect.fn("Accounts.toSession")(function* (auth: Authenticated) {
        const { wos } = yield* client
        const claims = accessClaims(auth.access_token)
        const orgId = claims?.orgId ?? auth.organization_id ?? undefined
        if (!claims || !orgId) return yield* new SignInError({ reason: "unavailable", message: "WorkOS didn't say which workspace this sign-in is for." })
        const org = yield* wos.getOrganization(orgId).pipe(Effect.mapError(signInFailed))
        let role: Role
        if (claims.roles.length) role = roleFromSlugs(claims.roles)
        else {
          const [membership] = yield* wos.listMemberships({ userId: auth.user.id, organizationId: orgId }).pipe(Effect.mapError(signInFailed))
          if (!membership) return yield* new SignInError({ reason: "forbidden", message: "You aren't a member of that workspace." })
          role = roleOf(membership)
        }
        return {
          v: 1,
          refreshToken: auth.refresh_token,
          sessionId: claims.sid,
          accessExp: claims.exp,
          user: sessionUser(auth.user),
          org: { id: org.id, name: org.name, plan: planOf(org.metadata) },
          role,
        } satisfies Session
      })

      /** A new org with this person as its owner. */
      const createWorkspace = Effect.fn("Accounts.createWorkspace")(function* (userId: string, name: string) {
        const { wos } = yield* client
        const org = yield* wos.createOrganization(name).pipe(Effect.mapError(signInFailed))
        const slug = slugForRole("owner", yield* Cache.get(roleSlugs, org.id))
        if (!slug) console.warn(`WorkOS has no "owner" or "admin" role, so ${userActorId(userId)} joins ${org.id} with the default role`)
        yield* wos.createMembership({ userId, organizationId: org.id, roleSlug: slug }).pipe(Effect.mapError(signInFailed))
        return org.id
      })

      /** Where someone lands when WorkOS didn't pick an org: the last one they used, any one they're in, or a new one. */
      const landingOrg = Effect.fn("Accounts.landingOrg")(function* (user: WorkOSUser, lastOrg: string | undefined) {
        const { wos } = yield* client
        const memberships = yield* wos.listMemberships({ userId: user.id }).pipe(Effect.mapError(signInFailed))
        const pick = memberships.find((m) => m.organization_id === lastOrg) ?? memberships[0]
        return pick ? pick.organization_id : yield* createWorkspace(user.id, workspaceName(user))
      })

      const startSignIn: Accounts["Service"]["startSignIn"] = Effect.fn("Accounts.startSignIn")(function* (request, options) {
        const { wos, key } = yield* client
        const state = randomState()
        const stateCookie = yield* Effect.promise(() =>
          seal(key, "signin", { state, returnTo: safeReturnTo(options.returnTo, appOrigin(request)), exp: nowS() + STATE_MAX_AGE_S }),
        )
        const location = wos.authorizeUrl({
          redirectUri: `${appOrigin(request)}/api/auth/callback`,
          state,
          ...(options.screenHint && { screenHint: options.screenHint }),
          ...(options.invitationToken && { invitationToken: options.invitationToken }),
        })
        return { location, stateCookie }
      })

      const finishSignIn: Accounts["Service"]["finishSignIn"] = Effect.fn("Accounts.finishSignIn")(function* (request, input) {
        const { wos, key } = yield* client
        const started = yield* Effect.promise(() => unseal(key, "signin", input.stateCookie))
        if (!isSignInState(started) || started.state !== input.state || started.exp < nowS()) {
          return yield* new SignInError({ reason: "invalid", message: "This sign-in expired or was started in another browser. Try again." })
        }
        const userAgent = request.headers.get("user-agent") ?? undefined
        let auth = yield* wos.authenticateWithCode(input.code, userAgent).pipe(
          Effect.catchTag("WorkOSError", (e) => {
            // Someone in several orgs: land in the last one they used here, or the first.
            const selection = orgSelection(e)
            const pick = selection && (selection.organizations.find((o) => o.id === input.lastOrg) ?? selection.organizations[0])
            return selection && pick ? wos.authenticateWithOrgSelection(selection.pendingToken, pick.id) : Effect.fail(e)
          }),
          Effect.mapError(signInFailed),
        )
        if (!accessClaims(auth.access_token)?.orgId && !auth.organization_id) {
          const orgId = yield* landingOrg(auth.user, input.lastOrg)
          auth = yield* wos.refresh(auth.refresh_token, orgId).pipe(Effect.mapError(signInFailed))
        }
        return { session: yield* toSession(auth), returnTo: started.returnTo }
      })

      const readSession: Accounts["Service"]["readSession"] = (cookie) =>
        key && cookie ? Effect.promise(() => unseal(key, "session", cookie)).pipe(Effect.map((v) => (isSession(v) ? v : undefined))) : Effect.succeed(undefined)

      const sealSession: Accounts["Service"]["sealSession"] = (session) =>
        Effect.flatMap(client, ({ key }) => Effect.promise(() => seal(key, "session", session)))

      const fresh: Accounts["Service"]["fresh"] = Effect.fn("Accounts.fresh")(function* (session) {
        if (session.accessExp - REFRESH_MARGIN_S > nowS()) return session
        const { wos } = yield* client
        const auth = yield* wos.refresh(session.refreshToken, session.org.id).pipe(Effect.mapError(refreshFailed))
        return yield* toSession(auth)
      })

      const mint: Accounts["Service"]["mint"] = Effect.fn("Accounts.mint")(function* (session) {
        yield* client
        const principal: Principal = {
          orgId: session.org.id,
          orgName: session.org.name,
          plan: session.org.plan,
          role: session.role,
          actor: { type: "user", id: userActorId(session.user.id), name: session.user.name },
        }
        const now = Date.now()
        const ticket = yield* Effect.promise(() => signTicket(ticketSecret, principal, TICKET_TTL_S, now))
        return { ticket, expiresAt: now + TICKET_TTL_S * 1000, principal }
      })

      const orgs: Accounts["Service"]["orgs"] = Effect.fn("Accounts.orgs")(function* (session) {
        const { wos } = yield* client
        const memberships = yield* wos.listMemberships({ userId: session.user.id }).pipe(Effect.mapError(signInFailed))
        const choices = yield* Effect.forEach(
          memberships,
          (m) =>
            Effect.map(
              m.organization_name ? Effect.succeed(m.organization_name) : wos.getOrganization(m.organization_id).pipe(Effect.map((o) => o.name), Effect.orElseSucceed(() => m.organization_id)),
              (name): SessionOrgChoice => ({ id: m.organization_id, name, role: roleOf(m), current: m.organization_id === session.org.id }),
            ),
          { concurrency: 8 },
        )
        return choices.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      })

      const switchOrg: Accounts["Service"]["switchOrg"] = Effect.fn("Accounts.switchOrg")(function* (session, orgId) {
        const { wos } = yield* client
        // Asked first, so "not a member" doesn't read as "your session ended".
        const [membership] = yield* wos.listMemberships({ userId: session.user.id, organizationId: orgId }).pipe(Effect.mapError(signInFailed))
        if (!membership) return yield* new SignInError({ reason: "forbidden", message: "You aren't a member of that workspace." })
        const auth = yield* wos.refresh(session.refreshToken, orgId).pipe(Effect.mapError(switchFailed))
        return yield* toSession(auth)
      })

      const createOrg: Accounts["Service"]["createOrg"] = Effect.fn("Accounts.createOrg")(function* (session, name) {
        const { wos } = yield* client
        const clean = name.replace(/\s+/g, " ").trim()
        if (!clean || clean.length > 80) return yield* new SignInError({ reason: "invalid", message: "Name the workspace (up to 80 characters)." })
        // TODO(Cloud tracker #7): real quotas. Until then, a flat cap on the workspaces each person owns.
        const owned = (yield* wos.listMemberships({ userId: session.user.id }).pipe(Effect.mapError(signInFailed))).filter((m) => roleOf(m) === "owner")
        if (owned.length >= MAX_OWNED_ORGS) {
          return yield* new SignInError({ reason: "forbidden", message: `You already own ${MAX_OWNED_ORGS} workspaces, the most one person can own for now.` })
        }
        // TODO(Cloud tracker #4, billing and seats): a new workspace starts on the free plan.
        const orgId = yield* createWorkspace(session.user.id, clean)
        return yield* switchOrg(session, orgId)
      })

      const signOutUrl: Accounts["Service"]["signOutUrl"] = (request, session) =>
        wos && session ? wos.logoutUrl(session.sessionId, `${appOrigin(request)}/`) : "/"

      // --- Members, roles, invitations -----------------------------------------------------------------

      const toApi = (e: WorkOSError): AccountError => {
        if (e.status === 404) return new NotFound({ message: "Not found" })
        if (isTransient(e)) {
          console.error(`WorkOS: ${e.status} ${e.code} ${e.message}`)
          return new Unavailable({ message: "The account service didn't answer. Try again in a moment." })
        }
        return new Invalid({ message: e.message })
      }

      const api = Effect.suspend(() =>
        wos ? Effect.succeed(wos) : Effect.fail(new Unavailable({ message: mode === "dev" ? "This server has no accounts (dev mode)." : (problem ?? "Sign-in isn't configured.") })),
      )

      const toMember = Effect.fn("Accounts.toMember")(function* (m: Membership) {
        const w = yield* api
        const user = m.user ?? (yield* w.getUser(m.user_id).pipe(Effect.mapError(toApi)))
        return {
          id: m.id,
          userId: userActorId(m.user_id),
          name: displayName(user),
          email: user.email,
          avatarUrl: user.profile_picture_url ?? null,
          role: roleOf(m),
          joinedAt: m.created_at,
        } satisfies OrgMember
      })

      const toInvitation = (i: Invitation): OrgInvitation => ({
        id: i.id,
        email: i.email,
        // An invite made elsewhere without a role gets WorkOS's default role, member.
        role: roleFromSlugs([i.role_slug ?? "member"]),
        state: (["pending", "accepted", "expired", "revoked"] as const).includes(i.state as InvitationState) ? (i.state as InvitationState) : "pending",
        expiresAt: i.expires_at,
        createdAt: i.created_at,
      })

      const currentRole: Accounts["Service"]["currentRole"] = Effect.fn("Accounts.currentRole")(function* (orgId, actorId) {
        // Dev has no accounts. Live mode with broken config can't check anyone: that's unavailable, so
        // access tokens fall back on their grace period and then stop, instead of keeping a role forever.
        if (mode === "dev") return undefined
        if (!wos) return yield* new Unavailable({ message: problem ?? "Sign-in isn't configured." })
        const userId = workosUserId(actorId)
        if (!userId) return null
        const [membership] = yield* wos.listMemberships({ userId, organizationId: orgId }).pipe(
          Effect.mapError((e) => {
            console.error(`WorkOS: ${e.status} ${e.code} ${e.message}`)
            return new Unavailable({ message: "The account service didn't answer. Try again in a moment." })
          }),
        )
        return membership ? roleOf(membership) : null
      })

      /** Owners manage members. The ticket says so, and WorkOS is asked again before anything changes. */
      const requireOwner = Effect.fn("Accounts.requireOwner")(function* (p: Principal) {
        yield* api
        if (p.actor.type !== "user" || p.role !== "owner") return yield* new Forbidden({ message: "Only owners can manage members." })
        if ((yield* currentRole(p.orgId, p.actor.id)) !== "owner") return yield* new Forbidden({ message: "Only owners can manage members." })
      })

      /** A membership in the caller's org; anyone else's reads as not found. */
      const ownMembership = Effect.fn("Accounts.ownMembership")(function* (p: Principal, id: string) {
        const w = yield* api
        const m = yield* w.getMembership(id).pipe(Effect.mapError(toApi))
        if (m.organization_id !== p.orgId) return yield* new NotFound({ message: "Not found" })
        return m
      })

      const ownInvitation = Effect.fn("Accounts.ownInvitation")(function* (p: Principal, id: string) {
        const w = yield* api
        const i = yield* w.getInvitation(id).pipe(Effect.mapError(toApi))
        if (i.organization_id !== p.orgId) return yield* new NotFound({ message: "Not found" })
        return i
      })

      const owners = Effect.fn("Accounts.owners")(function* (orgId: string) {
        const w = yield* api
        const all = yield* w.listMemberships({ organizationId: orgId }).pipe(Effect.mapError(toApi))
        return all.filter((m) => roleOf(m) === "owner").length
      })

      /**
       * Run a member change holding the org's member lock (in its WorkspaceCell),
       * so changes go one at a time: the owner check, the last-owner count and the
       * write can't interleave with another owner's change.
       */
      const withMemberLock = <A, E, R>(orgId: string, change: Effect.Effect<A, E, R>) => {
        const cell = env.WORKSPACE.get(env.WORKSPACE.idFromName(orgId))
        const holder = crypto.randomUUID()
        const acquire = Effect.gen(function* () {
          const deadline = Date.now() + MEMBER_LOCK_WAIT_MS
          while (!(yield* Effect.promise(() => cell.lockMembers(holder, MEMBER_LOCK_TTL_MS)))) {
            if (Date.now() > deadline) return yield* new Unavailable({ message: "Someone else is changing members right now. Try again in a moment." })
            yield* Effect.sleep(Duration.millis(50))
          }
        })
        return Effect.acquireUseRelease(
          acquire,
          () => change,
          () => Effect.promise(() => cell.unlockMembers(holder)).pipe(Effect.ignore),
        )
      }

      /** After a change: if the org has no owner left (someone changed WorkOS directly meanwhile), undo it. */
      const keepAnOwner = Effect.fn("Accounts.keepAnOwner")(function* (orgId: string, undo: Effect.Effect<unknown, AccountError>) {
        if ((yield* owners(orgId)) > 0) return
        yield* undo
        return yield* new Invalid({ message: "That would leave the workspace without an owner. Make someone else an owner first." })
      })

      const slugFor = Effect.fn("Accounts.slugFor")(function* (orgId: string, role: Role) {
        const slug = slugForRole(role, yield* Cache.get(roleSlugs, orgId))
        if (!slug) return yield* new Invalid({ message: `The account service has no "${role}" role. Add it under Roles in the WorkOS dashboard.` })
        return slug
      })

      const members: Accounts["Service"]["members"] = Effect.fn("Accounts.members")(function* (p) {
        if (p.actor.type === "guest") return yield* new Forbidden({ message: "Guests can't see the workspace's members." })
        const w = yield* api
        const [memberships, invitations] = yield* Effect.all(
          [w.listMemberships({ organizationId: p.orgId }).pipe(Effect.mapError(toApi)), w.listInvitations(p.orgId).pipe(Effect.mapError(toApi))],
          { concurrency: 2 },
        )
        const people = yield* Effect.forEach(memberships, toMember, { concurrency: 8 })
        return {
          members: people.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
          invitations: invitations.filter((i) => i.state === "pending" && i.organization_id === p.orgId).map(toInvitation),
          canManage: p.actor.type === "user" && p.role === "owner",
        }
      })

      const invite: Accounts["Service"]["invite"] = Effect.fn("Accounts.invite")(function* (p, input) {
        yield* requireOwner(p)
        const w = yield* api
        const roleSlug = yield* slugFor(p.orgId, input.role)
        // TODO(Cloud tracker #4, billing and seats): enforce seat limits by plan here. Invites aren't blocked on the plan yet.
        const sent = yield* w
          .sendInvitation({ email: input.email.toLowerCase(), organizationId: p.orgId, roleSlug, inviterUserId: workosUserId(p.actor.id) })
          .pipe(Effect.mapError(toApi))
        return toInvitation(sent)
      })

      const resendInvitation: Accounts["Service"]["resendInvitation"] = Effect.fn("Accounts.resendInvitation")(function* (p, id) {
        yield* requireOwner(p)
        yield* ownInvitation(p, id)
        const w = yield* api
        return toInvitation(yield* w.resendInvitation(id).pipe(Effect.mapError(toApi)))
      })

      const revokeInvitation: Accounts["Service"]["revokeInvitation"] = Effect.fn("Accounts.revokeInvitation")(function* (p, id) {
        yield* requireOwner(p)
        yield* ownInvitation(p, id)
        const w = yield* api
        yield* w.revokeInvitation(id).pipe(Effect.mapError(toApi))
      })

      const lastOwner = (m: Membership, p: Principal) =>
        new Invalid({
          message:
            userActorId(m.user_id) === p.actor.id
              ? "You're the only owner. Make someone else an owner first."
              : "They're the only owner. Make someone else an owner first.",
        })

      const updateMember: Accounts["Service"]["updateMember"] = (p, id, role) =>
        withMemberLock(
          p.orgId,
          Effect.gen(function* () {
            yield* requireOwner(p)
            const m = yield* ownMembership(p, id)
            const demoting = roleOf(m) === "owner" && role !== "owner"
            if (demoting && (yield* owners(p.orgId)) <= 1) return yield* lastOwner(m, p)
            const w = yield* api
            const updated = yield* w.updateMembership(id, yield* slugFor(p.orgId, role)).pipe(Effect.mapError(toApi))
            if (demoting) {
              yield* keepAnOwner(p.orgId, w.updateMembership(id, yield* slugFor(p.orgId, "owner")).pipe(Effect.mapError(toApi)))
            }
            return yield* toMember({ ...updated, user: updated.user ?? m.user ?? null })
          }),
        ).pipe(Effect.withSpan("Accounts.updateMember"))

      const removeMember: Accounts["Service"]["removeMember"] = (p, id) =>
        withMemberLock(
          p.orgId,
          Effect.gen(function* () {
            yield* requireOwner(p)
            const m = yield* ownMembership(p, id)
            const wasOwner = roleOf(m) === "owner"
            if (wasOwner && (yield* owners(p.orgId)) <= 1) return yield* lastOwner(m, p)
            const w = yield* api
            yield* w.deleteMembership(id).pipe(Effect.mapError(toApi))
            if (wasOwner) {
              const slug = yield* slugFor(p.orgId, "owner")
              yield* keepAnOwner(p.orgId, w.createMembership({ userId: m.user_id, organizationId: p.orgId, roleSlug: slug }).pipe(Effect.mapError(toApi)))
            }
            return userActorId(m.user_id)
          }),
        ).pipe(Effect.withSpan("Accounts.removeMember"))

      return Accounts.of({
        mode,
        problem,
        appOrigin,
        startSignIn,
        finishSignIn,
        readSession,
        sealSession,
        fresh,
        mint,
        orgs,
        switchOrg,
        createOrg,
        signOutUrl,
        members,
        invite,
        resendInvitation,
        revokeInvitation,
        updateMember,
        removeMember,
        currentRole,
      })
    }),
  )
}

/**
 * The org's plan, from WorkOS organization metadata `plan` ("free" or "team").
 * TODO(Cloud tracker #4, billing and seats): billing sets it. Until then every org is on free, and nothing is
 * enforced by plan here.
 */
const planOf = (metadata: Readonly<Record<string, unknown>> | null | undefined): Session["org"]["plan"] => (metadata?.plan === "team" ? "team" : "free")

/** The most workspaces one person can own through "New workspace" (a stopgap until real quotas, Cloud tracker #7). */
export const MAX_OWNED_ORGS = 10

/** WorkOS couldn't answer just now (down, rate limited): try again, nothing is decided. */
const isTransient = (e: WorkOSError) => e.status === 0 || e.status === 429 || e.status >= 500

/**
 * WorkOS authentication errors that ask for another sign-in step in AuthKit
 * (https://workos.com/docs/reference/authkit/authentication-errors).
 */
const STEP_UP: ReadonlySet<string> = new Set([
  "sso_required",
  "mfa_enrollment",
  "mfa_challenge",
  "organization_authentication_methods_required",
  "email_verification_required",
  "radar_email_challenge",
  "radar_sms_challenge",
])

/** How long a member change may hold the org's member lock, and how long to wait for it. */
const MEMBER_LOCK_TTL_MS = 30_000
const MEMBER_LOCK_WAIT_MS = 10_000
