"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canSwitchToRole } from "@/lib/auth/authz"
import { APP_ROLES } from "@/lib/nav"

import { setActiveRole } from "./roles"

/** Role switcher in the app sidebar (§12): act as another of your roles. */
export const switchActiveRole = defineAction({
  name: "users.switch_active_role",
  input: z.object({ role: z.enum(APP_ROLES) }),
  authorize: (user, { role }) => canSwitchToRole(user, role),
  run: async ({ input, user, db }) => {
    const updated = await setActiveRole(db, { userId: user.id, role: input.role })
    if (!updated)
      throw new ActionError("You don't have that role yet. Add it from onboarding first.")
    revalidatePath("/app", "layout")
    return { activeRole: input.role }
  },
})
