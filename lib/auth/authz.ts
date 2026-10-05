import type { AppRole } from "@/lib/nav"

import type { AuthUser, UserRole } from "./user"

/**
 * Authorization rules (§6): pure functions over plain objects, so pages, server actions, the
 * proxy and tests share one definition. Every page loader and server action calls one of these.
 *
 * They never load data. Callers pass what the rule needs (for collab rules: the member ids),
 * typically selected in the same query that loads the record.
 */

/** The user fields authorization depends on. `AuthUser` satisfies it. */
export type AuthzUser = Pick<AuthUser, "id" | "roles" | "status" | "onboardingCompletedAt">

/** Suspended users may not act at all; every rule below starts from this. */
export function isActive(user: Pick<AuthzUser, "status">): boolean {
  return user.status === "active"
}

export function hasRole(user: Pick<AuthzUser, "roles">, role: UserRole): boolean {
  return user.roles.includes(role)
}

export function isAdmin(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isActive(user) && hasRole(user, "admin")
}

/** `/admin/*` (§6): active users with the `admin` role. */
export function canAccessAdmin(user: Pick<AuthzUser, "roles" | "status">): boolean {
  return isAdmin(user)
}

/**
 * Self-service on the user's own account (choosing roles, own settings): any active user. Use it
 * only for actions that read or change nothing but the signed-in user's own rows; anything that
 * touches another user's data needs a rule about that data.
 */
export function canManageOwnAccount(user: Pick<AuthzUser, "status">): boolean {
  return isActive(user)
}

/** The role switcher (§12) may only pick an app role the user already has. */
export function canSwitchToRole(
  user: Pick<AuthzUser, "roles" | "status">,
  role: string,
): role is AppRole {
  return isActive(user) && (role === "creator" || role === "builder") && hasRole(user, role)
}

/** Whether the user finished onboarding (Phase 1 sets `onboarding_completed_at` on the last step). */
export function hasCompletedOnboarding(user: Pick<AuthzUser, "onboardingCompletedAt">): boolean {
  return user.onboardingCompletedAt !== null
}

// --- Collaboration (Phases 3–4) ---------------------------------------------------------------

/** What collab rules need: the ids of the collab's members (`collab_members.user_id`). */
export type CollabAccess = { memberUserIds: readonly string[] }

export function isCollabMember(user: Pick<AuthzUser, "id">, collab: CollabAccess): boolean {
  return collab.memberUserIds.includes(user.id)
}

/**
 * §6: collab data is visible only to its members and admins (admins read-only; their actions
 * go through admin routes and the audit log).
 */
export function canViewCollab(user: AuthzUser, collab: CollabAccess): boolean {
  return isActive(user) && (isCollabMember(user, collab) || isAdmin(user))
}

/** Launch statuses in which members may still edit the launch setup page. */
export const EDITABLE_LAUNCH_STATUSES = ["draft", "pending_approval"] as const

export type LaunchAccess = CollabAccess & { status: string }

/**
 * §12: either member edits the launch while it is being set up; saving resets approvals.
 * TODO(Phase 4): confirm whether members may edit a launch in `admin_review`, `live` or `paused`
 * (it would need re-approval); until then only setup statuses are editable.
 */
export function canEditLaunch(user: AuthzUser, launch: LaunchAccess): boolean {
  return (
    isActive(user) &&
    isCollabMember(user, launch) &&
    (EDITABLE_LAUNCH_STATUSES as readonly string[]).includes(launch.status)
  )
}

/**
 * The thing a proposal is about (§12 `/app/proposals/new?to=…&idea=…|&product=…`): a creator's
 * idea is pitched to by builders, a builder's product by creators.
 */
export type ProposalTarget = {
  kind: "idea" | "product"
  ownerUserId: string
  ownerStatus: AuthUser["status"]
}

/**
 * §12: proposals are blocked until the sender has completed onboarding. The sender needs the
 * counterpart role (builders pitch on ideas, creators on products), cannot propose to
 * themselves, and the owner must not be suspended.
 * TODO(Phase 3): also require the target to be open (idea `open` / product `seeking`) and apply
 * the proposal rate limit (§14) in the server action.
 */
export function canSendProposal(user: AuthzUser, target: ProposalTarget): boolean {
  const requiredRole: AppRole = target.kind === "idea" ? "builder" : "creator"
  return (
    isActive(user) &&
    hasCompletedOnboarding(user) &&
    hasRole(user, requiredRole) &&
    target.ownerUserId !== user.id &&
    target.ownerStatus === "active"
  )
}
