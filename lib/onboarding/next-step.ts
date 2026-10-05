import type { AuthUser } from "@/lib/auth/user"
import { appRolesOf } from "@/lib/auth/user"

/**
 * Onboarding routing (§6, §12): where a signed-in user who opens `/app` must go first.
 * Pure, so the proxy, the app layout and tests share it.
 */

export const ONBOARDING_STEPS = {
  role: "/onboarding/role",
} as const

export type OnboardingUser = Pick<AuthUser, "roles" | "onboardingCompletedAt">

/**
 * The next onboarding page for `user`, or null when `/app` may be shown.
 *
 * Phase 0: having at least one app role (creator or builder) is enough to enter `/app`.
 * TODO(Phase 1): continue with `/onboarding/creator/{profile,connect,review}` or
 * `/onboarding/builder/{profile,portfolio}`, then `/onboarding/payouts`, until
 * `onboarding_completed_at` is set.
 */
export function nextOnboardingStep(user: OnboardingUser): string | null {
  if (appRolesOf(user).length === 0) return ONBOARDING_STEPS.role
  return null
}
