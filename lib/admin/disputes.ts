import "server-only"

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm"
import { createElement } from "react"

import { ActionError } from "@/lib/actions/errors"
import { canResolveDispute, canReviewDispute, type AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { changeCollabStage } from "@/lib/collabs/stage"
import { loadCollabSummary, loadCollabTitle } from "@/lib/collabs/queries"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import {
  agreements,
  collabMembers,
  collabs,
  disputes,
  ideas,
  launches,
  orders,
  products,
  users,
} from "@/lib/db/schema"
import type {
  DisputeKind,
  DisputeOutcome,
  DisputeStatus,
  LaunchStatus,
  OrderStatus,
} from "@/lib/db/schema/enums"
import NotificationEmail from "@/lib/email/templates/notification"
import { requestEmbeddingRefreshAfterCommit } from "@/lib/embeddings/request"
import { env } from "@/lib/env"
import { track } from "@/lib/events/track"
import { endLaunchInTx, lockLaunch } from "@/lib/launches/service"
import { revalidateLaunchPage } from "@/lib/launches/revalidate"
import { notify } from "@/lib/notifications/notify"
import { reportError } from "@/lib/observability"
import { clip } from "@/lib/proposals/queries"
import { absoluteUrl } from "@/lib/urls"

import { writeAdminAudit } from "./audit"
import { DISPUTE_KIND_TEXT, OUTCOME_LABELS } from "./fields"
import { createLedgerAdjustment, type AdjustmentLine } from "./ledger-adjustments"

/**
 * The admin side of collab disputes (§16 Phase 6; CLAUDE.md §19.38 "Disputes": trust raises,
 * admin decides): the list and detail page data, `in_review`, and resolving with a note and an
 * outcome. `adjusted` writes a ledger adjustment in the same transaction; `collab_ended` ends the
 * collab (reason `dispute`), ends a live or paused launch, and puts an idea or product that never
 * launched back on offer. Members are notified after the commit.
 */

export const DISPUTE_ERRORS = {
  notFound: "That dispute doesn't exist.",
  notOpen: "Someone already took this dispute into review.",
  notInReview: "Take the dispute into review before resolving it.",
  needsLines: "Add the adjustment lines, or pick another outcome.",
} as const

export type AdminDisputeListItem = {
  id: string
  collabId: string
  collabTitle: string
  kind: DisputeKind
  status: DisputeStatus
  outcome: DisputeOutcome | null
  createdAt: Date
  raisedByName: string
}

/** Disputes for the list page: unresolved first (oldest first), then resolved, newest first. */
export async function listDisputesForAdmin(
  db: DbOrTx,
  filter: { status?: DisputeStatus | "unresolved" } = {},
): Promise<AdminDisputeListItem[]> {
  const where =
    filter.status === "unresolved" || filter.status === undefined
      ? ne(disputes.status, "resolved")
      : eq(disputes.status, filter.status)
  const rows = await db
    .select({
      id: disputes.id,
      collabId: disputes.collabId,
      kind: disputes.kind,
      status: disputes.status,
      outcome: disputes.outcome,
      createdAt: disputes.createdAt,
      raisedByName: users.name,
      ideaTitle: ideas.title,
      productTitle: products.title,
    })
    .from(disputes)
    .innerJoin(collabs, eq(collabs.id, disputes.collabId))
    .innerJoin(users, eq(users.id, disputes.raisedByUserId))
    .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
    .leftJoin(products, eq(products.id, collabs.productId))
    .where(where)
    .orderBy(
      filter.status === "resolved" ? desc(disputes.resolvedAt) : asc(disputes.createdAt),
      asc(disputes.id),
    )
    .limit(200)
  return rows.map((row) => ({
    id: row.id,
    collabId: row.collabId,
    collabTitle: row.ideaTitle ?? row.productTitle ?? "Untitled",
    kind: row.kind,
    status: row.status,
    outcome: row.outcome,
    createdAt: row.createdAt,
    raisedByName: row.raisedByName ?? "A member",
  }))
}

export type AdminDisputeDetail = {
  dispute: typeof disputes.$inferSelect
  collab: NonNullable<Awaited<ReturnType<typeof loadCollabSummary>>>
  raisedByName: string
  launch: {
    id: string
    title: string
    slug: string
    status: LaunchStatus
    wentLiveAt: Date | null
    pausedBy: string | null
  } | null
  orders: {
    id: string
    paidAt: Date
    grossCents: number
    refundedCents: number
    currency: string
    status: OrderStatus
  }[]
}

export async function loadDisputeForAdmin(
  db: DbOrTx,
  disputeId: string,
): Promise<AdminDisputeDetail | null> {
  const [row] = await db
    .select({ dispute: disputes, raisedByName: users.name })
    .from(disputes)
    .innerJoin(users, eq(users.id, disputes.raisedByUserId))
    .where(eq(disputes.id, disputeId))
  if (!row) return null
  const collab = await loadCollabSummary(db, row.dispute.collabId)
  if (!collab) return null
  const [launch] = await db
    .select({
      id: launches.id,
      title: launches.title,
      slug: launches.slug,
      status: launches.status,
      wentLiveAt: launches.wentLiveAt,
      pausedBy: launches.pausedBy,
    })
    .from(launches)
    .where(eq(launches.collabId, collab.id))
  const orderRows = launch
    ? await db
        .select({
          id: orders.id,
          paidAt: orders.paidAt,
          grossCents: orders.amountGrossCents,
          refundedCents: orders.amountRefundedCents,
          currency: orders.currency,
          status: orders.status,
        })
        .from(orders)
        .where(eq(orders.launchId, launch.id))
        .orderBy(desc(orders.paidAt))
        .limit(50)
    : []
  const member = collab.members.find((m) => m.userId === row.dispute.raisedByUserId)
  return {
    dispute: row.dispute,
    collab,
    raisedByName: member?.name ?? row.raisedByName ?? "A member",
    launch: launch ?? null,
    orders: orderRows,
  }
}

type DisputeNotice = {
  type: "dispute.in_review" | "dispute.resolved"
  dispute: { id: string; collabId: string; kind: DisputeKind }
  collabTitle: string
  outcome?: DisputeOutcome
  memberIds: string[]
  note?: string
}

/** After the commit: the notice to both members (failures reported, never thrown). */
async function notifyMembers(db: DbOrTx, notice: DisputeNotice): Promise<void> {
  const base = {
    dispute_id: notice.dispute.id,
    collab_id: notice.dispute.collabId,
    collab_title: clip(notice.collabTitle, 200),
    kind: notice.dispute.kind,
  }
  const url = absoluteUrl(`/app/collabs/${notice.dispute.collabId}#disputes`)
  const kindText = DISPUTE_KIND_TEXT[notice.dispute.kind].toLowerCase()
  for (const userId of notice.memberIds) {
    try {
      if (notice.type === "dispute.in_review") {
        await notify(
          {
            userId,
            type: "dispute.in_review",
            payload: base,
            dedupeKey: `dispute.in_review:${notice.dispute.id}:${userId}`,
            email: {
              subject: `We're looking into the dispute on “${base.collab_title}”`,
              react: createElement(NotificationEmail, {
                appName: env.APP_NAME,
                heading: "We're looking into the dispute",
                paragraphs: [
                  `Our team has started reviewing the ${kindText} dispute on “${base.collab_title}”. We'll let you both know when it's resolved.`,
                ],
                action: { label: "Open the collab", url },
              }),
            },
          },
          db,
        )
      } else {
        const outcome = notice.outcome ?? "other"
        await notify(
          {
            userId,
            type: "dispute.resolved",
            payload: { ...base, outcome },
            dedupeKey: `dispute.resolved:${notice.dispute.id}:${userId}`,
            email: {
              subject: `The dispute on “${base.collab_title}” is resolved`,
              react: createElement(NotificationEmail, {
                appName: env.APP_NAME,
                heading: "The dispute is resolved",
                paragraphs: [
                  `Our team resolved the ${kindText} dispute on “${base.collab_title}”: ${OUTCOME_LABELS[outcome].toLowerCase()}.`,
                  ...(notice.note ? [`Note from our team: ${notice.note}`] : []),
                ],
                action: { label: "Open the collab", url },
              }),
            },
          },
          db,
        )
      }
    } catch (error) {
      reportError(error, { tags: { area: "disputes", notice: notice.type } })
    }
  }
}

async function lockDispute(tx: Tx, disputeId: string) {
  const [dispute] = await tx.select().from(disputes).where(eq(disputes.id, disputeId)).for("update")
  if (!dispute) throw new ActionError(DISPUTE_ERRORS.notFound)
  const members = await tx
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, dispute.collabId))
  return { dispute, memberIds: members.map((member) => member.userId) }
}

/** Move an open dispute to `in_review` (audited, `dispute.in_review`, notices to both members). */
export async function reviewDispute(
  db: DbOrTx,
  admin: AuthzUser,
  input: { disputeId: string },
): Promise<void> {
  const notice = await withTransaction(async (tx) => {
    const { dispute, memberIds } = await lockDispute(tx, input.disputeId)
    if (!canReviewDispute(admin, dispute)) throw new ActionError(DISPUTE_ERRORS.notOpen)
    const at = now()
    await tx
      .update(disputes)
      .set({ status: "in_review", inReviewAt: at, inReviewByUserId: admin.id })
      .where(eq(disputes.id, dispute.id))
    await writeAdminAudit(tx, {
      adminUserId: admin.id,
      action: "dispute.in_review",
      targetType: "dispute",
      targetId: dispute.id,
      before: { status: "open" },
      after: { status: "in_review" },
    })
    await track(
      "dispute.in_review",
      {
        actorUserId: admin.id,
        subjectType: "dispute",
        subjectId: dispute.id,
        properties: { collab_id: dispute.collabId, kind: dispute.kind },
      },
      tx,
    )
    return { dispute, memberIds, collabTitle: await loadCollabTitle(tx, dispute.collabId) }
  }, db)
  await notifyMembers(db, { type: "dispute.in_review", ...notice })
}

export type ResolveDisputeInput = {
  disputeId: string
  outcome: DisputeOutcome
  note: string
  /** With `adjusted`: the adjustment (currency defaults to the order's, else EUR). */
  adjustment?: {
    orderId?: string | null
    reason: string
    currency?: string
    lines: AdjustmentLine[]
  }
}

/**
 * Resolve a dispute in review, in one transaction with what the outcome needs; audited,
 * `dispute.resolved { outcome }`; notices to both members after the commit.
 */
export async function resolveDispute(
  db: DbOrTx,
  admin: AuthzUser,
  input: ResolveDisputeInput,
): Promise<{ adjustmentId: string | null; launchEnded: boolean }> {
  const after: {
    slug: string | null
    embeddings: { type: "idea" | "product"; id: string }[]
  } = { slug: null, embeddings: [] }
  const result = await withTransaction(async (tx) => {
    const { dispute, memberIds } = await lockDispute(tx, input.disputeId)
    if (!canResolveDispute(admin, dispute)) {
      throw new ActionError(
        dispute.status === "resolved"
          ? "This dispute is already resolved."
          : DISPUTE_ERRORS.notInReview,
      )
    }
    const at = now()
    let adjustmentId: string | null = null
    let launchEnded = false

    if (input.outcome === "adjusted") {
      if (!input.adjustment) throw new ActionError(DISPUTE_ERRORS.needsLines)
      let currency = input.adjustment.currency ?? "eur"
      if (input.adjustment.orderId) {
        const [order] = await tx
          .select({ currency: orders.currency })
          .from(orders)
          .where(eq(orders.id, input.adjustment.orderId))
        if (order) currency = order.currency
      }
      const created = await createLedgerAdjustment(tx, {
        adminUserId: admin.id,
        disputeId: dispute.id,
        orderId: input.adjustment.orderId ?? null,
        reason: input.adjustment.reason,
        currency,
        lines: input.adjustment.lines,
      })
      adjustmentId = created.adjustmentId
    }

    if (input.outcome === "collab_ended") {
      const ended = await endCollabForDispute(tx, admin, dispute.collabId)
      launchEnded = ended.launchEnded
      after.slug = ended.slug
      after.embeddings = ended.reopened
    }

    await tx
      .update(disputes)
      .set({
        status: "resolved",
        resolvedAt: at,
        resolvedBy: admin.id,
        outcome: input.outcome,
        resolutionNote: input.note,
      })
      .where(eq(disputes.id, dispute.id))
    await writeAdminAudit(tx, {
      adminUserId: admin.id,
      action: "dispute.resolved",
      targetType: "dispute",
      targetId: dispute.id,
      before: { status: "in_review" },
      after: {
        status: "resolved",
        outcome: input.outcome,
        resolution_note: input.note,
        adjustment_id: adjustmentId,
        launch_ended: launchEnded,
      },
    })
    await track(
      "dispute.resolved",
      {
        actorUserId: admin.id,
        subjectType: "dispute",
        subjectId: dispute.id,
        properties: { collab_id: dispute.collabId, kind: dispute.kind, outcome: input.outcome },
      },
      tx,
    )
    return {
      adjustmentId,
      launchEnded,
      notice: { dispute, memberIds, collabTitle: await loadCollabTitle(tx, dispute.collabId) },
    }
  }, db)

  if (after.slug) revalidateLaunchPage(after.slug)
  for (const entity of after.embeddings) await requestEmbeddingRefreshAfterCommit(entity)
  await notifyMembers(db, {
    type: "dispute.resolved",
    outcome: input.outcome,
    note: input.note,
    ...result.notice,
  })
  return { adjustmentId: result.adjustmentId, launchEnded: result.launchEnded }
}

/**
 * `collab_ended`: the collab → `ended` (reason `dispute`), an unsigned agreement terminated, a live
 * or paused launch ended (`by: "collab_ended"`), and, when the launch never went live, the idea
 * (`in_collab → open`) or an exclusive product (`in_collab → seeking`) back on offer.
 */
async function endCollabForDispute(
  tx: Tx,
  admin: AuthzUser,
  collabId: string,
): Promise<{
  launchEnded: boolean
  slug: string | null
  reopened: { type: "idea" | "product"; id: string }[]
}> {
  const [collab] = await tx
    .select({
      stage: collabs.stage,
      ideaId: collabs.ideaId,
      productId: collabs.productId,
    })
    .from(collabs)
    .where(eq(collabs.id, collabId))
    .for("update")
  if (!collab) throw new ActionError("That collab doesn't exist.")

  let launchEnded = false
  let slug: string | null = null
  let wentLive = false
  const [launchRow] = await tx
    .select({ id: launches.id })
    .from(launches)
    .where(eq(launches.collabId, collabId))
  if (launchRow) {
    const state = await lockLaunch(tx, launchRow.id)
    if (state) {
      wentLive = state.row.wentLiveAt !== null
      if (state.row.status !== "ended" && state.row.status !== "draft") {
        if (state.row.status === "live" || state.row.status === "paused") {
          await endLaunchInTx(tx, state, { actorUserId: admin.id, by: "collab_ended" })
          launchEnded = true
          slug = state.row.slug
        }
      }
    }
  }

  if (collab.stage !== "ended") {
    await changeCollabStage(tx, {
      collabId,
      from: collab.stage,
      to: "ended",
      actorUserId: admin.id,
      endedReason: "dispute",
    })
    const at = now()
    await tx
      .update(agreements)
      .set({ status: "terminated", terminatedAt: at })
      .where(and(eq(agreements.collabId, collabId), eq(agreements.status, "awaiting_signatures")))
  }

  const reopened: { type: "idea" | "product"; id: string }[] = []
  if (!wentLive) {
    if (collab.ideaId) {
      const rows = await tx
        .update(ideas)
        .set({ status: "open" })
        .where(and(eq(ideas.id, collab.ideaId), eq(ideas.status, "in_collab")))
        .returning({ id: ideas.id })
      if (rows.length > 0) reopened.push({ type: "idea", id: collab.ideaId })
    }
    if (collab.productId) {
      const rows = await tx
        .update(products)
        .set({ status: "seeking" })
        .where(and(eq(products.id, collab.productId), eq(products.status, "in_collab")))
        .returning({ id: products.id })
      if (rows.length > 0) reopened.push({ type: "product", id: collab.productId })
    }
  }
  return { launchEnded, slug, reopened }
}

/** Counts per status, for the overview and the list's tabs. */
export async function disputeCounts(db: DbOrTx): Promise<Record<DisputeStatus, number>> {
  const rows = await db
    .select({ status: disputes.status, n: sql<number>`count(*)::int` })
    .from(disputes)
    .groupBy(disputes.status)
  const counts: Record<DisputeStatus, number> = { open: 0, in_review: 0, resolved: 0 }
  for (const row of rows) counts[row.status] = row.n
  return counts
}

/** Names of users by id (admin pages: the dispute's adjustment lines). */
export async function userNames(db: DbOrTx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, ids))
  return new Map(rows.map((row) => [row.id, row.name ?? row.email ?? "Deleted user"]))
}
