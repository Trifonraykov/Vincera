import { appRolesOf, type AuthUser, type UserRole } from "@/lib/auth/user"
import type { PayoutsState } from "@/lib/payouts/readiness"

import {
  ONBOARDING_STEP_LABELS,
  ONBOARDING_STEP_PATHS,
  type OnboardingStepId,
  type OnboardingStepsRecord,
} from "./steps"

/**
 * Onboarding routing (§6, §12, §16 Phase 1): the single source of truth for which onboarding step
 * a user is on. Pure and client-safe, so the proxy, layouts, pages, actions and tests share it.
 * `./snapshot.ts` loads the input from the database; `./complete-step.ts` records steps.
 *
 * Path: `role` → creator steps (profile → connect → review) if the user is a creator → builder
 * steps (profile → portfolio) if a builder (creators first when both) → `payouts` → done.
 *
 * When a step counts as complete:
 * - `role`: the user has an app role (creator or builder).
 * - `creator.profile` / `builder.profile`: the profile exists (the facts, not a record).
 * - `creator.connect`: recorded done/skipped, or the user has a creator data connection
 *   (YouTube, Instagram or TikTok; OAuth or manual entry).
 * - `creator.review`: recorded done (the creator confirmed the audience summary).
 * - `builder.portfolio`: recorded done/skipped, or a portfolio item or a GitHub connection exists.
 * - `payouts`: recorded done/skipped, or payouts are ready (§19.10). Skipping is allowed, but
 *   payouts readiness is still required later to sign an agreement (§12).
 */

/** Everything the step logic needs about one user. Build it with `loadOnboardingSnapshot()`. */
export type OnboardingSnapshot = {
  roles: readonly UserRole[]
  onboardingCompletedAt: Date | null
  /** `users.onboarding_steps`, parsed. */
  steps: OnboardingStepsRecord
  hasCreatorProfile: boolean
  hasBuilderProfile: boolean
  /** Creator data connections (YouTube/Instagram/TikTok, OAuth or manual) that are not revoked. */
  creatorConnectionCount: number
  /** GitHub data connections that are not revoked (0 or 1). */
  githubConnectionCount: number
  portfolioItemCount: number
  payouts: PayoutsState
}

/** `done` / `skipped` once complete (facts or a record), else `pending`. */
export type OnboardingStepState = "done" | "skipped" | "pending"

const CREATOR_STEPS = [
  "creator.profile",
  "creator.connect",
  "creator.review",
] as const satisfies readonly OnboardingStepId[]
const BUILDER_STEPS = [
  "builder.profile",
  "builder.portfolio",
] as const satisfies readonly OnboardingStepId[]

/**
 * The user's onboarding path in order. Without an app role it is just `role`: the rest depends on
 * the role they choose.
 */
export function onboardingPath(user: Pick<OnboardingSnapshot, "roles">): OnboardingStepId[] {
  const roles = appRolesOf(user)
  if (roles.length === 0) return ["role"]
  return [
    "role",
    ...(roles.includes("creator") ? CREATOR_STEPS : []),
    ...(roles.includes("builder") ? BUILDER_STEPS : []),
    "payouts",
  ]
}

/** `done` from the facts or a done record, else `skipped` from a skip record, else `pending`. */
function stateFrom(
  snapshot: OnboardingSnapshot,
  step: OnboardingStepId,
  factDone: boolean,
): OnboardingStepState {
  if (factDone) return "done"
  const recorded = snapshot.steps[step]?.status
  return recorded ?? "pending"
}

/** Whether `step` is complete for this user, and how. */
export function onboardingStepState(
  snapshot: OnboardingSnapshot,
  step: OnboardingStepId,
): OnboardingStepState {
  switch (step) {
    case "role":
      return appRolesOf(snapshot).length > 0 ? "done" : "pending"
    case "creator.profile":
      return snapshot.hasCreatorProfile ? "done" : "pending"
    case "builder.profile":
      return snapshot.hasBuilderProfile ? "done" : "pending"
    case "creator.connect":
      return stateFrom(snapshot, step, snapshot.creatorConnectionCount > 0)
    case "creator.review":
      // Not skippable: only an explicit confirmation completes it.
      return snapshot.steps[step]?.status === "done" ? "done" : "pending"
    case "builder.portfolio":
      return stateFrom(
        snapshot,
        step,
        snapshot.portfolioItemCount > 0 || snapshot.githubConnectionCount > 0,
      )
    case "payouts":
      return stateFrom(snapshot, step, snapshot.payouts === "ready")
  }
}

export function isOnboardingStepComplete(
  snapshot: OnboardingSnapshot,
  step: OnboardingStepId,
): boolean {
  return onboardingStepState(snapshot, step) !== "pending"
}

/** The first incomplete step of the user's path, or null when the whole path is complete. */
export function nextOnboardingStepId(snapshot: OnboardingSnapshot): OnboardingStepId | null {
  return onboardingPath(snapshot).find((step) => !isOnboardingStepComplete(snapshot, step)) ?? null
}

/**
 * The page of the next incomplete step, or null when the path is complete. This is navigation
 * ("Continue"), so it ignores `onboarding_completed_at`: a user who adds a role after finishing
 * onboarding is walked through that role's steps. Gates use `onboardingGate()`.
 */
export function nextOnboardingStep(snapshot: OnboardingSnapshot): string | null {
  const step = nextOnboardingStepId(snapshot)
  return step === null ? null : ONBOARDING_STEP_PATHS[step]
}

/** True when every step of the path is complete and the user has an app role. */
export function isOnboardingPathComplete(snapshot: OnboardingSnapshot): boolean {
  return appRolesOf(snapshot).length > 0 && nextOnboardingStepId(snapshot) === null
}

/**
 * Where `/app` must send this user first (§6), or null to let them in. Users without an app role
 * go to `/onboarding/role`. Once `onboarding_completed_at` is set they are never sent back:
 * a role added later is offered through the role page's redirect, and role pages handle a
 * missing profile themselves (CLAUDE.md §19.11).
 */
export function onboardingGate(snapshot: OnboardingSnapshot): string | null {
  const decided = sessionOnboardingGate(snapshot)
  return decided.decided ? decided.step : nextOnboardingStep(snapshot)
}

export type SessionOnboardingGate = { decided: true; step: string | null } | { decided: false }

/**
 * The part of `onboardingGate()` that needs only the session user (no database): no app role →
 * the role step; onboarding finished → let in; otherwise the snapshot decides.
 */
export function sessionOnboardingGate(
  user: Pick<AuthUser, "roles" | "onboardingCompletedAt">,
): SessionOnboardingGate {
  if (appRolesOf(user).length === 0) return { decided: true, step: ONBOARDING_STEP_PATHS.role }
  if (user.onboardingCompletedAt !== null) return { decided: true, step: null }
  return { decided: false }
}

export type OnboardingStepAccess = { allowed: true } | { allowed: false; redirectTo: string }

/**
 * Whether the user may open the page of `step` now (pages call this; see
 * `requireOnboardingStep()` in `./page.ts`). The role page is always open. Other steps must be on
 * the user's path, and either complete already (going back to change something) or the next
 * incomplete one; jumping ahead redirects to the step that comes first.
 */
export function onboardingStepAccess(
  snapshot: OnboardingSnapshot,
  step: OnboardingStepId,
): OnboardingStepAccess {
  if (step === "role") return { allowed: true }
  const fallback = nextOnboardingStep(snapshot) ?? "/app"
  if (!onboardingPath(snapshot).includes(step)) return { allowed: false, redirectTo: fallback }
  if (isOnboardingStepComplete(snapshot, step) || nextOnboardingStepId(snapshot) === step) {
    return { allowed: true }
  }
  return { allowed: false, redirectTo: fallback }
}

export type OnboardingProgressStep = {
  id: OnboardingStepId
  label: string
  href: string
  state: OnboardingStepState
  current: boolean
}

export type OnboardingProgress = {
  steps: OnboardingProgressStep[]
  /** 0-based position of `current` on the path; -1 when it is not on it. */
  currentIndex: number
  total: number
  /** The step before `current` ("Back"), or null on the first step. */
  previousHref: string | null
  /** The step after `current` on the path, or null on the last step ("Finish" goes to /app). */
  nextHref: string | null
}

/** Data for the progress indicator and back/forward links of an onboarding page. */
export function onboardingProgress(
  snapshot: OnboardingSnapshot,
  current: OnboardingStepId,
): OnboardingProgress {
  const path = onboardingPath(snapshot)
  const currentIndex = path.indexOf(current)
  const hrefAt = (index: number) => {
    const step = path[index]
    return step === undefined ? null : ONBOARDING_STEP_PATHS[step]
  }
  return {
    steps: path.map((id) => ({
      id,
      label: ONBOARDING_STEP_LABELS[id],
      href: ONBOARDING_STEP_PATHS[id],
      state: onboardingStepState(snapshot, id),
      current: id === current,
    })),
    currentIndex,
    total: path.length,
    previousHref: currentIndex > 0 ? hrefAt(currentIndex - 1) : null,
    nextHref: currentIndex >= 0 ? hrefAt(currentIndex + 1) : null,
  }
}

/** Steps on the path that the user put off with "Do this later" (for `onboarding.completed`). */
export function skippedOnboardingSteps(snapshot: OnboardingSnapshot): OnboardingStepId[] {
  return onboardingPath(snapshot).filter(
    (step) => onboardingStepState(snapshot, step) === "skipped",
  )
}
