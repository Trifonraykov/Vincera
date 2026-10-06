import "server-only"

import { isMutationBlockedByImpersonation } from "@/lib/auth/impersonation"
import type { AuthUser } from "@/lib/auth/user"
import { getDb, type DbOrTx } from "@/lib/db/client"

import { advanceOnboarding } from "./complete-step"
import { nextOnboardingStep, sessionOnboardingGate } from "./next-step"
import { loadOnboardingSnapshot } from "./snapshot"

/**
 * The `/app` onboarding gate (§6) for the proxy and `requireOnboardedUser()`: where the user must
 * go first, or null to let them in. No database access for users without an app role or with
 * onboarding finished (the session user says enough); otherwise one snapshot query.
 *
 * When the snapshot shows the path complete but `onboarding_completed_at` is still null (a step
 * completed by facts alone, e.g. Stripe enabling payouts after the user left the payouts page),
 * this finishes onboarding (sets the column once, emits `onboarding.completed`) and lets them in.
 *
 * During an admin's read-only "view as" of this user (CLAUDE.md §19.38) nothing is written: the
 * next step is computed from the snapshot only.
 */
export async function resolveOnboardingRedirect(
  user: AuthUser,
  database: DbOrTx = getDb(),
): Promise<string | null> {
  const gate = sessionOnboardingGate(user)
  if (gate.decided) return gate.step
  if (await isMutationBlockedByImpersonation(user)) {
    const snapshot = await loadOnboardingSnapshot(database, user.id)
    return snapshot ? nextOnboardingStep(snapshot) : null
  }
  const { nextStep } = await advanceOnboarding(database, user.id)
  return nextStep
}
