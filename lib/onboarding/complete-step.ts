import "server-only"

import { and, eq, isNull, sql } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { appRolesOf } from "@/lib/auth/user"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { users } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { UserNotFoundError } from "@/lib/users/roles"

import {
  nextOnboardingStep,
  onboardingPath,
  skippedOnboardingSteps,
  type OnboardingSnapshot,
} from "./next-step"
import { loadOnboardingSnapshot } from "./snapshot"
import {
  isSkippableOnboardingStep,
  parseOnboardingSteps,
  type OnboardingStepId,
  type OnboardingStepRecord,
  type OnboardingStepStatus,
} from "./steps"

/**
 * Recording onboarding steps and finishing onboarding (§16 Phase 1). Idempotent: recording a step
 * twice, or finishing twice, changes nothing the second time.
 */

/** A step that cannot be recorded as asked; the message is written for the user. */
export class OnboardingStepError extends ActionError {
  constructor(message: string) {
    super(message)
    this.name = "OnboardingStepError"
  }
}

export type OnboardingAdvance = {
  /** The page to continue to, or null when the path is complete ("/app"). */
  nextStep: string | null
  /** True when this call set `onboarding_completed_at` (and emitted `onboarding.completed`). */
  completedNow: boolean
}

export type CompleteStepInput = {
  userId: string
  step: OnboardingStepId
  status: OnboardingStepStatus
  /** Who caused it; defaults to the user. */
  actorUserId?: string
}

export type CompleteStepResult = OnboardingAdvance & {
  /** False when the step was already recorded with the same (or a stronger) status. */
  recorded: boolean
}

/**
 * Mark `step` done or skipped ("Do this later") for the user, emit `onboarding.step_completed`,
 * and return where to go next. When this completes the path, `onboarding_completed_at` is set
 * once and `onboarding.completed` emitted (see `advanceOnboarding`).
 *
 * A `done` record is never downgraded to `skipped`; a `skipped` one is upgraded to `done`.
 * Pass the caller's transaction when the step is recorded together with other writes (e.g. the
 * profile insert of a profile step).
 */
export async function completeOnboardingStep(
  database: DbOrTx,
  input: CompleteStepInput,
): Promise<CompleteStepResult> {
  if (input.status === "skipped" && !isSkippableOnboardingStep(input.step)) {
    throw new OnboardingStepError("This step can't be skipped.")
  }

  return withTransaction(async (tx) => {
    const [user] = await tx
      .select({ roles: users.roles, onboardingSteps: users.onboardingSteps })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update")
    if (!user) throw new UserNotFoundError()
    if (!onboardingPath(user).includes(input.step)) {
      throw new OnboardingStepError("This step isn't part of your onboarding.")
    }

    const previous = parseOnboardingSteps(user.onboardingSteps)[input.step]
    const recorded =
      previous === undefined || (previous.status === "skipped" && input.status === "done")
    if (recorded) {
      const entry: OnboardingStepRecord = { status: input.status, at: now().toISOString() }
      // Merge one key, leaving every other entry as stored.
      await tx
        .update(users)
        .set({
          onboardingSteps: sql`${users.onboardingSteps} || ${JSON.stringify({ [input.step]: entry })}::jsonb`,
        })
        .where(eq(users.id, input.userId))
      await track(
        "onboarding.step_completed",
        {
          actorUserId: input.actorUserId ?? input.userId,
          subjectType: "user",
          subjectId: input.userId,
          properties: { step: input.step, status: input.status },
        },
        tx,
      )
    }

    const advance = await advanceOnboarding(tx, input.userId, input.actorUserId)
    return { ...advance, recorded }
  }, database)
}

/**
 * Where the user continues (the next incomplete step, also for users who finished onboarding and
 * added a role since), finishing onboarding when the path is complete. Call it after anything
 * that may complete a step: recording a step, adding roles, payouts becoming ready. The `/app`
 * gate calls it too (`./gate.ts`), so a path completed by facts alone (e.g. Stripe enabling
 * payouts) finishes on the user's next visit.
 */
export async function advanceOnboarding(
  database: DbOrTx,
  userId: string,
  actorUserId?: string,
): Promise<OnboardingAdvance> {
  return withTransaction(async (tx) => {
    const snapshot = await loadOnboardingSnapshot(tx, userId)
    if (!snapshot) throw new UserNotFoundError()
    const nextStep = nextOnboardingStep(snapshot)
    const completedNow =
      nextStep === null ? await finishOnboarding(tx, userId, snapshot, actorUserId) : false
    return { nextStep, completedNow }
  }, database)
}

/**
 * Set `onboarding_completed_at` once and emit `onboarding.completed` (the path is complete).
 * Returns true only for the call that set it. Safe under concurrency: the conditional update
 * matches only while the column is still null.
 */
async function finishOnboarding(
  tx: DbOrTx,
  userId: string,
  snapshot: OnboardingSnapshot,
  actorUserId: string | undefined,
): Promise<boolean> {
  const roles = appRolesOf(snapshot)
  if (roles.length === 0 || snapshot.onboardingCompletedAt !== null) return false

  const updated = await tx
    .update(users)
    .set({ onboardingCompletedAt: now() })
    .where(and(eq(users.id, userId), isNull(users.onboardingCompletedAt)))
    .returning({ id: users.id })
  if (updated.length === 0) return false

  await track(
    "onboarding.completed",
    {
      actorUserId: actorUserId ?? userId,
      subjectType: "user",
      subjectId: userId,
      properties: { roles, skipped_steps: skippedOnboardingSteps(snapshot) },
    },
    tx,
  )
  return true
}
