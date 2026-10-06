import "server-only"

import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"

import type { Tx } from "@/lib/db/client"
import { transferReversals, transfers } from "@/lib/db/schema"
import { reportError } from "@/lib/observability"
import {
  stripeTransferReversalSchema,
  stripeTransferSchema,
  type StripeTransferReversal,
} from "@/lib/stripe/money-shared"

/**
 * `transfer.reversed` (§7.2; CLAUDE.md §19.35): record reversals of our payout transfers.
 * Reversals the app made carry `metadata.transfer_reversal_id` and are recorded by the
 * `payouts-reverse` job, so they are skipped here (the job holds the transfer's row lock while it
 * calls Stripe, so this handler waits for it). Any other reversal was made in Stripe's dashboard:
 * it gets a `succeeded` row without a cause, the transfer's `amount_reversed_cents` follows, and
 * it is reported, because it has no ledger entries (the daily `ledger-check` flags the transfer
 * until an admin books an adjustment, Phase 6).
 */

/** The `transfer` object of `transfer.reversed`, with its (first page of) `reversals`. */
export const transferWithReversalsSchema = stripeTransferSchema.extend({
  reversals: z.object({ data: z.array(stripeTransferReversalSchema) }).nullish(),
})
export type TransferWithReversals = z.output<typeof transferWithReversalsSchema>

export async function recordStripeTransferReversals(
  tx: Tx,
  transfer: TransferWithReversals,
  context: { afterCommit: (task: () => Promise<void> | void) => void },
): Promise<{ status: "unknown_transfer" } | { status: "recorded"; external: number }> {
  const [ours] = await tx
    .select()
    .from(transfers)
    .where(eq(transfers.stripeTransferId, transfer.id))
    .for("update")
  if (!ours) return { status: "unknown_transfer" }

  const external: StripeTransferReversal[] = []
  for (const reversal of transfer.reversals?.data ?? []) {
    const ourId = reversal.metadata?.transfer_reversal_id
    if (ourId) {
      const [known] = await tx
        .select({ id: transferReversals.id })
        .from(transferReversals)
        .where(eq(transferReversals.id, ourId))
      if (known) continue
    }
    const [byStripeId] = await tx
      .select({ id: transferReversals.id })
      .from(transferReversals)
      .where(eq(transferReversals.stripeReversalId, reversal.id))
    if (byStripeId) continue
    external.push(reversal)
  }

  for (const reversal of external) {
    await tx
      .insert(transferReversals)
      .values({
        transferId: ours.id,
        stripeReversalId: reversal.id,
        amountCents: reversal.amount,
        currency: reversal.currency,
        status: "succeeded",
      })
      .onConflictDoNothing({ target: transferReversals.stripeReversalId })
  }

  if (external.length > 0) {
    const [sum] = await tx
      .select({ cents: sql<number>`coalesce(sum(${transferReversals.amountCents}), 0)::int` })
      .from(transferReversals)
      .where(
        and(eq(transferReversals.transferId, ours.id), eq(transferReversals.status, "succeeded")),
      )
    const reversed = Math.min(ours.amountCents, sum?.cents ?? 0)
    await tx
      .update(transfers)
      .set({
        amountReversedCents: reversed,
        status:
          ours.status === "failed"
            ? "failed"
            : reversed >= ours.amountCents
              ? "reversed"
              : reversed > 0
                ? "partially_reversed"
                : ours.status,
      })
      .where(eq(transfers.id, ours.id))
    const transferId = ours.id
    const count = external.length
    context.afterCommit(() => {
      reportError(new Error("Transfer reversed outside the app"), {
        tags: { area: "payouts", kind: "external_reversal" },
        extra: { transferId, reversals: count },
      })
    })
  }
  return { status: "recorded", external: external.length }
}
