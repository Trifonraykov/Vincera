"use server"

import { redirect } from "next/navigation"
import { z } from "zod"

import { defineAction } from "@/lib/actions/define-action"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { appRolesOf } from "@/lib/auth/user"
import { withTransaction } from "@/lib/db/client"
import type { AppRole } from "@/lib/nav"
import { addUserRoles } from "@/lib/users/roles"

import {
  advanceOnboarding,
  completeOnboardingStep,
  requestMatchingAfterOnboarding,
} from "./complete-step"
import { ROLE_CHOICES, rolesForChoice } from "./role-choices"
import { SKIPPABLE_ONBOARDING_STEPS } from "./steps"

/**
 * /onboarding/role: become a creator, a builder or both. Adds the roles (never removes any),
 * sets the active role, emits `user.role_added` per new role, then continues with the next
 * onboarding step (for a user who finished onboarding earlier: the new role's steps, or `/app`).
 */
export const chooseRoles = defineAction({
  name: "onboarding.choose_roles",
  input: z.object({
    choice: z.enum(ROLE_CHOICES, { error: "Choose how you want to use the platform." }),
  }),
  // Adds app roles to the user's own account; `admin` is never among the choices.
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }) => {
    const roles = rolesForChoice(input.choice)
    // A single choice becomes the active role; "both" keeps the current one (or starts as creator).
    const current = appRolesOf(user).find((role) => role === user.activeRole)
    const activeRole: AppRole = input.choice === "both" ? (current ?? "creator") : input.choice

    const advance = await withTransaction(async (tx) => {
      await addUserRoles(tx, {
        userId: user.id,
        roles,
        source: "onboarding",
        actorUserId: user.id,
        activeRole,
      })
      return advanceOnboarding(tx, user.id)
    }, db)
    await requestMatchingAfterOnboarding(user.id, advance)
    redirect(advance.nextStep ?? "/app")
  },
})

/**
 * "Do this later" on a skippable onboarding step (connect, portfolio, payouts): records the skip
 * (`onboarding.step_completed`, status `skipped`) and continues with the next step, or `/app`
 * when that finished onboarding.
 */
export const skipOnboardingStep = defineAction({
  name: "onboarding.skip_step",
  input: z.object({
    step: z.enum(SKIPPABLE_ONBOARDING_STEPS, { error: "This step can't be skipped." }),
  }),
  // Records a step on the user's own account.
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }) => {
    const { nextStep } = await completeOnboardingStep(db, {
      userId: user.id,
      step: input.step,
      status: "skipped",
    })
    redirect(nextStep ?? "/app")
  },
})
