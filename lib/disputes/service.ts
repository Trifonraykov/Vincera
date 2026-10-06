import "server-only"

import { and, desc, eq, ne, sql } from "drizzle-orm"
import { createElement } from "react"

import { ActionError } from "@/lib/actions/errors"
import type { CollabAccess } from "@/lib/auth/authz"
import { loadCollabSummary } from "@/lib/collabs/queries"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { isPgError, PG_ERROR } from "@/lib/db/errors"
import { collabMembers, collabs, disputes } from "@/lib/db/schema"
import type { DisputeKind, DisputeOutcome, DisputeStatus } from "@/lib/db/schema/enums"
import NotificationEmail from "@/lib/email/templates/notification"
import { env } from "@/lib/env"
import { track } from "@/lib/events/track"
import { adminUserIds } from "@/lib/launches/queries"
import { notify } from "@/lib/notifications/notify"
import { reportError } from "@/lib/observability"
import { clip } from "@/lib/proposals/queries"
import { absoluteUrl } from "@/lib/urls"

import { DISPUTE_KIND_LABELS } from "./fields"

/**
 * Members raise collab disputes (§16 Phase 6; CLAUDE.md §19.38, §19.40). Admins move them to
 * `in_review` and resolve them in /admin/disputes (the admin area); this module only opens them
 * and lists them for the collab page.
 */

export const DISPUTE_MESSAGES = {
  notFound: "This collab no longer exists.",
  notMember: "Only the collab's members can raise a dispute.",
  alreadyOpen:
    "You already have an open dispute about this collab. Our team will get back to you on it.",
} as const

/** What `canRaiseDispute` needs, or null for an unknown collab. */
export async function loadDisputeRaiseAccess(
  database: DbOrTx,
  collabId: string,
  userId: string,
): Promise<(CollabAccess & { hasUnresolvedDisputeByUser: boolean }) | null> {
  const [collab] = await database
    .select({ id: collabs.id })
    .from(collabs)
    .where(eq(collabs.id, collabId))
  if (!collab) return null
  const members = await database
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, collabId))
  const [open] = await database
    .select({ id: disputes.id })
    .from(disputes)
    .where(
      and(
        eq(disputes.collabId, collabId),
        eq(disputes.raisedByUserId, userId),
        ne(disputes.status, "resolved"),
      ),
    )
    .limit(1)
  return {
    memberUserIds: members.map((member) => member.userId),
    hasUnresolvedDisputeByUser: open !== undefined,
  }
}

/**
 * Open a dispute: one transaction with the row and `dispute.opened` (actor the member). The
 * collab's row is locked first and membership is checked again under it; the partial unique index
 * (one unresolved dispute per member and collab) settles a double submit.
 */
export async function raiseDispute(
  database: DbOrTx,
  input: { collabId: string; userId: string; kind: DisputeKind; description: string },
): Promise<{ disputeId: string }> {
  return withTransaction(async (tx) => {
    const [collab] = await tx
      .select({ id: collabs.id })
      .from(collabs)
      .where(eq(collabs.id, input.collabId))
      .for("share")
    if (!collab) throw new ActionError(DISPUTE_MESSAGES.notFound)
    const [member] = await tx
      .select({ userId: collabMembers.userId })
      .from(collabMembers)
      .where(
        and(eq(collabMembers.collabId, input.collabId), eq(collabMembers.userId, input.userId)),
      )
    if (!member) throw new ActionError(DISPUTE_MESSAGES.notMember)

    let disputeId: string
    try {
      const [row] = await tx
        .insert(disputes)
        .values({
          collabId: input.collabId,
          raisedByUserId: input.userId,
          kind: input.kind,
          description: input.description,
        })
        .returning({ id: disputes.id })
      if (!row) throw new Error("raiseDispute: no row returned")
      disputeId = row.id
    } catch (error) {
      if (isPgError(error, PG_ERROR.uniqueViolation, "disputes_one_unresolved_per_member_idx")) {
        throw new ActionError(DISPUTE_MESSAGES.alreadyOpen)
      }
      throw error
    }

    await track(
      "dispute.opened",
      {
        actorUserId: input.userId,
        subjectType: "dispute",
        subjectId: disputeId,
        properties: { collab_id: input.collabId, kind: input.kind },
      },
      tx,
    )
    return { disputeId }
  }, database)
}

/**
 * After the commit: `dispute.opened` to the other member(s) and `admin.dispute_opened` to every
 * active admin (dedupe `<type>:<disputeId>:<userId>`). One recipient's failure is reported and
 * does not stop the others.
 */
export async function notifyDisputeOpened(
  database: DbOrTx,
  disputeId: string,
): Promise<{ members: number; admins: number }> {
  const [dispute] = await database.select().from(disputes).where(eq(disputes.id, disputeId))
  if (!dispute) throw new Error(`dispute ${disputeId} not found`)
  const collab = await loadCollabSummary(database, dispute.collabId)
  if (!collab) throw new Error(`collab ${dispute.collabId} not found`)
  const raiser = collab.members.find((member) => member.userId === dispute.raisedByUserId)
  const raisedByName = clip(raiser?.name ?? "Your collaborator", 120)
  const base = {
    dispute_id: dispute.id,
    collab_id: collab.id,
    collab_title: clip(collab.target.title, 200),
    kind: dispute.kind,
  }
  const kindLabel = DISPUTE_KIND_LABELS[dispute.kind].toLowerCase()
  let members = 0
  let admins = 0

  for (const member of collab.members) {
    if (member.userId === dispute.raisedByUserId) continue
    try {
      await notify(
        {
          userId: member.userId,
          type: "dispute.opened",
          payload: { ...base, raised_by_name: raisedByName },
          dedupeKey: `dispute.opened:${dispute.id}:${member.userId}`,
          email: {
            subject: `${raisedByName} raised a dispute about “${base.collab_title}”`,
            react: createElement(NotificationEmail, {
              appName: env.APP_NAME,
              heading: "A dispute was raised",
              paragraphs: [
                `${raisedByName} raised a dispute about ${kindLabel} in “${base.collab_title}”.`,
                "Our team will look into it and may message you both. Nothing changes in the collab until they decide.",
              ],
              action: {
                label: "Open the collab",
                url: absoluteUrl(`/app/collabs/${collab.id}#disputes`),
              },
            }),
          },
        },
        database,
      )
      members += 1
    } catch (error) {
      reportError(error, { tags: { area: "disputes", notice: "dispute.opened" } })
    }
  }

  for (const adminId of await adminUserIds(database)) {
    try {
      await notify(
        {
          userId: adminId,
          type: "admin.dispute_opened",
          payload: base,
          dedupeKey: `admin.dispute_opened:${dispute.id}:${adminId}`,
          email: {
            subject: `Collab dispute: ${DISPUTE_KIND_LABELS[dispute.kind]} in “${base.collab_title}”`,
            react: createElement(NotificationEmail, {
              appName: env.APP_NAME,
              heading: "A collab dispute was raised",
              paragraphs: [
                `A member raised a dispute about ${kindLabel} in “${base.collab_title}”.`,
                "Pick it up in the admin area to move it to review.",
              ],
              action: {
                label: "Open the dispute",
                url: absoluteUrl(`/admin/disputes/${dispute.id}`),
              },
            }),
          },
        },
        database,
      )
      admins += 1
    } catch (error) {
      reportError(error, { tags: { area: "disputes", notice: "admin.dispute_opened" } })
    }
  }
  return { members, admins }
}

export type CollabDisputeItem = {
  id: string
  kind: DisputeKind
  status: DisputeStatus
  description: string
  raisedByUserId: string
  createdAt: Date
  inReviewAt: Date | null
  resolvedAt: Date | null
  outcome: DisputeOutcome | null
  resolutionNote: string | null
}

/** A collab's disputes, unresolved first, then newest first (the collab page's card). */
export async function listCollabDisputes(
  database: DbOrTx,
  collabId: string,
): Promise<CollabDisputeItem[]> {
  const rows = await database
    .select({
      id: disputes.id,
      kind: disputes.kind,
      status: disputes.status,
      description: disputes.description,
      raisedByUserId: disputes.raisedByUserId,
      createdAt: disputes.createdAt,
      inReviewAt: disputes.inReviewAt,
      resolvedAt: disputes.resolvedAt,
      outcome: disputes.outcome,
      resolutionNote: disputes.resolutionNote,
    })
    .from(disputes)
    .where(eq(disputes.collabId, collabId))
    .orderBy(sql`${disputes.resolvedAt} IS NOT NULL`, desc(disputes.createdAt))
  return rows
}
