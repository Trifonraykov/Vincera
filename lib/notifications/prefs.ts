import "server-only"

import { eq, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { notificationPrefs } from "@/lib/db/schema"

import { NOTIFICATION_TYPES, isNotificationType, type NotificationType } from "./types"

/**
 * Per-type notification switches (§5 `notification_prefs`; read by `notify()`). A type without a
 * row has both channels on.
 */

export type NotificationPref = { type: NotificationType; email: boolean; inApp: boolean }

export async function loadNotificationPrefs(
  database: DbOrTx,
  userId: string,
): Promise<NotificationPref[]> {
  const rows = await database
    .select({
      type: notificationPrefs.type,
      email: notificationPrefs.email,
      inApp: notificationPrefs.inApp,
    })
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId))
  const stored = new Map(
    rows.filter((row) => isNotificationType(row.type)).map((row) => [row.type, row]),
  )
  return NOTIFICATION_TYPES.map((type) => ({
    type,
    email: stored.get(type)?.email ?? true,
    inApp: stored.get(type)?.inApp ?? true,
  }))
}

/** Store every type's switches (an upsert per type). */
export async function saveNotificationPrefs(
  database: DbOrTx,
  userId: string,
  prefs: readonly NotificationPref[],
): Promise<void> {
  if (prefs.length === 0) return
  await database
    .insert(notificationPrefs)
    .values(
      prefs.map((pref) => ({ userId, type: pref.type, email: pref.email, inApp: pref.inApp })),
    )
    .onConflictDoUpdate({
      target: [notificationPrefs.userId, notificationPrefs.type],
      set: { email: sql`excluded.email`, inApp: sql`excluded.in_app` },
    })
}
