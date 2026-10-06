"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { defineAction } from "@/lib/actions/define-action"
import { canManageOwnAccount } from "@/lib/auth/authz"

import { markAllNotificationsRead, markNotificationRead } from "./center"
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

/**
 * Open a notification from `/app/notifications`: mark it read and go where it leads. Only the
 * user's own notifications (the update is scoped to them); anything else lands back on the list.
 */
export const openNotificationAction = defineAction({
  name: "notifications.open",
  input: z.object({ id: z.uuid({ error: "That notification link is not valid." }) }),
  // Reads and changes only the signed-in user's own notifications.
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }) => {
    const href = await markNotificationRead(db, user.id, input.id)
    revalidatePath("/app", "layout")
    redirect(href ?? "/app/notifications")
  },
})

/**
 * `openNotificationAction` as a plain form action (`<form action>` wants `Promise<void>`). On
 * success it redirects; a refused open has nothing to show, so the list just re-renders.
 */
export async function openNotificationFormAction(formData: FormData): Promise<void> {
  await openNotificationAction(formData)
}

/** "Mark all as read" on `/app/notifications`. */
export const markAllNotificationsReadAction = defineAction({
  name: "notifications.mark_all_read",
  input: z.object({}),
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ user, db }) => {
    const marked = await markAllNotificationsRead(db, user.id)
    revalidatePath("/app", "layout")
    return { marked }
  },
})
