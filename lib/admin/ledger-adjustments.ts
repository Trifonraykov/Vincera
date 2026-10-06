import "server-only"

import { eq, inArray } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { now } from "@/lib/clock"
import type { DbOrTx, Tx } from "@/lib/db/client"
import {
  collabMembers,
  disputes,
  launches,
  ledgerAdjustments,
  ledgerEntries,
  orders,
  users,
} from "@/lib/db/schema"
import { track } from "@/lib/events/track"

import { writeAdminAudit } from "./audit"
import { ADJUSTMENT_LINE_MAX_CENTS } from "./fields"

/**
 * Audited ledger adjustments (§9, §16 Phase 6 acceptance; CLAUDE.md §19.38 "Ledger adjustments").
 *
 * An adjustment moves money between ledger accounts with `adjustment` entries that **sum to
 * zero**, e.g. −€5 creator / +€5 builder, or +€5 member / −€5 platform (user null). Because the
 * sum is zero, `ledger:check`'s order invariant holds unchanged; `checkLedger` also flags any
 * adjustment whose entries do not sum to zero (`adjustment_sum`).
 *
 * Entries are `available_at = now`: payable in the next payout run; a negative line nets there.
 */

export type AdjustmentLine = { userId: string | null; amountCents: number }

export type CreateLedgerAdjustmentInput = {
  adminUserId: string
  disputeId?: string | null
  orderId?: string | null
  reason: string
  /** Lowercase ISO currency; the order's is used when `orderId` is given. */
  currency: string
  lines: readonly AdjustmentLine[]
}

export const ADJUSTMENT_ERRORS = {
  tooFewLines: "An adjustment needs at least two lines.",
  badAmount: "Every line needs an amount other than zero, in whole cents.",
  notBalanced: "The lines must add up to zero: what one side gets, another gives.",
  orderNotFound: "That order doesn't exist.",
  orderOtherCollab: "That order belongs to another collab.",
  notMember: "Lines can only name members of this collab (or the platform).",
  unknownUser: "One of the people on these lines doesn't exist.",
  disputeNotFound: "That dispute doesn't exist.",
  duplicateParty: "Name each person (and the platform) once.",
} as const

/** Pure checks: at least two lines, non-zero integer cents, each party once, Σ = 0. */
export function validateAdjustmentLines(lines: readonly AdjustmentLine[]): string | null {
  if (lines.length < 2) return ADJUSTMENT_ERRORS.tooFewLines
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.amountCents) ||
      line.amountCents === 0 ||
      Math.abs(line.amountCents) > ADJUSTMENT_LINE_MAX_CENTS
    ) {
      return ADJUSTMENT_ERRORS.badAmount
    }
  }
  const parties = new Set(lines.map((line) => line.userId ?? "platform"))
  if (parties.size !== lines.length) return ADJUSTMENT_ERRORS.duplicateParty
  const sum = lines.reduce((total, line) => total + line.amountCents, 0)
  if (sum !== 0) return ADJUSTMENT_ERRORS.notBalanced
  return null
}

/**
 * Write the adjustment in the caller's transaction: the `ledger_adjustments` row, one
 * `adjustment` entry per line, the audit row `ledger.adjusted` and the event. Throws
 * `ActionError` (plain language) for invalid input.
 */
export async function createLedgerAdjustment(
  tx: Tx,
  input: CreateLedgerAdjustmentInput,
): Promise<{ adjustmentId: string; entryIds: string[] }> {
  const problem = validateAdjustmentLines(input.lines)
  if (problem) throw new ActionError(problem)

  // The collab whose members may appear on the lines: the dispute's, else the order's launch's.
  let collabId: string | null = null
  if (input.disputeId) {
    const [dispute] = await tx
      .select({ collabId: disputes.collabId })
      .from(disputes)
      .where(eq(disputes.id, input.disputeId))
    if (!dispute) throw new ActionError(ADJUSTMENT_ERRORS.disputeNotFound)
    collabId = dispute.collabId
  }
  let currency = input.currency
  if (input.orderId) {
    const [order] = await tx
      .select({ currency: orders.currency, collabId: launches.collabId })
      .from(orders)
      .innerJoin(launches, eq(launches.id, orders.launchId))
      .where(eq(orders.id, input.orderId))
    if (!order) throw new ActionError(ADJUSTMENT_ERRORS.orderNotFound)
    if (collabId && order.collabId !== collabId) {
      throw new ActionError(ADJUSTMENT_ERRORS.orderOtherCollab)
    }
    collabId = order.collabId
    currency = order.currency
  }

  const userIds = input.lines.flatMap((line) => (line.userId ? [line.userId] : []))
  if (userIds.length > 0) {
    if (collabId) {
      const members = await tx
        .select({ userId: collabMembers.userId })
        .from(collabMembers)
        .where(eq(collabMembers.collabId, collabId))
      const memberIds = new Set(members.map((member) => member.userId))
      if (!userIds.every((id) => memberIds.has(id))) {
        throw new ActionError(ADJUSTMENT_ERRORS.notMember)
      }
    } else {
      const found = await tx.select({ id: users.id }).from(users).where(inArray(users.id, userIds))
      if (found.length !== new Set(userIds).size) {
        throw new ActionError(ADJUSTMENT_ERRORS.unknownUser)
      }
    }
  }

  const at = now()
  const [adjustment] = await tx
    .insert(ledgerAdjustments)
    .values({
      adminUserId: input.adminUserId,
      disputeId: input.disputeId ?? null,
      orderId: input.orderId ?? null,
      reason: input.reason,
      createdAt: at,
    })
    .returning({ id: ledgerAdjustments.id })
  if (!adjustment) throw new Error("ledger adjustment not inserted")

  const entries = await tx
    .insert(ledgerEntries)
    .values(
      input.lines.map((line) => ({
        orderId: input.orderId ?? null,
        userId: line.userId,
        account: "adjustment" as const,
        amountCents: line.amountCents,
        currency,
        availableAt: at,
        adjustmentId: adjustment.id,
        createdAt: at,
      })),
    )
    .returning({ id: ledgerEntries.id, amountCents: ledgerEntries.amountCents })
  // Belt and braces: the entries just written sum to zero (§9 "assert in code").
  if (entries.reduce((total, entry) => total + entry.amountCents, 0) !== 0) {
    throw new Error(`ledger adjustment ${adjustment.id} does not sum to zero`)
  }

  const moved = input.lines.reduce(
    (total, line) => total + (line.amountCents > 0 ? line.amountCents : 0),
    0,
  )
  await writeAdminAudit(tx, {
    adminUserId: input.adminUserId,
    action: "ledger.adjusted",
    targetType: "ledger_adjustment",
    targetId: adjustment.id,
    before: null,
    after: {
      dispute_id: input.disputeId ?? null,
      order_id: input.orderId ?? null,
      currency,
      lines: input.lines.map((line) => ({ user_id: line.userId, amount_cents: line.amountCents })),
      reason: input.reason,
    },
  })
  await track(
    "ledger.adjusted",
    {
      actorUserId: input.adminUserId,
      subjectType: "ledger_adjustment",
      subjectId: adjustment.id,
      properties: {
        dispute_id: input.disputeId ?? null,
        order_id: input.orderId ?? null,
        entry_count: entries.length,
        amount_cents: moved,
        currency,
      },
    },
    tx,
  )
  return { adjustmentId: adjustment.id, entryIds: entries.map((entry) => entry.id) }
}

export type AdjustmentView = {
  id: string
  createdAt: Date
  reason: string
  orderId: string | null
  disputeId: string | null
  lines: { userId: string | null; amountCents: number; currency: string }[]
}

/** Adjustments of a dispute (or every recent one), with their lines, newest first. */
export async function listAdjustments(
  db: DbOrTx,
  filter: { disputeId?: string; limit?: number } = {},
): Promise<AdjustmentView[]> {
  const rows = await db
    .select()
    .from(ledgerAdjustments)
    .where(filter.disputeId ? eq(ledgerAdjustments.disputeId, filter.disputeId) : undefined)
    .orderBy(ledgerAdjustments.createdAt)
    .limit(filter.limit ?? 50)
  if (rows.length === 0) return []
  const lines = await db
    .select({
      adjustmentId: ledgerEntries.adjustmentId,
      userId: ledgerEntries.userId,
      amountCents: ledgerEntries.amountCents,
      currency: ledgerEntries.currency,
    })
    .from(ledgerEntries)
    .where(
      inArray(
        ledgerEntries.adjustmentId,
        rows.map((row) => row.id),
      ),
    )
  return rows
    .map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      reason: row.reason,
      orderId: row.orderId,
      disputeId: row.disputeId,
      lines: lines
        .filter((line) => line.adjustmentId === row.id)
        .map(({ userId, amountCents, currency }) => ({ userId, amountCents, currency })),
    }))
    .reverse()
}
