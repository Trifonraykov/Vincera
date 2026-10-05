"use server"

import { redirect } from "next/navigation"
import { z } from "zod"

import { defineAction } from "@/lib/actions/define-action"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { appRolesOf } from "@/lib/auth/user"
import type { AppRole } from "@/lib/nav"
import { addUserRoles } from "@/lib/users/roles"

import { nextOnboardingStep } from "./next-step"
import { ROLE_CHOICES, rolesForChoice } from "./role-choices"

/**
 * /onboarding/role: become a creator, a builder or both. Adds the roles (never removes any),
 * sets the active role, emits `user.role_added` per new role, then continues onboarding.
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

    const change = await addUserRoles(db, {
      userId: user.id,
      roles,
      source: "onboarding",
      actorUserId: user.id,
      activeRole,
    })
    redirect(nextOnboardingStep({ ...user, roles: change.roles }) ?? "/app")
  },
})
