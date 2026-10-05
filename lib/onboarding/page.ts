import "server-only"

import { redirect } from "next/navigation"

import { requireUser } from "@/lib/auth/session"
import type { AuthUser } from "@/lib/auth/user"
import { getDb } from "@/lib/db/client"

import {
  onboardingProgress,
  onboardingStepAccess,
  type OnboardingProgress,
  type OnboardingSnapshot,
} from "./next-step"
import { loadOnboardingSnapshot } from "./snapshot"
import { ONBOARDING_STEP_PATHS, type OnboardingStepId } from "./steps"

export type OnboardingPageContext = {
  user: AuthUser
  snapshot: OnboardingSnapshot
  /** Progress indicator data and back/forward links for this step. */
  progress: OnboardingProgress
}

/**
 * For onboarding pages (defence in depth, §19.9): the signed-in user, their onboarding snapshot
 * and progress. Redirects when the step is not on the user's path or comes after an incomplete
 * one (to the step they should do first, or `/app` when they are done).
 */
export async function requireOnboardingStep(
  step: OnboardingStepId,
): Promise<OnboardingPageContext> {
  const user = await requireUser()
  const snapshot = await loadOnboardingSnapshot(getDb(), user.id)
  if (!snapshot) redirect(ONBOARDING_STEP_PATHS.role)
  const access = onboardingStepAccess(snapshot, step)
  if (!access.allowed) redirect(access.redirectTo)
  return { user, snapshot, progress: onboardingProgress(snapshot, step) }
}
