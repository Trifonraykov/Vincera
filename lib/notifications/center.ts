import "server-only"

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm"

import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import { notifications } from "@/lib/db/schema"

import { notificationHref, parseNotification, type ParsedNotification } from "./types"

/**
 * The notifications center (`/app/notifications`, the shell's bell; CLAUDE.md §19.24): the user's
 * in-app rows (`in_app = true`; hidden rows only record an email delivery, §19.11), newest first.
 * Rows whose type or payload no longer parses are skipped, never shown broken.
 */

export type NotificationItem = ParsedNotification & {
  id: string
  href: string
  readAt: Date | null
  createdAt: Date
}

export const NOTIFICATION_PAGE_SIZE = 50

const visibleTo = (userId: string) =>
  and(eq(notifications.userId, userId), eq(notifications.inApp, true))

export async function listNotifications(
  database: DbOrTx,
  userId: string,
  options: { before?: { createdAt: Date; id: string }; limit?: number } = {},
): Promise<{ items: NotificationItem[]; hasMore: boolean }> {
  const limit = options.limit ?? NOTIFICATION_PAGE_SIZE
  const before = options.before
  const rows = await database
    .select({
      id: notifications.id,
      type: notifications.type,
      payload: notifications.payload,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(
      and(
        visibleTo(userId),
        before
          ? or(
              lt(notifications.createdAt, before.createdAt),
              and(eq(notifications.createdAt, before.createdAt), lt(notifications.id, before.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1)
  const items = rows.slice(0, limit).flatMap((row) => {
    const parsed = parseNotification(row.type, row.payload)
    const href = notificationHref(row.type, row.payload)
    if (!parsed || !href) return []
    return [{ ...parsed, id: row.id, href, readAt: row.readAt, createdAt: row.createdAt }]
  })
  return { items, hasMore: rows.length > limit }
}

/** The bell's count: unread in-app notifications (partial index `notifications_user_unread_idx`). */
export async function countUnreadNotifications(database: DbOrTx, userId: string): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(visibleTo(userId), isNull(notifications.readAt)))
  return row?.count ?? 0
}

/**
 * Mark one of the user's notifications read; returns where it leads, or null when it is not theirs
 * (or no longer parses). Reading it twice keeps the first time.
 */
export async function markNotificationRead(
  database: DbOrTx,
  userId: string,
  notificationId: string,
): Promise<string | null> {
  const [row] = await database
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, ${now().toISOString()}::timestamptz)` })
    .where(and(eq(notifications.id, notificationId), visibleTo(userId)))
    .returning({ type: notifications.type, payload: notifications.payload })
  return row ? notificationHref(row.type, row.payload) : null
}

/** "Mark all as read": every unread in-app notification of the user; returns how many. */
export async function markAllNotificationsRead(database: DbOrTx, userId: string): Promise<number> {
  const updated = await database
    .update(notifications)
    .set({ readAt: now() })
    .where(and(visibleTo(userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id })
  return updated.length
}
