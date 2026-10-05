import "server-only"

import { and, eq, sql } from "drizzle-orm"

import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { adminAuditLog, users } from "@/lib/db/schema"
import { sortRoles, type UserRole } from "@/lib/auth/user"
import { trackMany } from "@/lib/events/track"
import type { RoleSource } from "@/lib/events/types"
import type { AppRole } from "@/lib/nav"

/**
 * Role changes on `users.roles` / `users.active_role` (§5, §6). Every added role emits
 * `user.role_added` in the same transaction (§11); admin grants are also written to
 * `admin_audit_log` (§14).
 */

export class UserNotFoundError extends Error {
  constructor() {
    super("User not found")
    this.name = "UserNotFoundError"
  }
}

export type AddRolesInput = {
  userId: string
  roles: readonly UserRole[]
  source: RoleSource
  /** Who caused the change; null for system/CLI changes. */
  actorUserId: string | null
  /** Also make this the active role. It must be among the user's roles afterwards. */
  activeRole?: AppRole
}

export type RoleChange = {
  roles: UserRole[]
  /** Roles the user did not have before, in canonical order. */
  added: UserRole[]
  activeRole: UserRole | null
}

/** Add roles (a union; roles are never removed here) and optionally set the active role. */
export async function addUserRoles(database: DbOrTx, input: AddRolesInput): Promise<RoleChange> {
  return withTransaction(async (tx) => {
    const [current] = await tx
      .select({ roles: users.roles, activeRole: users.activeRole })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update")
    if (!current) throw new UserNotFoundError()

    const roles = sortRoles([...current.roles, ...input.roles])
    const added = roles.filter((role) => !current.roles.includes(role))
    const activeRole = input.activeRole ?? current.activeRole
    if (activeRole !== null && !roles.includes(activeRole)) {
      throw new Error(`Active role "${activeRole}" is not one of the user's roles`)
    }

    if (added.length > 0 || activeRole !== current.activeRole) {
      await tx.update(users).set({ roles, activeRole }).where(eq(users.id, input.userId))
    }
    await trackMany(
      added.map((role) => ({
        type: "user.role_added" as const,
        actorUserId: input.actorUserId,
        subjectType: "user" as const,
        subjectId: input.userId,
        properties: { role, source: input.source },
      })),
      tx,
    )
    return { roles, added, activeRole }
  }, database)
}

/**
 * Set `active_role` to one of the user's app roles. Returns false when the user lacks the role
 * (the update matches no row), so callers can show a plain-language error.
 */
export async function setActiveRole(
  database: DbOrTx,
  input: { userId: string; role: AppRole },
): Promise<boolean> {
  const updated = await database
    .update(users)
    .set({ activeRole: input.role })
    .where(and(eq(users.id, input.userId), sql`${input.role} = ANY(${users.roles})`))
    .returning({ id: users.id })
  return updated.length > 0
}

export type GrantAdminInput = {
  userId: string
  source: Extract<RoleSource, "admin_emails" | "admin_cli">
  /**
   * The admin performing the grant. Bootstrap grants (ADMIN_EMAILS, `pnpm admin:grant`) have no
   * acting admin, so the audit row names the user themselves; `after.source` says how.
   */
  grantedByUserId?: string
}

/** Give a user the admin role; audited. Returns false when they already had it (no-op). */
export async function grantAdminRole(database: DbOrTx, input: GrantAdminInput): Promise<boolean> {
  return withTransaction(async (tx) => {
    const before = await tx
      .select({ roles: users.roles })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update")
    const previousRoles = before[0]?.roles
    if (!previousRoles) throw new UserNotFoundError()
    if (previousRoles.includes("admin")) return false

    const change = await addUserRoles(tx, {
      userId: input.userId,
      roles: ["admin"],
      source: input.source,
      actorUserId: input.grantedByUserId ?? null,
    })
    await tx.insert(adminAuditLog).values({
      adminUserId: input.grantedByUserId ?? input.userId,
      action: "user.role_granted",
      targetType: "user",
      targetId: input.userId,
      before: { roles: previousRoles },
      after: { roles: change.roles, role: "admin", source: input.source },
    })
    return true
  }, database)
}
