import { z } from "zod"

import type { UserRole as DbUserRole, UserStatus as DbUserStatus } from "@/lib/db/schema"
import type { AppRole } from "@/lib/nav"

/**
 * The signed-in user as authorization code sees it (§6). Client-safe: no server imports.
 *
 * Auth.js keeps only the user id in the database session (`sessions.user_id`). Roles, active role
 * and status come from the `users` row that the session lookup joins on every request, so a role
 * change or suspension applies to the very next request.
 */

export const USER_ROLES = ["creator", "builder", "admin"] as const
export type UserRole = (typeof USER_ROLES)[number]

export const USER_STATUSES = ["active", "suspended"] as const
export type UserStatus = (typeof USER_STATUSES)[number]

// Compile-time checks that these client-safe lists match the database enums.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _rolesMatchDb: Same<UserRole, DbUserRole> = true
const _statusesMatchDb: Same<UserStatus, DbUserStatus> = true

export type AuthUser = {
  id: string
  email: string
  name: string | null
  image: string | null
  roles: readonly UserRole[]
  activeRole: UserRole | null
  status: UserStatus
  onboardingCompletedAt: Date | null
}

const nullableText = z
  .string()
  .nullish()
  .transform((value) => (value?.trim() ? value : null))

/**
 * Parses the user fields of a session: the joined `users` row inside the Auth.js session callback
 * (Dates) and the JSON payload `auth()` returns (ISO strings). Anything else fails, and callers
 * treat a failed parse as "signed out".
 */
export const authUserSchema = z.object({
  id: z.uuid(),
  email: z.string().min(1),
  name: nullableText,
  image: nullableText,
  roles: z.array(z.enum(USER_ROLES)),
  activeRole: z.enum(USER_ROLES).nullable(),
  status: z.enum(USER_STATUSES),
  onboardingCompletedAt: z.coerce.date().nullable(),
})

/** Parse session user data; null when it is missing or malformed (fail closed). */
export function parseAuthUser(value: unknown): AuthUser | null {
  const parsed = authUserSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** JSON-safe form of `AuthUser`, as stored in the session payload. */
export function toSessionUser(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    roles: [...user.roles],
    activeRole: user.activeRole,
    status: user.status,
    onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
  }
}

export function isAppRole(role: string): role is AppRole {
  return role === "creator" || role === "builder"
}

/** The user's app roles (creator/builder), in canonical order; `admin` is not an app role. */
export function appRolesOf(user: Pick<AuthUser, "roles">): AppRole[] {
  return (["creator", "builder"] as const).filter((role) => user.roles.includes(role))
}

/** Canonical order for `users.roles`, so arrays compare and display consistently. */
export function sortRoles(roles: Iterable<UserRole>): UserRole[] {
  const set = new Set(roles)
  return USER_ROLES.filter((role) => set.has(role))
}
