import "server-only"

import { and, eq } from "drizzle-orm"
import type { ReactElement } from "react"
import { z } from "zod"

import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client"
import { notificationPrefs, notifications, users } from "@/lib/db/schema"
import { sendEmail, type EmailAttachment } from "@/lib/email/send"
import { reportError } from "@/lib/observability"

import {
  NOTIFICATION_PAYLOAD_SCHEMAS,
  type NotificationPayloadOf,
  type NotificationType,
} from "./types"

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
 *   writes and sends nothing). It also keys the email's idempotency at Resend. The key is claimed
 *   even when in-app is off for the type: a hidden row (`in_app = false`) records the delivery,
 *   so the email still goes out once, not on every call.
 * - `email.required` (a legal or transactional notice, e.g. the signed agreement PDF, §12): the
 *   email ignores the user's email preference, and a failed send throws instead of being
 *   swallowed. The dedupe claim and the in-app row are written in a savepoint that the failure
 *   rolls back, so a retry (a job step) can claim the key and send again; Resend's idempotency
 *   key keeps a send that did go through from going out twice.
 */

export type NotifyInput<T extends NotificationType> = {
  userId: string
  type: T
  payload: NotificationPayloadOf<T>
  /** Omit for in-app only. `react` is usually `NotificationEmail` (lib/email/templates). */
  /** `attachments`: e.g. the signed agreement PDF (§7.4). */
  email?: {
    subject: string
    react: ReactElement
    attachments?: readonly EmailAttachment[]
    /** Transactional: sent whatever the email preference, and a failed send throws. */
    required?: boolean
  }
  dedupeKey?: string
}

export type NotifyResult = {
  /** The in-app notification's id; null when in-app is off for this type, or a duplicate. */
  notificationId: string | null
  emailed: boolean
  /** True when `dedupeKey` was seen before: nothing was written or sent. */
  duplicate: boolean
}

const jsonObject = z.record(z.string(), z.json())

export async function notify<T extends NotificationType>(
  input: NotifyInput<T>,
  database: DbOrTx = getDb(),
): Promise<NotifyResult> {
  if (input.email?.required) {
    // A savepoint (or a transaction): the claim is undone when the required email fails.
    return withTransaction((tx) => deliver(input, tx), database)
  }
  return deliver(input, database)
}

async function deliver<T extends NotificationType>(
  input: NotifyInput<T>,
  database: DbOrTx,
): Promise<NotifyResult> {
  // The type's own schema first (so every stored row parses in the in-app list), then JSON.
  const payload = jsonObject.parse(NOTIFICATION_PAYLOAD_SCHEMAS[input.type].parse(input.payload))

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
  const emailOn = input.email?.required === true || (recipient.emailPref ?? true)

  let notificationId: string | null = null
  // In-app off and no key to claim: nothing to record.
  if (inApp || input.dedupeKey !== undefined) {
    const inserted = await database
      .insert(notifications)
      .values({
        userId: input.userId,
        type: input.type,
        payload,
        dedupeKey: input.dedupeKey ?? null,
        inApp,
      })
      .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
      .returning({ id: notifications.id })
    if (inserted.length === 0) return { notificationId: null, emailed: false, duplicate: true }
    if (inApp) notificationId = inserted[0]?.id ?? null
  }

  let emailed = false
  if (input.email && emailOn && recipient.email) {
    try {
      await sendEmail({
        to: recipient.email,
        subject: input.email.subject,
        react: input.email.react,
        attachments: input.email.attachments,
        tags: { notification: input.type },
        idempotencyKey: input.dedupeKey
          ? `notification:${input.userId}:${input.dedupeKey}`
          : notificationId
            ? `notification:${notificationId}`
            : undefined,
      })
      emailed = true
    } catch (error) {
      if (input.email.required) throw error
      reportError(error, { tags: { notification: input.type, channel: "email" } })
    }
  }

  return { notificationId, emailed, duplicate: false }
}
