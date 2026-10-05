import { isActive, isAdmin, type AuthzUser } from "@/lib/auth/authz"

import { canConnectProvider } from "./catalog"
import type { SocialProviderId } from "./types"

/**
 * Authorization rules for social data connections (§6, §7.1). Pure and client-safe, like
 * lib/auth/authz.ts (whose `isActive` / `isAdmin` they build on); kept next to the social code
 * so the connection flow owns its rules (CLAUDE.md §19.14).
 */

/** Start or finish an OAuth connection, or enter numbers manually, for `provider`. */
export function canConnectSocial(
  user: Pick<AuthzUser, "roles" | "status">,
  provider: SocialProviderId,
): boolean {
  return isActive(user) && canConnectProvider(user.roles, provider)
}

/** What connection rules need: the owner of the `social_connections` row. */
export type SocialConnectionAccess = { userId: string }

/** Resync, disconnect or re-enter one of the user's own connections. */
export function canManageSocialConnection(
  user: Pick<AuthzUser, "id" | "status">,
  connection: SocialConnectionAccess,
): boolean {
  return isActive(user) && connection.userId === user.id
}

/** Verify a manual (self-reported) connection after checking its screenshot (§7.1 fallback). */
export function canVerifySocialConnection(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isAdmin(user)
}

/** `/app/audience` and the audience summary: the creator's own data. */
export function canViewOwnAudience(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isActive(user) && user.roles.includes("creator")
}
