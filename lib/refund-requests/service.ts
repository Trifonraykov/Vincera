import "server-only"

import { createElement } from "react"

import { and, asc, eq, inArray, sql } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { writeAdminAudit } from "@/lib/admin/audit"
import {
  canDecideRefundRequest,
  refundRequestRefusal,
  REFUND_REQUEST_WINDOW_DAYS,
  type AuthzUser,
  type RefundRequestRefusal,
} from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import {
  accessGrants,
  collabMembers,
  launches,
  orders,
  refundRequests,
  refunds,
} from "@/lib/db/schema"
import type { OrderStatus, RefundRequestReason, RefundRequestStatus } from "@/lib/db/schema/enums"
import { isAccessToken } from "@/lib/delivery/token"
import { sendEmail } from "@/lib/email/send"
import NotificationEmail from "@/lib/email/templates/notification"
import RefundRequestDeclinedEmail, {
  refundRequestDeclinedSubject,
} from "@/lib/email/templates/refund-request-declined"
import RefundRequestReceivedEmail, {
  refundRequestReceivedSubject,
} from "@/lib/email/templates/refund-request-received"
import { env } from "@/lib/env"
import { track } from "@/lib/events/track"
import { adminUserIds } from "@/lib/launches/queries"
import { formatMoney } from "@/lib/money"
import { notify } from "@/lib/notifications/notify"
import { reportError } from "@/lib/observability"
import { requestRefund, RefundRequestError } from "@/lib/refunds/request"
import type { MoneyGateway } from "@/lib/stripe/gateway"
import { absoluteUrl } from "@/lib/urls"

import { REFUND_REASON_LABELS, type RefundRequestForm } from "./fields"

/**
 * Buyer refund requests (v1, §12 `/access/[token]/refund`; CLAUDE.md §19.38).
 *
 * - Buyers have no account: the access token proves the purchase. Eligibility is
 *   `refundRequestRefusal` (one request per order, ever; within the window; not for revoked
 *   access, disputed orders or orders refunded in full), checked again under the order's lock.
 * - Submitting writes the request (`amount` = gross − refunded) and `refund_request.created`
 *   (actor null) in one transaction; after the commit the buyer gets a confirmation email and the
 *   members and every active admin a notification.
 * - An admin approves (`requestRefund`, the existing refund path, then the request is marked
 *   `approved` with its `refund_id`) or declines with a note the buyer receives.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export type BuyerRefundContext = {
  launchTitle: string
  slug: string
  orderId: string
  accessGrantId: string
  paidAt: Date
  currency: string
  /** What is left to refund (gross − refunded), integer cents. */
  amountLeftCents: number
  windowEndsAt: Date
  /** Why the buyer cannot ask now; null when they can. */
  refusal: RefundRequestRefusal | null
  request: {
    status: RefundRequestStatus
    reason: RefundRequestReason
    amountCents: number
    createdAt: Date
  } | null
}

type GrantRow = {
  grantId: string
  revokedAt: Date | null
  orderId: string
  orderStatus: OrderStatus
  paidAt: Date
  gross: number
  refunded: number
  currency: string
  launchId: string
  launchTitle: string
  slug: string
  collabId: string
  buyerEmail: string
}

async function loadGrant(database: DbOrTx, token: string, lock: boolean): Promise<GrantRow | null> {
  if (!isAccessToken(token)) return null
  const query = database
    .select({
      grantId: accessGrants.id,
      revokedAt: accessGrants.revokedAt,
      orderId: orders.id,
      orderStatus: orders.status,
      paidAt: orders.paidAt,
      gross: orders.amountGrossCents,
      refunded: orders.amountRefundedCents,
      currency: orders.currency,
      launchId: launches.id,
      launchTitle: launches.title,
      slug: launches.slug,
      collabId: launches.collabId,
      buyerEmail: orders.buyerEmail,
    })
    .from(accessGrants)
    .innerJoin(orders, eq(orders.id, accessGrants.orderId))
    .innerJoin(launches, eq(launches.id, orders.launchId))
    .where(eq(accessGrants.token, token))
  const [row] = lock ? await query.for("update", { of: orders }) : await query
  return row ?? null
}

async function existingRequest(database: DbOrTx, orderId: string) {
  const [row] = await database
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      amountCents: refundRequests.amountCents,
      createdAt: refundRequests.createdAt,
    })
    .from(refundRequests)
    .where(eq(refundRequests.orderId, orderId))
  return row ?? null
}

function refusalFor(grant: GrantRow, hasRequest: boolean, at: Date) {
  return refundRequestRefusal(
    {
      orderStatus: grant.orderStatus,
      paidAt: grant.paidAt,
      amountGrossCents: grant.gross,
      amountRefundedCents: grant.refunded,
      grantRevoked: grant.revokedAt !== null,
      hasRequest,
    },
    at,
  )
}

/** What `/access/[token]/refund` shows; null for an unknown token (404). */
export async function loadBuyerRefundContext(
  database: DbOrTx,
  token: string,
  at: Date = now(),
): Promise<BuyerRefundContext | null> {
  const grant = await loadGrant(database, token, false)
  if (!grant) return null
  const request = await existingRequest(database, grant.orderId)
  return {
    launchTitle: grant.launchTitle,
    slug: grant.slug,
    orderId: grant.orderId,
    accessGrantId: grant.grantId,
    paidAt: grant.paidAt,
    currency: grant.currency,
    amountLeftCents: Math.max(0, grant.gross - grant.refunded),
    windowEndsAt: new Date(grant.paidAt.getTime() + REFUND_REQUEST_WINDOW_DAYS * DAY_MS),
    refusal: refusalFor(grant, request !== null, at),
    request: request
      ? {
          status: request.status,
          reason: request.reason,
          amountCents: request.amountCents,
          createdAt: request.createdAt,
        }
      : null,
  }
}

export type SubmitRefundResult =
  | { status: "created"; requestId: string }
  | { status: "refused"; refusal: RefundRequestRefusal }
  | { status: "not_found" }

/**
 * Write a buyer's refund request. Notifications are sent after the commit
 * (`notifyRefundRequested`), never inside the transaction.
 */
export async function submitRefundRequest(
  database: DbOrTx,
  input: { token: string } & RefundRequestForm,
): Promise<SubmitRefundResult> {
  const result = await withTransaction(async (tx): Promise<SubmitRefundResult> => {
    const grant = await loadGrant(tx, input.token, true)
    if (!grant) return { status: "not_found" }
    const at = now()
    const request = await existingRequest(tx, grant.orderId)
    const refusal = refusalFor(grant, request !== null, at)
    if (refusal) return { status: "refused", refusal }
    const amount = grant.gross - grant.refunded
    const [row] = await tx
      .insert(refundRequests)
      .values({
        orderId: grant.orderId,
        accessGrantId: grant.grantId,
        reason: input.reason,
        message: input.message ?? null,
        amountCents: amount,
        currency: grant.currency,
      })
      .onConflictDoNothing({ target: refundRequests.orderId })
      .returning({ id: refundRequests.id })
    if (!row) return { status: "refused", refusal: "already_requested" }
    await track(
      "refund_request.created",
      {
        actorUserId: null,
        subjectType: "refund_request",
        subjectId: row.id,
        properties: {
          order_id: grant.orderId,
          launch_id: grant.launchId,
          reason: input.reason,
          amount_cents: amount,
          currency: grant.currency,
          days_after_purchase: Math.max(
            0,
            Math.floor((at.getTime() - grant.paidAt.getTime()) / DAY_MS),
          ),
        },
      },
      tx,
    )
    return { status: "created", requestId: row.id }
  }, database)
  return result
}

type RequestDetails = {
  id: string
  status: RefundRequestStatus
  reason: RefundRequestReason
  message: string | null
  amountCents: number
  currency: string
  decisionNote: string | null
  orderId: string
  buyerEmail: string
  launchId: string
  launchTitle: string
  collabId: string
}

async function loadRequestDetails(
  database: DbOrTx,
  requestId: string,
  lock = false,
): Promise<RequestDetails | null> {
  const query = database
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      message: refundRequests.message,
      amountCents: refundRequests.amountCents,
      currency: refundRequests.currency,
      decisionNote: refundRequests.decisionNote,
      orderId: orders.id,
      buyerEmail: orders.buyerEmail,
      launchId: launches.id,
      launchTitle: launches.title,
      collabId: launches.collabId,
    })
    .from(refundRequests)
    .innerJoin(orders, eq(orders.id, refundRequests.orderId))
    .innerJoin(launches, eq(launches.id, orders.launchId))
    .where(eq(refundRequests.id, requestId))
  const [row] = lock ? await query.for("update", { of: refundRequests }) : await query
  return row ?? null
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * After a request commits: the buyer's confirmation (`sendEmail`, key
 * `refund-request-received:<id>`), `refund.requested` to both members and
 * `admin.refund_requested` to every active admin (dedupe `<type>:<id>:<userId>`). Each failure is
 * reported and the rest still go out.
 */
export async function notifyRefundRequested(database: DbOrTx, requestId: string): Promise<void> {
  const request = await loadRequestDetails(database, requestId)
  if (!request) return
  const amount = formatMoney(request.amountCents, request.currency)
  const payload = {
    collab_id: request.collabId,
    launch_id: request.launchId,
    launch_title: clip(request.launchTitle),
    order_id: request.orderId,
    amount_cents: request.amountCents,
    currency: request.currency,
    refund_request_id: request.id,
  }
  const attempt = async (step: string, task: () => Promise<unknown>) => {
    try {
      await task()
    } catch (error) {
      reportError(error, { tags: { area: "refund_requests", step } })
    }
  }

  await attempt("buyer_email", () =>
    sendEmail({
      to: request.buyerEmail,
      subject: refundRequestReceivedSubject(clip(request.launchTitle)),
      react: createElement(RefundRequestReceivedEmail, {
        appName: env.APP_NAME,
        productTitle: request.launchTitle,
        amountCents: request.amountCents,
        currency: request.currency,
      }),
      tags: { template: "refund_request_received" },
      idempotencyKey: `refund-request-received:${request.id}`,
    }),
  )

  const members = await database
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, request.collabId))
  for (const member of members) {
    await attempt("member_notice", () =>
      notify(
        {
          userId: member.userId,
          type: "refund.requested",
          payload,
          dedupeKey: `refund.requested:${request.id}:${member.userId}`,
          email: {
            subject: `A buyer asked for a refund of “${clip(request.launchTitle)}”`,
            react: createElement(NotificationEmail, {
              appName: env.APP_NAME,
              heading: "A buyer asked for a refund",
              paragraphs: [
                `A buyer of “${request.launchTitle}” asked for a refund of ${amount}. Their reason: ${REFUND_REASON_LABELS[request.reason].toLowerCase()}.`,
                "Our team decides and lets you know. If it is approved, your share of the sale is taken back from your earnings.",
              ],
              action: { label: "Open your earnings", url: absoluteUrl("/app/earnings") },
            }),
          },
        },
        database,
      ),
    )
  }

  for (const adminId of await adminUserIds(database)) {
    await attempt("admin_notice", () =>
      notify(
        {
          userId: adminId,
          type: "admin.refund_requested",
          payload,
          dedupeKey: `admin.refund_requested:${request.id}:${adminId}`,
          email: {
            subject: `Refund request: ${amount} on “${clip(request.launchTitle)}”`,
            react: createElement(NotificationEmail, {
              appName: env.APP_NAME,
              heading: "A buyer asked for a refund",
              paragraphs: [
                `${amount} on “${request.launchTitle}”. Reason: ${REFUND_REASON_LABELS[request.reason].toLowerCase()}.`,
                "Approve or decline it in the admin area.",
              ],
              action: {
                label: "Review the request",
                url: absoluteUrl("/admin/payouts#refund-requests"),
              },
            }),
          },
        },
        database,
      ),
    )
  }
}

// --- Admin decisions ---------------------------------------------------------------------------

export const REFUND_DECISION_ERRORS = {
  notFound: "This refund request doesn't exist.",
  decided: "This request was already decided.",
} as const

/** What is still refundable on an order: gross − refunded − refunds in flight. */
async function refundableLeft(database: DbOrTx, orderId: string): Promise<number> {
  const [order] = await database
    .select({ gross: orders.amountGrossCents, refunded: orders.amountRefundedCents })
    .from(orders)
    .where(eq(orders.id, orderId))
  if (!order) return 0
  const [inFlight] = await database
    .select({ cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
    .from(refunds)
    .where(
      and(eq(refunds.orderId, orderId), inArray(refunds.status, ["pending", "requires_action"])),
    )
  return order.gross - order.refunded - Number(inFlight?.cents ?? 0)
}

/**
 * Approve: refund `min(request, what is left)` through `requestRefund` (which locks the order and
 * refuses anything already refunded, so two admins approving at once refund once), then mark the
 * request `approved` with its `refund_id`, the audit row and the event in one transaction. A
 * refused refund leaves the request pending and throws the plain reason. The refund path itself
 * emails the buyer and notifies the members once the refund succeeds.
 */
export async function approveRefundRequest(
  database: DbOrTx,
  input: { requestId: string; admin: AuthzUser; note?: string },
  deps: { gateway: Pick<MoneyGateway, "createRefund"> },
): Promise<{ refundId: string; amountCents: number }> {
  const request = await loadRequestDetails(database, input.requestId)
  if (!request) throw new ActionError(REFUND_DECISION_ERRORS.notFound)
  if (!canDecideRefundRequest(input.admin, request)) {
    throw new ActionError(REFUND_DECISION_ERRORS.decided)
  }
  const left = await refundableLeft(database, request.orderId)
  const amount = Math.min(request.amountCents, left)
  if (amount <= 0) {
    throw new ActionError(
      "Nothing is left to refund on this order. Decline the request with a note to the buyer.",
    )
  }

  let refundId: string
  try {
    const result = await requestRefund(
      database,
      {
        orderId: request.orderId,
        amountCents: amount,
        requestedByUserId: input.admin.id,
        reason: "requested_by_customer",
      },
      deps,
    )
    if (result.status === "refused") {
      throw new ActionError(
        `Stripe refused the refund (${result.failureCode.replaceAll("_", " ")}). The request stays open.`,
      )
    }
    refundId = result.refundId
  } catch (error) {
    if (error instanceof RefundRequestError) throw new ActionError(error.message)
    throw error
  }

  await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(refundRequests)
      .set({
        status: "approved",
        refundId,
        decidedByUserId: input.admin.id,
        decidedAt: now(),
        decisionNote: input.note ?? null,
      })
      .where(and(eq(refundRequests.id, request.id), eq(refundRequests.status, "pending")))
      .returning({ id: refundRequests.id })
    if (!updated) {
      // Decided by someone else while the refund ran; the refund itself stands.
      reportError(new Error("Refund request decided twice"), {
        tags: { area: "refund_requests" },
        extra: { requestId: request.id, refundId },
      })
      return
    }
    await writeAdminAudit(tx, {
      adminUserId: input.admin.id,
      action: "refund_request.approved",
      targetType: "refund_request",
      targetId: request.id,
      before: { status: "pending" },
      after: { status: "approved", refund_id: refundId, amount_cents: amount },
    })
    await track(
      "refund_request.approved",
      {
        actorUserId: input.admin.id,
        subjectType: "refund_request",
        subjectId: request.id,
        properties: { order_id: request.orderId, refund_id: refundId },
      },
      tx,
    )
  }, database)
  return { refundId, amountCents: amount }
}

/** Decline with a note; the buyer gets it by email after the commit. */
export async function declineRefundRequest(
  database: DbOrTx,
  input: { requestId: string; admin: AuthzUser; note: string },
): Promise<void> {
  const request = await withTransaction(async (tx) => {
    const row = await loadRequestDetails(tx, input.requestId, true)
    if (!row) throw new ActionError(REFUND_DECISION_ERRORS.notFound)
    if (!canDecideRefundRequest(input.admin, row)) {
      throw new ActionError(REFUND_DECISION_ERRORS.decided)
    }
    await tx
      .update(refundRequests)
      .set({
        status: "declined",
        decidedByUserId: input.admin.id,
        decidedAt: now(),
        decisionNote: input.note,
      })
      .where(eq(refundRequests.id, row.id))
    await writeAdminAudit(tx, {
      adminUserId: input.admin.id,
      action: "refund_request.declined",
      targetType: "refund_request",
      targetId: row.id,
      before: { status: "pending" },
      after: { status: "declined" },
    })
    await track(
      "refund_request.declined",
      {
        actorUserId: input.admin.id,
        subjectType: "refund_request",
        subjectId: row.id,
        properties: { order_id: row.orderId },
      },
      tx,
    )
    return row
  }, database)

  try {
    await sendEmail({
      to: request.buyerEmail,
      subject: refundRequestDeclinedSubject(clip(request.launchTitle)),
      react: createElement(RefundRequestDeclinedEmail, {
        appName: env.APP_NAME,
        productTitle: request.launchTitle,
        amountCents: request.amountCents,
        currency: request.currency,
        note: input.note,
      }),
      tags: { template: "refund_request_declined" },
      idempotencyKey: `refund-request-declined:${request.id}`,
    })
  } catch (error) {
    reportError(error, { tags: { area: "refund_requests", step: "declined_email" } })
  }
}

// --- Admin list ----------------------------------------------------------------------------------

export type PendingRefundRequest = {
  id: string
  reason: RefundRequestReason
  message: string | null
  amountCents: number
  currency: string
  createdAt: Date
  orderId: string
  paidAt: Date
  orderGrossCents: number
  orderRefundedCents: number
  orderStatus: OrderStatus
  launchId: string
  launchTitle: string
  collabId: string
}

/** Pending requests, oldest first (the queue on `/admin/payouts#refund-requests`). */
export async function listPendingRefundRequests(
  database: DbOrTx,
  limit = 50,
): Promise<PendingRefundRequest[]> {
  return database
    .select({
      id: refundRequests.id,
      reason: refundRequests.reason,
      message: refundRequests.message,
      amountCents: refundRequests.amountCents,
      currency: refundRequests.currency,
      createdAt: refundRequests.createdAt,
      orderId: orders.id,
      paidAt: orders.paidAt,
      orderGrossCents: orders.amountGrossCents,
      orderRefundedCents: orders.amountRefundedCents,
      orderStatus: orders.status,
      launchId: launches.id,
      launchTitle: launches.title,
      collabId: launches.collabId,
    })
    .from(refundRequests)
    .innerJoin(orders, eq(orders.id, refundRequests.orderId))
    .innerJoin(launches, eq(launches.id, orders.launchId))
    .where(eq(refundRequests.status, "pending"))
    .orderBy(asc(refundRequests.createdAt))
    .limit(limit)
}
