"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { defineAction } from "@/lib/actions/define-action"
import { signOut } from "@/lib/auth/auth"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { signInUrl } from "@/lib/auth/routes"
import { accountNameFormSchema } from "@/lib/profiles/fields"

import { deleteAllSessions, updateAccountName } from "./account"

/** Settings → Account (§12): rename the account; sign out on every device. */

export const updateAccountNameAction = defineAction({
  name: "account.update_name",
  input: accountNameFormSchema,
  // Changes only the signed-in user's own row.
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }) => {
    await updateAccountName(db, { userId: user.id, name: input.name })
    revalidatePath("/app", "layout")
    return { name: input.name }
  },
})

/**
 * Delete every session of the user (all devices, this one included), then clear this browser's
 * cookie and go to the sign-in page.
 */
export const signOutEverywhereAction = defineAction({
  name: "account.sign_out_everywhere",
  input: z.object({}),
  // Deletes only the signed-in user's own sessions.
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ user, db }) => {
    await deleteAllSessions(db, user.id)
    await signOut({ redirectTo: signInUrl({}) })
  },
})
