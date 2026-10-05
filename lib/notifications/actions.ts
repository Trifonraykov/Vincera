"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { defineAction } from "@/lib/actions/define-action"
import { canManageOwnAccount } from "@/lib/auth/authz"

import { saveNotificationPrefs } from "./prefs"
import { NOTIFICATION_TYPES } from "./types"

/** Ticked checkboxes arrive as one value, several, or none. */
const typeList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))
  .pipe(z.array(z.enum(NOTIFICATION_TYPES, { error: "Unknown notification type." })))

/** Settings → Notifications: email and in-app switches per notification type. */
export const updateNotificationPrefsAction = defineAction({
  name: "notifications.update_prefs",
  input: z.object({ email: typeList, inApp: typeList }),
  // Changes only the signed-in user's own preferences.
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }) => {
    const email = new Set(input.email)
    const inApp = new Set(input.inApp)
    await saveNotificationPrefs(
      db,
      user.id,
      NOTIFICATION_TYPES.map((type) => ({ type, email: email.has(type), inApp: inApp.has(type) })),
    )
    revalidatePath("/app/settings/notifications")
    return { saved: true as const }
  },
})
