import "server-only"

import { and, eq } from "drizzle-orm"
import type { ReactElement } from "react"
import { z } from "zod"

import { getDb, type DbOrTx } from "@/lib/db/client"
import { notificationPrefs, notifications, users } from "@/lib/db/schema"
import { sendEmail } from "@/lib/email/send"
import { reportError } from "@/lib/observability"

import type { NotificationPayloadOf, NotificationType } from "./types"

export * from "./types"

/**
 * Notify a user (§5 notifications, §7.4): an in-app notification plus an email, each unless the
 * user switched that channel off for this type in `notification_prefs` (default: both on).
 *
 * - The in-app row is written with `database` (pass the transaction of the state change so they
 *   commit together).
 * - The email is sent right away and its failure never fails the caller: it is reported to Sentry
 *   and `emailed` comes back false. If the caller's transaction later rolls back, the email has
 *   still gone out, so notify after the change is certain (e.g. at the end of the transaction).
 * - `dedupeKey` makes retries safe: at most one notification per user and key (the second call
 *   writes and sends nothing). It also keys the email's idempotency at Resend.
 */

export type NotifyInput<T extends NotificationType> = {
  userId: string
  type: T
  payload: NotificationPayloadOf<T>
  /** Omit for in-app only. `react` is usually `NotificationEmail` (lib/email/templates). */
  email?: { subject: string; react: ReactElement }
  dedupeKey?: string
}

export type NotifyResult = {
  /** The in-app notification's id; null when in-app is off for this type, or a duplicate. */
  notificationId: string | null
  emailed: boolean
  /** True when `dedupeKey` was seen before: nothing was written or sent. */
  duplicate: boolean
}

const payloadSchema = z.record(z.string(), z.json())

export async function notify<T extends NotificationType>(
  input: NotifyInput<T>,
  database: DbOrTx = getDb(),
): Promise<NotifyResult> {
  const payload = payloadSchema.parse(input.payload)

  const [recipient] = await database
    .select({
      email: users.email,
      emailPref: notificationPrefs.email,
      inAppPref: notificationPrefs.inApp,
    })
    .from(users)
    .leftJoin(
      notificationPrefs,
      and(eq(notificationPrefs.userId, users.id), eq(notificationPrefs.type, input.type)),
    )
    .where(eq(users.id, input.userId))
    .limit(1)
  if (!recipient) throw new Error(`notify: user ${input.userId} not found`)

  // No prefs row for this type means the defaults: both channels on.
  const inApp = recipient.inAppPref ?? true
  const emailOn = recipient.emailPref ?? true

  let notificationId: string | null = null
  if (inApp) {
    const inserted = await database
      .insert(notifications)
      .values({
        userId: input.userId,
        type: input.type,
        payload,
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
      .returning({ id: notifications.id })
    if (inserted.length === 0) return { notificationId: null, emailed: false, duplicate: true }
    notificationId = inserted[0]?.id ?? null
  }

  let emailed = false
  if (input.email && emailOn && recipient.email) {
    try {
      await sendEmail({
        to: recipient.email,
        subject: input.email.subject,
        react: input.email.react,
        tags: { notification: input.type },
        idempotencyKey: input.dedupeKey
          ? `notification:${input.userId}:${input.dedupeKey}`
          : notificationId
            ? `notification:${notificationId}`
            : undefined,
      })
      emailed = true
    } catch (error) {
      reportError(error, { tags: { notification: input.type, channel: "email" } })
    }
  }

  return { notificationId, emailed, duplicate: false }
}
