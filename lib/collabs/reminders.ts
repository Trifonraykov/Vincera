import "server-only"

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"

import { requestAgreementFinalize } from "@/lib/agreements/sign"
import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import {
  agreementSignatures,
  agreements,
  collabMembers,
  collabs,
  ideas,
  notifications,
  products,
  users,
} from "@/lib/db/schema"
import { reportError } from "@/lib/observability"

import { notifyAgreementReminder, notifyCollabStalled } from "./notifications"
import { loadPayoutsReadiness } from "./queries"

/**
 * `reminders/stalled` (§13, daily; CLAUDE.md §19.24 "Reminders", §19.28):
 *
 * - `collab.stalled` to each member of a collab in `agreement` or `building` whose
 *   `last_activity_at` is 7+ days old. Dedupe key `collab.stalled:<collabId>:<last_activity_at ms>`:
 *   once per quiet spell; any activity starts a new one.
 * - `agreement.reminder` to each member who has not signed an agreement awaiting signatures that
 *   was generated 3+ days ago. Dedupe key `agreement.reminder:<agreementId>:<userId>`: once.
 * - Safety net: signed agreements still without a PDF, or with a member who never got the signed-PDF
 *   email, 10+ minutes (and up to 7 days) after the last signature get `agreements/finalize`
 *   again, with a fresh event id per day so Inngest does not drop it as a duplicate.
 *
 * Only active users are reminded. Work is read in pages (keyset) of 100; a failing item is reported
 * and skipped, and the result counts it so the job can fail and be retried (notifications are
 * deduplicated, so a retry repeats nothing that went out).
 */

export const STALLED_AFTER_DAYS = 7
export const AGREEMENT_REMINDER_AFTER_DAYS = 3
const FINALIZE_GRACE_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 100

export type ReminderResult = {
  stalledCollabs: number
  stalledNotices: number
  agreementReminders: number
  finalizeRequested: number
  failed: number
}

function wholeDays(from: Date, to: Date): number {
  return Math.max(1, Math.floor((to.getTime() - from.getTime()) / DAY_MS))
}

const collabTitle = sql<string>`coalesce(${ideas.title}, ${products.title}, 'Your collab')`

async function activeMembers(
  database: DbOrTx,
  collabIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (collabIds.length === 0) return result
  const rows = await database
    .select({ collabId: collabMembers.collabId, userId: collabMembers.userId })
    .from(collabMembers)
    .innerJoin(users, eq(users.id, collabMembers.userId))
    .where(and(inArray(collabMembers.collabId, [...collabIds]), eq(users.status, "active")))
  for (const row of rows)
    result.set(row.collabId, [...(result.get(row.collabId) ?? []), row.userId])
  return result
}

/** Collabs idle for 7+ days: `collab.stalled` to their members. */
export async function remindStalledCollabs(
  database: DbOrTx,
  at: Date = now(),
): Promise<Pick<ReminderResult, "stalledCollabs" | "stalledNotices" | "failed">> {
  const cutoff = new Date(at.getTime() - STALLED_AFTER_DAYS * DAY_MS)
  const result = { stalledCollabs: 0, stalledNotices: 0, failed: 0 }
  let cursor: { lastActivityAt: Date; id: string } | null = null
  for (;;) {
    const page: { id: string; lastActivityAt: Date; title: string }[] = await database
      .select({ id: collabs.id, lastActivityAt: collabs.lastActivityAt, title: collabTitle })
      .from(collabs)
      .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
      .leftJoin(products, eq(products.id, collabs.productId))
      .where(
        and(
          inArray(collabs.stage, ["agreement", "building"]),
          lte(collabs.lastActivityAt, cutoff),
          cursor
            ? or(
                gt(collabs.lastActivityAt, cursor.lastActivityAt),
                and(eq(collabs.lastActivityAt, cursor.lastActivityAt), gt(collabs.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(collabs.lastActivityAt), asc(collabs.id))
      .limit(PAGE_SIZE)
    if (page.length === 0) break
    const members = await activeMembers(
      database,
      page.map((collab) => collab.id),
    )
    for (const collab of page) {
      result.stalledCollabs += 1
      for (const userId of members.get(collab.id) ?? []) {
        try {
          const sent = await notifyCollabStalled(database, {
            userId,
            collabId: collab.id,
            collabTitle: collab.title,
            idleDays: wholeDays(collab.lastActivityAt, at),
            lastActivityAt: collab.lastActivityAt,
          })
          if (sent) result.stalledNotices += 1
        } catch (error) {
          result.failed += 1
          reportError(error, { tags: { job: "reminders-stalled", kind: "collab.stalled" } })
        }
      }
    }
    const last = page.at(-1)
    if (!last || page.length < PAGE_SIZE) break
    cursor = { lastActivityAt: last.lastActivityAt, id: last.id }
  }
  return result
}

/** Agreements awaiting signatures for 3+ days: `agreement.reminder` to members still to sign. */
export async function remindUnsignedAgreements(
  database: DbOrTx,
  at: Date = now(),
): Promise<Pick<ReminderResult, "agreementReminders" | "failed">> {
  const cutoff = new Date(at.getTime() - AGREEMENT_REMINDER_AFTER_DAYS * DAY_MS)
  const result = { agreementReminders: 0, failed: 0 }
  let cursor: { createdAt: Date; id: string } | null = null
  for (;;) {
    const page: { id: string; collabId: string; createdAt: Date; title: string }[] = await database
      .select({
        id: agreements.id,
        collabId: agreements.collabId,
        createdAt: agreements.createdAt,
        title: collabTitle,
      })
      .from(agreements)
      .innerJoin(collabs, eq(collabs.id, agreements.collabId))
      .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
      .leftJoin(products, eq(products.id, collabs.productId))
      .where(
        and(
          eq(agreements.status, "awaiting_signatures"),
          eq(collabs.stage, "agreement"),
          lte(agreements.createdAt, cutoff),
          cursor
            ? or(
                gt(agreements.createdAt, cursor.createdAt),
                and(eq(agreements.createdAt, cursor.createdAt), gt(agreements.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(agreements.createdAt), asc(agreements.id))
      .limit(PAGE_SIZE)
    if (page.length === 0) break
    const members = await activeMembers(
      database,
      page.map((agreement) => agreement.collabId),
    )
    const signatures = await database
      .select({ agreementId: agreementSignatures.agreementId, userId: agreementSignatures.userId })
      .from(agreementSignatures)
      .where(
        inArray(
          agreementSignatures.agreementId,
          page.map((agreement) => agreement.id),
        ),
      )
    const readiness = await loadPayoutsReadiness(database, [...members.values()].flat())
    for (const agreement of page) {
      const signed = new Set(
        signatures.filter((row) => row.agreementId === agreement.id).map((row) => row.userId),
      )
      for (const userId of members.get(agreement.collabId) ?? []) {
        if (signed.has(userId)) continue
        try {
          const sent = await notifyAgreementReminder(database, {
            userId,
            collabId: agreement.collabId,
            agreementId: agreement.id,
            collabTitle: agreement.title,
            daysWaiting: wholeDays(agreement.createdAt, at),
            payoutsReady: readiness.get(userId) ?? false,
          })
          if (sent) result.agreementReminders += 1
        } catch (error) {
          result.failed += 1
          reportError(error, { tags: { job: "reminders-stalled", kind: "agreement.reminder" } })
        }
      }
    }
    const last = page.at(-1)
    if (!last || page.length < PAGE_SIZE) break
    cursor = { createdAt: last.createdAt, id: last.id }
  }
  return result
}

/** How long the safety net keeps retrying an agreement whose finalize keeps failing. */
const FINALIZE_RETRY_WINDOW_MS = 7 * DAY_MS

/**
 * Signed agreements whose finalize did not finish: the PDF never got stored, or a member never got
 * the signed-PDF email (a required email: its notification row only exists once it was sent, see
 * lib/notifications/notify.ts). Finalize them again, for up to a week after completion.
 */
export async function refinalizeSignedAgreements(
  database: DbOrTx,
  at: Date = now(),
): Promise<number> {
  const memberWithoutPdfEmail = sql`exists (
    select 1 from ${collabMembers}
    where ${collabMembers.collabId} = ${agreements.collabId}
      and not exists (
        select 1 from ${notifications}
        where ${notifications.userId} = ${collabMembers.userId}
          and ${notifications.dedupeKey} =
            'agreement.completed:' || ${agreements.id}::text || ':' || ${collabMembers.userId}::text
      )
  )`
  const rows = await database
    .select({ id: agreements.id })
    .from(agreements)
    .where(
      and(
        eq(agreements.status, "signed"),
        or(isNull(agreements.pdfStorageKey), memberWithoutPdfEmail),
        lte(agreements.completedAt, new Date(at.getTime() - FINALIZE_GRACE_MS)),
        gt(agreements.completedAt, new Date(at.getTime() - FINALIZE_RETRY_WINDOW_MS)),
      ),
    )
    .orderBy(asc(agreements.completedAt))
    .limit(PAGE_SIZE)
  const day = at.toISOString().slice(0, 10)
  for (const row of rows) await requestAgreementFinalize(row.id, { attempt: `retry:${day}` })
  return rows.length
}
