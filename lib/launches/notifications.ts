import "server-only"

import { createElement } from "react"

import type { DbOrTx } from "@/lib/db/client"
import NotificationEmail from "@/lib/email/templates/notification"
import { env } from "@/lib/env"
import { notify } from "@/lib/notifications/notify"
import { clip } from "@/lib/proposals/queries"
import { absoluteUrl } from "@/lib/urls"

/**
 * The launch area's notifications (CLAUDE.md §19.31 "Emails", §7.4 "launch approved / live"):
 * in-app plus the generic email, each switchable per type in Settings → Notifications. Every call
 * passes a dedupe key, so a retried transaction never notifies twice. Call them last in the
 * transaction (`notify` emails right away).
 */

const NAME_MAX = 120
const TITLE_MAX = 200

export type LaunchNotice = {
  userId: string
  collabId: string
  launchId: string
  launchTitle: string
}

function payloadOf(notice: LaunchNotice) {
  return {
    collab_id: notice.collabId,
    launch_id: notice.launchId,
    launch_title: clip(notice.launchTitle, TITLE_MAX),
  }
}

function setupUrl(collabId: string): string {
  return absoluteUrl(`/app/collabs/${collabId}/launch`)
}

/** To the other member after the first approval of a version. */
export async function notifyApprovalRequested(
  database: DbOrTx,
  notice: LaunchNotice & { approverName: string; submittedAt: Date },
): Promise<void> {
  const payload = { ...payloadOf(notice), approver_name: clip(notice.approverName, NAME_MAX) }
  await notify(
    {
      userId: notice.userId,
      type: "launch.approval_requested",
      payload,
      dedupeKey: `launch.approval_requested:${notice.launchId}:${notice.submittedAt.getTime()}`,
      email: {
        subject: `${payload.approver_name} approved “${payload.launch_title}”`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: `${payload.approver_name} approved the launch`,
          paragraphs: [
            `${payload.approver_name} approved the launch setup for “${payload.launch_title}”. Check the page, price and delivery, then approve it too so it can go to review.`,
          ],
          action: { label: "Review the launch", url: setupUrl(notice.collabId) },
        }),
      },
    },
    database,
  )
}

/** To each member when an admin sends the launch back to draft. */
export async function notifyLaunchRejected(
  database: DbOrTx,
  notice: LaunchNotice & { note: string; reviewedAt: Date },
): Promise<void> {
  const payload = payloadOf(notice)
  await notify(
    {
      userId: notice.userId,
      type: "launch.rejected",
      payload,
      dedupeKey: `launch.rejected:${notice.launchId}:${notice.reviewedAt.getTime()}`,
      email: {
        subject: `Changes needed before “${payload.launch_title}” goes live`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: "Your launch needs a few changes",
          paragraphs: [
            `Our team reviewed “${payload.launch_title}” and sent it back with this note:`,
            notice.note,
            "Make the changes, then both of you approve it again.",
          ],
          action: { label: "Open the launch setup", url: setupUrl(notice.collabId) },
        }),
      },
    },
    database,
  )
}

/** To each member when the launch first goes live. */
export async function notifyLaunchLive(
  database: DbOrTx,
  notice: LaunchNotice & { slug: string; isCreator: boolean },
): Promise<void> {
  const payload = { ...payloadOf(notice), slug: notice.slug }
  await notify(
    {
      userId: notice.userId,
      type: "launch.live",
      payload,
      dedupeKey: `launch.live:${notice.launchId}`,
      email: {
        subject: `“${payload.launch_title}” is live`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: `“${payload.launch_title}” is live`,
          paragraphs: [
            "Your product page is public and buyers can pay for it now.",
            notice.isCreator
              ? "Your launch kit has your tracked link and post ideas for each platform: share it so sales are counted for you."
              : "The launch kit has the creator's tracked link and post ideas for each platform.",
          ],
          action: {
            label: "Open the launch kit",
            url: absoluteUrl(`/app/launches/${notice.launchId}/kit`),
          },
        }),
      },
    },
    database,
  )
}

/** When a member or an admin pauses a live launch (to the other member, or both for an admin). */
export async function notifyLaunchPaused(
  database: DbOrTx,
  notice: LaunchNotice & { pausedBy: "member" | "admin" | "dispute"; pausedAt: Date },
): Promise<void> {
  const payload = { ...payloadOf(notice), paused_by: notice.pausedBy }
  await notify(
    {
      userId: notice.userId,
      type: "launch.paused",
      payload,
      dedupeKey: `launch.paused:${notice.launchId}:${notice.pausedAt.getTime()}`,
      email: {
        subject: `Sales of “${payload.launch_title}” are paused`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: "Sales are paused",
          paragraphs: [
            notice.pausedBy === "member"
              ? `Your collaborator paused sales of “${payload.launch_title}”. The product page now says it's unavailable.`
              : `Our team paused sales of “${payload.launch_title}”. The product page now says it's unavailable. We'll be in touch about what happens next.`,
          ],
          action: { label: "Open the launch setup", url: setupUrl(notice.collabId) },
        }),
      },
    },
    database,
  )
}

/** To every admin when both members approved and the launch waits in `admin_review`. */
export async function notifyReviewRequested(
  database: DbOrTx,
  notice: LaunchNotice & { submittedAt: Date },
): Promise<void> {
  const payload = payloadOf(notice)
  await notify(
    {
      userId: notice.userId,
      type: "admin.launch_review_requested",
      payload,
      dedupeKey: `admin.launch_review_requested:${notice.launchId}:${notice.submittedAt.getTime()}`,
      email: {
        subject: `Launch to review: “${payload.launch_title}”`,
        react: createElement(NotificationEmail, {
          appName: env.APP_NAME,
          heading: "A launch is waiting for review",
          paragraphs: [
            `Both members approved “${payload.launch_title}”. Check the page, price and delivery, then approve it or send it back with a note.`,
          ],
          action: { label: "Open the review queue", url: absoluteUrl("/admin/launches") },
        }),
      },
    },
    database,
  )
}
