import "server-only"

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"

import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { chargebacks, ledgerEntries, refunds, transferReversals, transfers } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { reportError } from "@/lib/observability"
import type { MoneyGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"

import type { StepRunner } from "./steps"

/**
 * Claw back money already paid out after a refund succeeded or a chargeback was lost (§9 "If the
 * original entries were already transferred, create a transfer reversal and record it";
 * CLAUDE.md §19.31 "Reversals", §19.35). Job `payouts-reverse`.
 *
 * - `plan`: per member whose sale entry of the order was paid (or collected for payment: a
 *   `pending` T, whose reversal runs after the batch pays T) by a transfer T, one
 *   `transfer_reversals` row (`pending`) for the member's unpaid mirror entries of this refund or
 *   chargeback (their sum, negated). Members whose share was not paid yet need nothing: their
 *   mirror nets in the next payout. A mirror larger than what is left of T is recorded `failed`
 *   (`exceeds_transfer`) and nets later too.
 * - `reverse:<id>`: one transaction that locks the reversal, T and the mirror entries, calls
 *   `createTransferReversal` (idempotency key `reversal:<reversalId>`) and records the outcome:
 *   `succeeded` → T's `amount_reversed_cents` and status, and the mirror entries get
 *   `transfer_id = T` (settled through T: Σ T's entries = amount − reversed); refused
 *   (`StripeGatewayError`, e.g. the connected balance was already paid out to the bank) → `failed`,
 *   the mirror stays unpaid and is netted against the next payout (§19.10). A payout batch that
 *   netted the mirror first (it locks the same entries) leaves nothing to reverse: `failed` with
 *   `netted_in_payout`, no Stripe call. The Stripe call happens while the locks are held, so a
 *   batch cannot net the mirror in between; a commit that fails after Stripe answered is retried
 *   with the same key, and Stripe replays the reversal.
 */

export type ReverseCause = "refund" | "chargeback"

const MEMBER_ACCOUNTS = ["creator_share", "builder_share"] as const

function causeColumn(cause: ReverseCause) {
  return cause === "refund" ? ledgerEntries.refundId : ledgerEntries.chargebackId
}

export async function runReversals(
  deps: { db: DbOrTx; gateway: Pick<MoneyGateway, "createTransferReversal">; step: StepRunner },
  input: { cause: ReverseCause; id: string },
): Promise<{ planned: number; succeeded: number; failed: number }> {
  const ids = await deps.step.run("plan", () => planReversals(deps.db, input))
  let succeeded = 0
  let failed = 0
  for (const reversalId of ids) {
    const outcome = await deps.step.run(`reverse:${reversalId}`, () =>
      executeReversal(deps.db, deps.gateway, reversalId),
    )
    if (outcome === "succeeded") succeeded += 1
    if (outcome === "failed") failed += 1
  }
  return { planned: ids.length, succeeded, failed }
}

/** Create (or find) the pending reversal rows; returns the ids still to execute. */
export async function planReversals(
  db: DbOrTx,
  input: { cause: ReverseCause; id: string },
): Promise<string[]> {
  return withTransaction(async (tx) => {
    const orderId = await postedCauseOrder(tx, input)
    if (!orderId) return []

    // The members' unpaid mirror entries of this cause, per member.
    const mirrors = await tx
      .select({
        userId: ledgerEntries.userId,
        cents: sql<number>`sum(${ledgerEntries.amountCents})::int`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(causeColumn(input.cause), input.id),
          isNotNull(ledgerEntries.userId),
          isNull(ledgerEntries.transferId),
          inArray(ledgerEntries.account, [...MEMBER_ACCOUNTS]),
        ),
      )
      .groupBy(ledgerEntries.userId)

    const pending: string[] = []
    for (const mirror of mirrors) {
      if (mirror.userId === null || mirror.cents >= 0) continue
      const amount = -mirror.cents

      // The transfer that paid this member's sale entry of the order (the latest that still
      // stands; a failed transfer's entries were released and paid again later).
      const [paid] = await tx
        .select({
          id: transfers.id,
          amountCents: transfers.amountCents,
          amountReversedCents: transfers.amountReversedCents,
          currency: transfers.currency,
        })
        .from(ledgerEntries)
        .innerJoin(transfers, eq(transfers.id, ledgerEntries.transferId))
        .where(
          and(
            eq(ledgerEntries.orderId, orderId),
            eq(ledgerEntries.userId, mirror.userId),
            isNull(ledgerEntries.refundId),
            isNull(ledgerEntries.chargebackId),
            inArray(ledgerEntries.account, [...MEMBER_ACCOUNTS]),
            sql`${ledgerEntries.amountCents} > 0`,
            // `pending`: a batch collected the entry and has not paid it yet; the reversal waits
            // for that transfer (`runDeferredReversals` after the batch's pay step).
            inArray(transfers.status, ["created", "partially_reversed", "pending"]),
          ),
        )
        .orderBy(desc(transfers.createdAt))
        .limit(1)
      if (!paid) continue

      const causeMatch =
        input.cause === "refund"
          ? eq(transferReversals.refundId, input.id)
          : eq(transferReversals.chargebackId, input.id)
      const [existing] = await tx
        .select({ id: transferReversals.id, status: transferReversals.status })
        .from(transferReversals)
        .where(and(eq(transferReversals.transferId, paid.id), causeMatch))
      if (existing) {
        if (existing.status === "pending") pending.push(existing.id)
        continue
      }

      const left = paid.amountCents - paid.amountReversedCents
      const exceeds = amount > left
      const [row] = await tx
        .insert(transferReversals)
        .values({
          transferId: paid.id,
          refundId: input.cause === "refund" ? input.id : null,
          chargebackId: input.cause === "chargeback" ? input.id : null,
          amountCents: amount,
          currency: paid.currency,
          status: exceeds ? "failed" : "pending",
          failureCode: exceeds ? "exceeds_transfer" : null,
        })
        .returning({ id: transferReversals.id })
      if (!row) throw new Error("transfer reversal not inserted")
      if (exceeds) {
        await trackReversed(tx, {
          transferId: paid.id,
          amount,
          currency: paid.currency,
          input,
          ok: false,
        })
      } else {
        pending.push(row.id)
      }
    }
    return pending
  }, db)
}

/** The order of a succeeded, posted refund or a lost, posted chargeback; else null. */
async function postedCauseOrder(
  tx: DbOrTx,
  input: { cause: ReverseCause; id: string },
): Promise<string | null> {
  if (input.cause === "refund") {
    const [row] = await tx
      .select({ orderId: refunds.orderId })
      .from(refunds)
      .where(
        and(
          eq(refunds.id, input.id),
          eq(refunds.status, "succeeded"),
          isNotNull(refunds.ledgerPostedAt),
        ),
      )
    return row?.orderId ?? null
  }
  const [row] = await tx
    .select({ orderId: chargebacks.orderId })
    .from(chargebacks)
    .where(
      and(
        eq(chargebacks.id, input.id),
        eq(chargebacks.status, "lost"),
        isNotNull(chargebacks.ledgerPostedAt),
      ),
    )
  return row?.orderId ?? null
}

export async function executeReversal(
  db: DbOrTx,
  gateway: Pick<MoneyGateway, "createTransferReversal">,
  reversalId: string,
): Promise<"succeeded" | "failed" | "skipped" | "deferred"> {
  return withTransaction(async (tx) => {
    const [reversal] = await tx
      .select()
      .from(transferReversals)
      .where(eq(transferReversals.id, reversalId))
      .for("update")
    if (!reversal) throw new Error(`transfer reversal ${reversalId} not found`)
    if (reversal.status !== "pending") return "skipped" as const

    const [transfer] = await tx
      .select()
      .from(transfers)
      .where(eq(transfers.id, reversal.transferId))
      .for("update")
    if (!transfer) throw new Error(`transfer ${reversal.transferId} not found`)
    // Collected but not paid yet: the batch's `reversals:<transferId>` step runs it once paid.
    if (transfer.status === "pending") return "deferred" as const
    const cause: ReverseCause = reversal.refundId ? "refund" : "chargeback"
    const causeId = reversal.refundId ?? reversal.chargebackId
    if (!causeId) throw new Error(`transfer reversal ${reversal.id} has no cause`)
    const input = { cause, id: causeId }

    const mirror = await tx
      .select({ id: ledgerEntries.id, amountCents: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .where(
        and(
          eq(causeColumn(cause), causeId),
          eq(ledgerEntries.userId, transfer.userId),
          isNull(ledgerEntries.transferId),
          inArray(ledgerEntries.account, [...MEMBER_ACCOUNTS]),
        ),
      )
      .for("update")
    const unpaid = -mirror.reduce((sum, entry) => sum + entry.amountCents, 0)

    const fail = async (failureCode: string) => {
      await tx
        .update(transferReversals)
        .set({ status: "failed", failureCode })
        .where(eq(transferReversals.id, reversal.id))
      await trackReversed(tx, {
        transferId: transfer.id,
        amount: reversal.amountCents,
        currency: reversal.currency,
        input,
        ok: false,
      })
      return "failed" as const
    }

    // The transfer was refused: its entries were released and the mirror nets in a later payout.
    if (transfer.status === "failed" || !transfer.stripeTransferId) return fail("transfer_failed")
    // A payout netted the mirror already (or it changed): nothing left to pull back.
    if (unpaid !== reversal.amountCents) return fail("netted_in_payout")
    if (reversal.amountCents > transfer.amountCents - transfer.amountReversedCents) {
      return fail("exceeds_transfer")
    }

    const stripeTransferId = transfer.stripeTransferId
    let created
    try {
      created = await gateway.createTransferReversal(
        {
          transferId: stripeTransferId,
          amount: reversal.amountCents,
          metadata: {
            transfer_reversal_id: reversal.id,
            ...(cause === "refund" ? { refund_id: causeId } : { chargeback_id: causeId }),
          },
        },
        { idempotencyKey: `reversal:${reversal.id}` },
      )
    } catch (error) {
      if (!(error instanceof StripeGatewayError)) throw error
      if (error.code !== "balance_insufficient") {
        reportError(error, {
          tags: { area: "payouts", phase: "reversal", code: error.code },
          extra: { reversalId: reversal.id, transferId: transfer.id },
        })
      }
      return fail(error.code)
    }

    const reversed = transfer.amountReversedCents + reversal.amountCents
    await tx
      .update(transferReversals)
      .set({ status: "succeeded", stripeReversalId: created.id, failureCode: null })
      .where(eq(transferReversals.id, reversal.id))
    await tx
      .update(transfers)
      .set({
        amountReversedCents: reversed,
        status: reversed >= transfer.amountCents ? "reversed" : "partially_reversed",
      })
      .where(eq(transfers.id, transfer.id))
    // Settled through T: T's entries now sum to amount − reversed.
    await tx
      .update(ledgerEntries)
      .set({ transferId: transfer.id })
      .where(
        and(
          inArray(
            ledgerEntries.id,
            mirror.map((entry) => entry.id),
          ),
          isNull(ledgerEntries.transferId),
        ),
      )
    await trackReversed(tx, {
      transferId: transfer.id,
      amount: reversal.amountCents,
      currency: reversal.currency,
      input,
      ok: true,
    })
    return "succeeded" as const
  }, db)
}

/**
 * Reversals planned while their transfer was still `pending` (a refund or lost chargeback that
 * landed between a batch's collect and pay steps, CLAUDE.md §19.37): run once the transfer is paid
 * (or fail them, `transfer_failed`, when it was refused). The payout batch calls it after each
 * transfer's pay step.
 */
export async function runDeferredReversals(
  db: DbOrTx,
  gateway: Pick<MoneyGateway, "createTransferReversal">,
  transferId: string,
): Promise<{ succeeded: number; failed: number }> {
  const waiting = await db
    .select({ id: transferReversals.id })
    .from(transferReversals)
    .where(
      and(eq(transferReversals.transferId, transferId), eq(transferReversals.status, "pending")),
    )
  let succeeded = 0
  let failed = 0
  for (const { id } of waiting) {
    const outcome = await executeReversal(db, gateway, id)
    if (outcome === "succeeded") succeeded += 1
    if (outcome === "failed") failed += 1
  }
  return { succeeded, failed }
}

async function trackReversed(
  tx: DbOrTx,
  input: {
    transferId: string
    amount: number
    currency: string
    input: { cause: ReverseCause }
    ok: boolean
  },
): Promise<void> {
  await track(
    "payout.reversed",
    {
      actorUserId: null,
      subjectType: "transfer",
      subjectId: input.transferId,
      properties: {
        amount_cents: input.amount,
        currency: input.currency,
        cause: input.input.cause,
        succeeded: input.ok,
      },
    },
    tx,
  )
}
