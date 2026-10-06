import "server-only"

import { createElement } from "react"

import { agreementDate } from "@/lib/agreements/template-v1"
import type { DbOrTx } from "@/lib/db/client"
import type { EmailAttachment } from "@/lib/email/send"
import AgreementCompletedEmail, {
  agreementCompletedSubject,
} from "@/lib/email/templates/agreement-completed"
import AgreementReadyEmail, { agreementReadySubject } from "@/lib/email/templates/agreement-ready"
import NotificationEmail from "@/lib/email/templates/notification"
import { env } from "@/lib/env"
import { notify } from "@/lib/notifications/notify"
import { clip } from "@/lib/proposals/queries"
import { absoluteUrl } from "@/lib/urls"

/**
 * The collab area's notifications (CLAUDE.md §19.24 registry, §7.4): in-app plus email, each
 * switchable per type in Settings → Notifications. `agreement.ready` and `agreement.completed`
 * have their own templates (the latter with the signed PDF attached); the others use the generic
 * one. Every call passes a dedupe key, so a retried transaction or job never notifies twice. Call
 * them last in the transaction (`notify` emails right away).
 */

const NAME_MAX = 120
const TITLE_MAX = 200

type AgreementNotice = {
  userId: string
  collabId: string
  agreementId: string
  collabTitle: string
}

function agreementPayload(notice: AgreementNotice) {
  return {
    collab_id: notice.collabId,
    agreement_id: notice.agreementId,
    collab_title: clip(notice.collabTitle, TITLE_MAX),
  }
}

function agreementUrl(collabId: string): string {
  return absoluteUrl(`/app/collabs/${collabId}/agreement`)
}

/** To each member when the agreement is generated. */
export async function notifyAgreementReady(
  database: DbOrTx,
  notice: AgreementNotice & {
    counterpartName: string
    terms: { creatorSplitPct: number; builderSplitPct: number; timelineWeeks: number }
    payoutsReady: boolean
  },
): Promise<void> {
  const payload = agreementPayload(notice)
  await notify(
    {
      userId: notice.userId,
      type: "agreement.ready",
      payload,
      dedupeKey: `agreement.ready:${notice.agreementId}:${notice.userId}`,
      email: {
        subject: agreementReadySubject(payload.collab_title),
        react: createElement(AgreementReadyEmail, {
          appName: env.APP_NAME,
          counterpartName: clip(notice.counterpartName, NAME_MAX),
          collabTitle: payload.collab_title,
          terms: notice.terms,
          payoutsReady: notice.payoutsReady,
          agreementUrl: agreementUrl(notice.collabId),
          payoutsUrl: absoluteUrl("/app/settings/payouts"),
        }),
      },
    },
    database,
  )
}

/** To the member who has not signed yet, when the other one signed. */
export async function notifyAgreementSigned(
  database: DbOrTx,
  notice: AgreementNotice & { signerName: string; recipientPayoutsReady: boolean },
): Promise<void> {
  const payload = { ...agreementPayload(notice), signer_name: clip(notice.signerName, NAME_MAX) }
  const paragraphs = [
    `${payload.signer_name} signed the collaboration agreement for “${payload.collab_title}”. Once you sign too, the collab moves on to building.`,
    notice.recipientPayoutsReady
      ? "Read it through and sign by typing your full name."
      : "Set up payouts first (Settings → Payouts), then sign by typing your full name.",
  ]
  await notify(
    {
      userId: notice.userId,
      type: "agreement.signed",
      payload,
      dedupeKey: `agreement.signed:${notice.agreementId}:${notice.userId}`,
      email: {
        subject: `${payload.signer_name} signed your agreement`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: `${payload.signer_name} signed the agreement`,
          paragraphs,
          action: { label: "Read and sign", url: agreementUrl(notice.collabId) },
        }),
      },
    },
    database,
  )
}

/**
 * To each member once both signed, with the signed PDF attached (`agreements-finalize`). The
 * email is required: it ignores the email preference and throws when it cannot be sent, so the
 * finalize step fails and is retried (CLAUDE.md §19.30).
 */
export async function notifyAgreementCompleted(
  database: DbOrTx,
  notice: AgreementNotice & {
    counterpartName: string
    completedAt: Date
    pdf: EmailAttachment & { filename: string }
  },
): Promise<void> {
  const payload = agreementPayload(notice)
  await notify(
    {
      userId: notice.userId,
      type: "agreement.completed",
      payload,
      dedupeKey: `agreement.completed:${notice.agreementId}:${notice.userId}`,
      email: {
        subject: agreementCompletedSubject(payload.collab_title),
        react: createElement(AgreementCompletedEmail, {
          appName: env.APP_NAME,
          counterpartName: clip(notice.counterpartName, NAME_MAX),
          collabTitle: payload.collab_title,
          completedOn: agreementDate(notice.completedAt),
          pdfFilename: notice.pdf.filename,
          collabUrl: absoluteUrl(`/app/collabs/${notice.collabId}`),
        }),
        attachments: [notice.pdf],
        // The signed agreement is a legal record (§12 "email the PDF"): it goes out whatever the
        // email preference, and a failed send throws so the finalize step retries it.
        required: true,
      },
    },
    database,
  )
}

/** reminders/stalled: a member has not signed an agreement generated 3+ days ago. */
export async function notifyAgreementReminder(
  database: DbOrTx,
  notice: AgreementNotice & { daysWaiting: number; payoutsReady: boolean },
): Promise<boolean> {
  const payload = { ...agreementPayload(notice), days_waiting: notice.daysWaiting }
  const result = await notify(
    {
      userId: notice.userId,
      type: "agreement.reminder",
      payload,
      dedupeKey: `agreement.reminder:${notice.agreementId}:${notice.userId}`,
      email: {
        subject: `Reminder: sign your agreement for “${payload.collab_title}”`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: "Your agreement is waiting for your signature",
          paragraphs: [
            `The collaboration agreement for “${payload.collab_title}” has been ready for ${notice.daysWaiting} days. Work starts once you have both signed.`,
            notice.payoutsReady
              ? "Read it through and sign by typing your full name."
              : "You need payouts set up before you can sign: it takes a few minutes with Stripe in Settings → Payouts.",
          ],
          action: { label: "Read the agreement", url: agreementUrl(notice.collabId) },
        }),
      },
    },
    database,
  )
  return !result.duplicate
}

/** reminders/stalled: no member activity on the collab for 7+ days (to each member). */
export async function notifyCollabStalled(
  database: DbOrTx,
  notice: {
    userId: string
    collabId: string
    collabTitle: string
    idleDays: number
    lastActivityAt: Date
  },
): Promise<boolean> {
  const payload = {
    collab_id: notice.collabId,
    collab_title: clip(notice.collabTitle, TITLE_MAX),
    idle_days: notice.idleDays,
  }
  const result = await notify(
    {
      userId: notice.userId,
      type: "collab.stalled",
      payload,
      dedupeKey: `collab.stalled:${notice.collabId}:${notice.lastActivityAt.getTime()}`,
      email: {
        subject: `“${payload.collab_title}” has gone quiet`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: `“${payload.collab_title}” has gone quiet`,
          paragraphs: [
            `Nothing has happened in this collab for ${notice.idleDays} days: no messages, tasks or signatures.`,
            "A quick message or a task for the next step keeps things moving.",
          ],
          action: { label: "Open the collab", url: absoluteUrl(`/app/collabs/${notice.collabId}`) },
        }),
      },
    },
    database,
  )
  return !result.duplicate
}

/** To the assignee when the other member assigns them a task. */
export async function notifyTaskAssigned(
  database: DbOrTx,
  notice: {
    userId: string
    collabId: string
    taskId: string
    taskTitle: string
    collabTitle: string
    assignedByName: string
    /** When the assignment was made (the dedupe key: one notification per assignment). */
    assignedAt: Date
  },
): Promise<void> {
  const payload = {
    collab_id: notice.collabId,
    task_id: notice.taskId,
    task_title: clip(notice.taskTitle, TITLE_MAX),
    collab_title: clip(notice.collabTitle, TITLE_MAX),
    assigned_by_name: clip(notice.assignedByName, NAME_MAX),
  }
  await notify(
    {
      userId: notice.userId,
      type: "task.assigned",
      payload,
      // One per assignment: assigning the same task to them again later notifies again.
      dedupeKey: `task.assigned:${notice.taskId}:${notice.userId}:${notice.assignedAt.getTime()}`,
      email: {
        subject: `${payload.assigned_by_name} assigned you a task`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: `${payload.assigned_by_name} assigned you a task`,
          paragraphs: [`“${payload.task_title}” in “${payload.collab_title}”.`],
          action: {
            label: "Open the tasks",
            url: absoluteUrl(`/app/collabs/${notice.collabId}/tasks`),
          },
        }),
      },
    },
    database,
  )
}
