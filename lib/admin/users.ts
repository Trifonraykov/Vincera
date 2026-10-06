import "server-only"

import { and, desc, eq, ilike, isNull, lt, or, sql, type SQL } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { canSuspendUser, type AdminTargetUser, type AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  ideas,
  impersonationSessions,
  products,
  sessions,
  socialConnections,
  stripeAccounts,
  users,
} from "@/lib/db/schema"
import type { CollabRole, CollabStage, UserStatus } from "@/lib/db/schema/enums"
import { track } from "@/lib/events/track"
import type { UserRole } from "@/lib/auth/user"
import { payoutsStatusOf, type PayoutsStatus } from "@/lib/payouts/readiness"

import { writeAdminAudit } from "./audit"

/**
 * /admin/users (Phase 6; CLAUDE.md §19.38 "Users (admin)"): search, the detail page's data, and
 * suspension. Role grants and revocations live in lib/users/roles.ts; "view as" in
 * lib/admin/impersonation.ts. Admin pages show emails (admins need them for support); audit rows
 * and events never hold them.
 */

export const USER_ERRORS = {
  notFound: "That account doesn't exist.",
  cannotSuspend:
    "You can't suspend this account (your own, a deleted one, or an admin: revoke admin first).",
  alreadySuspended: "This account is already suspended.",
  notSuspended: "This account isn't suspended.",
  deleted: "This account was deleted; it stays suspended for good.",
} as const

export const USER_PAGE_SIZE = 50

export type UserRoleFilter = "creator" | "builder" | "admin"

export type AdminUserListItem = {
  id: string
  email: string | null
  name: string | null
  roles: UserRole[]
  status: UserStatus
  deletedAt: Date | null
  createdAt: Date
  onboardingCompletedAt: Date | null
  creatorHandle: string | null
  builderHandle: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Escape `%`, `_` and `\` for ILIKE. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/**
 * Users, newest first, 50 per page (`before` = the last row's `created_at` + id). `q` matches an
 * id exactly, or part of an email, a name or a handle.
 */
export async function searchUsers(
  db: DbOrTx,
  filter: {
    q?: string
    role?: UserRoleFilter
    status?: UserStatus | "deleted"
    before?: { createdAt: Date; id: string }
  } = {},
): Promise<{ items: AdminUserListItem[]; hasMore: boolean }> {
  const conditions: (SQL | undefined)[] = []
  const q = filter.q?.trim().slice(0, 100)
  if (q) {
    if (UUID_RE.test(q)) {
      conditions.push(eq(users.id, q.toLowerCase()))
    } else {
      const pattern = likePattern(q.replace(/^@/, ""))
      conditions.push(
        or(
          ilike(users.email, pattern),
          ilike(users.name, pattern),
          ilike(creatorProfiles.handle, pattern),
          ilike(builderProfiles.handle, pattern),
          ilike(creatorProfiles.displayName, pattern),
          ilike(builderProfiles.displayName, pattern),
        ),
      )
    }
  }
  if (filter.role) conditions.push(sql`${filter.role} = ANY(${users.roles})`)
  if (filter.status === "deleted") conditions.push(sql`${users.deletedAt} IS NOT NULL`)
  else if (filter.status) {
    conditions.push(eq(users.status, filter.status), isNull(users.deletedAt))
  }
  if (filter.before) {
    conditions.push(
      or(
        lt(users.createdAt, filter.before.createdAt),
        and(eq(users.createdAt, filter.before.createdAt), lt(users.id, filter.before.id)),
      ),
    )
  }
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      roles: users.roles,
      status: users.status,
      deletedAt: users.deletedAt,
      createdAt: users.createdAt,
      onboardingCompletedAt: users.onboardingCompletedAt,
      creatorHandle: creatorProfiles.handle,
      builderHandle: builderProfiles.handle,
    })
    .from(users)
    .leftJoin(creatorProfiles, eq(creatorProfiles.userId, users.id))
    .leftJoin(builderProfiles, eq(builderProfiles.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(USER_PAGE_SIZE + 1)
  return {
    items: rows.slice(0, USER_PAGE_SIZE).map((row) => ({ ...row, roles: [...row.roles] })),
    hasMore: rows.length > USER_PAGE_SIZE,
  }
}

export type AdminUserDetail = AdminUserListItem &
  AdminTargetUser & {
    activeRole: string | null
    sessionCount: number
    creatorProfile: { handle: string; displayName: string; sizeTier: string | null } | null
    builderProfile: { handle: string; displayName: string; availability: string } | null
    connections: {
      id: string
      provider: string
      source: "oauth" | "manual"
      status: string
      username: string | null
      profileUrl: string | null
      verifiedAt: Date | null
      lastSyncedAt: Date | null
      hasEvidence: boolean
    }[]
    stripe: {
      stripeAccountId: string
      status: PayoutsStatus
      payoutsEnabled: boolean
      chargesEnabled: boolean
      detailsSubmitted: boolean
      country: string | null
      disabledReason: string | null
    } | null
    collabs: { id: string; stage: CollabStage; role: CollabRole; title: string }[]
    openImpersonation: { sessionId: string; adminUserId: string; expiresAt: Date } | null
  }

/** Everything /admin/users/[id] shows, or null for an unknown id. */
export async function loadAdminUserDetail(
  db: DbOrTx,
  userId: string,
  at: Date = now(),
): Promise<AdminUserDetail | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      roles: users.roles,
      activeRole: users.activeRole,
      status: users.status,
      deletedAt: users.deletedAt,
      createdAt: users.createdAt,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
  if (!row) return null

  const [creator, builder, connections, stripe, collabRows, sessionRows, impersonation] =
    await Promise.all([
      db
        .select({
          handle: creatorProfiles.handle,
          displayName: creatorProfiles.displayName,
          sizeTier: creatorProfiles.sizeTier,
        })
        .from(creatorProfiles)
        .where(eq(creatorProfiles.userId, userId)),
      db
        .select({
          handle: builderProfiles.handle,
          displayName: builderProfiles.displayName,
          availability: builderProfiles.availability,
        })
        .from(builderProfiles)
        .where(eq(builderProfiles.userId, userId)),
      db
        .select({
          id: socialConnections.id,
          provider: socialConnections.provider,
          source: socialConnections.source,
          status: socialConnections.status,
          username: socialConnections.username,
          profileUrl: socialConnections.profileUrl,
          verifiedAt: socialConnections.verifiedAt,
          lastSyncedAt: socialConnections.lastSyncedAt,
          evidence: socialConnections.evidenceStorageKey,
        })
        .from(socialConnections)
        .where(eq(socialConnections.userId, userId))
        .orderBy(socialConnections.provider),
      db.select().from(stripeAccounts).where(eq(stripeAccounts.userId, userId)),
      db
        .select({
          id: collabs.id,
          stage: collabs.stage,
          role: collabMembers.role,
          ideaTitle: ideas.title,
          productTitle: products.title,
        })
        .from(collabMembers)
        .innerJoin(collabs, eq(collabs.id, collabMembers.collabId))
        .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
        .leftJoin(products, eq(products.id, collabs.productId))
        .where(eq(collabMembers.userId, userId))
        .orderBy(desc(collabs.createdAt)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), sql`${sessions.expires} > ${at}`)),
      db
        .select({
          sessionId: impersonationSessions.id,
          adminUserId: impersonationSessions.adminUserId,
          expiresAt: impersonationSessions.expiresAt,
        })
        .from(impersonationSessions)
        .where(
          and(
            eq(impersonationSessions.targetUserId, userId),
            isNull(impersonationSessions.endedAt),
            sql`${impersonationSessions.expiresAt} > ${at}`,
          ),
        )
        .limit(1),
    ])
  const account = stripe[0]
  return {
    ...row,
    roles: [...row.roles],
    creatorHandle: creator[0]?.handle ?? null,
    builderHandle: builder[0]?.handle ?? null,
    sessionCount: sessionRows[0]?.n ?? 0,
    creatorProfile: creator[0] ?? null,
    builderProfile: builder[0] ?? null,
    connections: connections.map(({ evidence, ...connection }) => ({
      ...connection,
      hasEvidence: evidence !== null,
    })),
    stripe: account
      ? {
          stripeAccountId: account.stripeAccountId,
          status: payoutsStatusOf(account),
          payoutsEnabled: account.payoutsEnabled,
          chargesEnabled: account.chargesEnabled,
          detailsSubmitted: account.detailsSubmitted,
          country: account.country,
          disabledReason: account.disabledReason,
        }
      : null,
    collabs: collabRows.map((collab) => ({
      id: collab.id,
      stage: collab.stage,
      role: collab.role,
      title: collab.ideaTitle ?? collab.productTitle ?? "Untitled",
    })),
    openImpersonation: impersonation[0] ?? null,
  }
}

/** The rows an admin rule needs about a target account, or null. */
export async function loadAdminTarget(
  db: DbOrTx,
  userId: string,
): Promise<(AdminTargetUser & { roles: AuthzUser["roles"] }) | null> {
  const [row] = await db
    .select({ id: users.id, roles: users.roles, status: users.status, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, userId))
  return row ?? null
}

/**
 * Suspend an account: status `suspended`, every database session deleted (signed out
 * everywhere at once), any "view as" of it ended, audit `user.suspended` and the event, in one
 * transaction. The caller authorizes; the rule is checked again under the row lock.
 */
export async function suspendUser(
  db: DbOrTx,
  admin: AuthzUser,
  input: { userId: string },
): Promise<{ sessionsDeleted: number }> {
  return withTransaction(async (tx) => {
    const [target] = await tx
      .select({
        id: users.id,
        roles: users.roles,
        status: users.status,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update")
    if (!target) throw new ActionError(USER_ERRORS.notFound)
    if (!canSuspendUser(admin, target)) throw new ActionError(USER_ERRORS.cannotSuspend)
    if (target.status === "suspended") throw new ActionError(USER_ERRORS.alreadySuspended)

    const at = now()
    await tx.update(users).set({ status: "suspended" }).where(eq(users.id, target.id))
    const deleted = await tx
      .delete(sessions)
      .where(eq(sessions.userId, target.id))
      .returning({ token: sessions.sessionToken })
    await tx
      .update(impersonationSessions)
      .set({ endedAt: at, endReason: "stopped" })
      .where(
        and(
          eq(impersonationSessions.targetUserId, target.id),
          isNull(impersonationSessions.endedAt),
        ),
      )
    await writeAdminAudit(tx, {
      adminUserId: admin.id,
      action: "user.suspended",
      targetType: "user",
      targetId: target.id,
      before: { status: "active" },
      after: { status: "suspended", sessions_deleted: deleted.length },
    })
    await track(
      "user.suspended",
      { actorUserId: admin.id, subjectType: "user", subjectId: target.id, properties: {} },
      tx,
    )
    return { sessionsDeleted: deleted.length }
  }, db)
}

/** Lift a suspension (never for a deleted account); audited, `user.unsuspended`. */
export async function unsuspendUser(
  db: DbOrTx,
  admin: AuthzUser,
  input: { userId: string },
): Promise<void> {
  await withTransaction(async (tx) => {
    const [target] = await tx
      .select({
        id: users.id,
        roles: users.roles,
        status: users.status,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update")
    if (!target) throw new ActionError(USER_ERRORS.notFound)
    if (target.deletedAt) throw new ActionError(USER_ERRORS.deleted)
    if (!canSuspendUser(admin, target)) throw new ActionError(USER_ERRORS.cannotSuspend)
    if (target.status !== "suspended") throw new ActionError(USER_ERRORS.notSuspended)
    await tx.update(users).set({ status: "active" }).where(eq(users.id, target.id))
    await writeAdminAudit(tx, {
      adminUserId: admin.id,
      action: "user.unsuspended",
      targetType: "user",
      targetId: target.id,
      before: { status: "suspended" },
      after: { status: "active" },
    })
    await track(
      "user.unsuspended",
      { actorUserId: admin.id, subjectType: "user", subjectId: target.id, properties: {} },
      tx,
    )
  }, db)
}
