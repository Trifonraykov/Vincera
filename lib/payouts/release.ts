import "server-only"

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"

import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { ledgerEntries, payoutBatches, transfers } from "@/lib/db/schema"
import { env } from "@/lib/env"
import { track } from "@/lib/events/track"
import { payableBalances, releaseFailedTransferEntries } from "@/lib/ledger/release"
import { reportError } from "@/lib/observability"
import type { MoneyGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"
import type { StripeTransfer } from "@/lib/stripe/money-shared"

import { notifyPayoutOutcome } from "./notifications"
import { runDeferredReversals } from "./reverse"
import type { StepRunner } from "./steps"

/**
 * The daily payout batch (§9 "Daily payout job", §13 `payouts/release`; CLAUDE.md §19.31 "Payout
 * batch", §19.35). Steps, each memoised by the job runner:
 *
 * 1. `open-batch`: open (or resume) the batch for `runKey` (default `daily:<UTC day>`), whose
 *    `cutoff_at` is the run's clock. A completed batch stops the run.
 * 2. `collect`: per payouts-ready active user and currency, the net of the available, unpaid,
 *    non-disputed entries (`payableBalances`); a net ≥ `MIN_PAYOUT_CENTS` gets a `pending`
 *    transfer and exactly those entries are marked with it, in one transaction per user. Then
 *    every `pending` transfer is listed, earlier batches' first (a crashed run's leftovers).
 * 3. `pay:<transferId>`: find the transfer at Stripe by its group (a retry whose idempotency key
 *    expired) or create it (`payout:<batchId>:<userId>`). Created → `created`, `payout.sent`;
 *    refused (`StripeGatewayError`) → `failed`, the entries released, `payout.failed`. Any other
 *    error throws, so the step is retried and nothing was marked.
 * 4. `notify:<transferId>`: the required `payout.sent` / `payout.failed` email (after the money
 *    transaction, never inside it).
 * 5. `close-batch`: counts, `completed`, `payout.batch_completed`.
 */

export type PayoutRunDeps = {
  db: DbOrTx
  gateway: Pick<MoneyGateway, "createTransfer" | "listTransfersByGroup" | "createTransferReversal">
  step: StepRunner
  /** Defaults to `MIN_PAYOUT_CENTS`. */
  minPayoutCents?: number
}

export type PayoutBatchSummary = {
  batchId: string
  runKey: string
  status: "completed" | "already_completed"
  transferCount: number
  totalCents: number
  failedCount: number
}

/** `daily:<YYYY-MM-DD>` of `at` in UTC. */
export function dailyRunKey(at: Date): string {
  return `daily:${at.toISOString().slice(0, 10)}`
}

/** The Stripe idempotency key of a payout transfer (§19.31); a non-EUR currency gets its own. */
export function payoutIdempotencyKey(transfer: {
  batchId: string
  userId: string
  currency: string
}): string {
  const base = `payout:${transfer.batchId}:${transfer.userId}`
  return transfer.currency === "eur" ? base : `${base}:${transfer.currency}`
}

export function payoutTransferGroup(transferId: string): string {
  return `payout_${transferId}`
}

export async function runPayoutBatch(
  deps: PayoutRunDeps,
  input: { runKey?: string } = {},
): Promise<PayoutBatchSummary> {
  const { db, step } = deps
  const minPayoutCents = deps.minPayoutCents ?? env.MIN_PAYOUT_CENTS

  const batch = await step.run("open-batch", () => openBatch(db, input.runKey))
  if (batch.completed) {
    const summary = await batchSummary(db, batch.id)
    return { ...summary, status: "already_completed" }
  }

  const pending = await step.run("collect", () =>
    collectTransfers(db, {
      batchId: batch.id,
      cutoffAt: new Date(batch.cutoffAt),
      minPayoutCents,
    }),
  )

  for (const transferId of pending) {
    await step.run(`pay:${transferId}`, () => payTransfer(db, deps.gateway, transferId))
    await step.run(`notify:${transferId}`, () => notifyPayoutOutcome(db, transferId))
    // Refunds that landed after collect: claw them back from the transfer just paid.
    await step.run(`reversals:${transferId}`, () =>
      runDeferredReversals(db, deps.gateway, transferId),
    )
  }

  return step.run("close-batch", () => closeBatch(db, batch.id))
}

/** Step 1: insert or find the batch; plain JSON (Inngest memoises step results as JSON). */
export async function openBatch(
  db: DbOrTx,
  runKey: string | undefined,
): Promise<{ id: string; runKey: string; cutoffAt: string; completed: boolean }> {
  const at = now()
  const key = runKey ?? dailyRunKey(at)
  await db
    .insert(payoutBatches)
    .values({ runKey: key, cutoffAt: at, startedAt: at })
    .onConflictDoNothing({ target: payoutBatches.runKey })
  const [batch] = await db.select().from(payoutBatches).where(eq(payoutBatches.runKey, key))
  if (!batch) throw new Error(`payout batch ${key} could not be opened`)
  return {
    id: batch.id,
    runKey: batch.runKey,
    cutoffAt: batch.cutoffAt.toISOString(),
    completed: batch.status !== "running",
  }
}

/**
 * Step 2: one `pending` transfer per (user, currency) with a payable balance, its entries marked
 * in the same transaction (the entries are locked by `payableBalances`, so a concurrent batch or
 * a reversal cannot take them too). Returns every `pending` transfer id, oldest first.
 */
export async function collectTransfers(
  db: DbOrTx,
  input: { batchId: string; cutoffAt: Date; minPayoutCents: number },
): Promise<string[]> {
  const { batchId, cutoffAt, minPayoutCents } = input
  // Who has something to pay; each user is then locked and re-read in their own transaction.
  const candidates = await withTransaction(
    (tx) => payableBalances(tx, { cutoffAt, minPayoutCents }),
    db,
  )
  const userIds = [...new Set(candidates.map((balance) => balance.userId))]

  for (const userId of userIds) {
    await withTransaction(async (tx) => {
      const balances = await payableBalances(tx, { cutoffAt, minPayoutCents, userId })
      for (const balance of balances) {
        const [inserted] = await tx
          .insert(transfers)
          .values({
            batchId,
            userId,
            destinationAccountId: balance.stripeAccountId,
            amountCents: balance.amountCents,
            currency: balance.currency,
            status: "pending",
          })
          .onConflictDoNothing({
            target: [transfers.batchId, transfers.userId, transfers.currency],
          })
          .returning({ id: transfers.id })
        // Already in this batch (a resumed run): its entries were marked with it then.
        if (!inserted) continue
        const marked = await tx
          .update(ledgerEntries)
          .set({ transferId: inserted.id })
          .where(and(inArray(ledgerEntries.id, balance.entryIds), isNull(ledgerEntries.transferId)))
          .returning({ id: ledgerEntries.id })
        if (marked.length !== balance.entryIds.length) {
          throw new Error(
            `transfer ${inserted.id}: marked ${marked.length} of ${balance.entryIds.length} entries`,
          )
        }
      }
    }, db)
  }

  const rows = await db
    .select({ id: transfers.id })
    .from(transfers)
    .where(eq(transfers.status, "pending"))
    .orderBy(asc(transfers.createdAt), asc(transfers.id))
  return rows.map((row) => row.id)
}

export type PayTransferResult =
  | { status: "created"; stripeTransferId: string }
  | { status: "failed"; failureCode: string }
  /** Not pending any more (a retried step after the outcome was saved). */
  | { status: "skipped"; current: string }

/** Step 3 for one transfer: create it at Stripe (or find it) and record the outcome. */
export async function payTransfer(
  db: DbOrTx,
  gateway: PayoutRunDeps["gateway"],
  transferId: string,
): Promise<PayTransferResult> {
  const [transfer] = await db.select().from(transfers).where(eq(transfers.id, transferId))
  if (!transfer) throw new Error(`transfer ${transferId} not found`)
  if (transfer.status !== "pending") return { status: "skipped", current: transfer.status }

  const group = payoutTransferGroup(transfer.id)
  let atStripe: StripeTransfer | undefined
  try {
    const found = await gateway.listTransfersByGroup(group)
    atStripe =
      found.find((candidate) => candidate.metadata?.transfer_id === transfer.id) ?? found[0]
    atStripe ??= await gateway.createTransfer(
      {
        amount: transfer.amountCents,
        currency: transfer.currency,
        destination: transfer.destinationAccountId,
        transferGroup: group,
        metadata: {
          transfer_id: transfer.id,
          batch_id: transfer.batchId,
          user_id: transfer.userId,
        },
      },
      { idempotencyKey: payoutIdempotencyKey(transfer) },
    )
  } catch (error) {
    if (!(error instanceof StripeGatewayError)) throw error
    if (error.code === "balance_insufficient") {
      // The platform's own balance is short: an operations problem, not the user's.
      reportError(error, { tags: { area: "payouts", code: error.code }, extra: { transferId } })
    }
    return recordFailure(db, transferId, error.code)
  }

  const stripeTransferId = atStripe.id
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(transfers)
      .set({ status: "created", stripeTransferId })
      .where(and(eq(transfers.id, transferId), eq(transfers.status, "pending")))
      .returning()
    if (!updated) {
      const [current] = await tx.select().from(transfers).where(eq(transfers.id, transferId))
      return { status: "skipped" as const, current: current?.status ?? "missing" }
    }
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transferId, transferId))
    await track(
      "payout.sent",
      {
        actorUserId: null,
        subjectType: "transfer",
        subjectId: transferId,
        properties: {
          amount_cents: updated.amountCents,
          currency: updated.currency,
          entry_count: count?.n ?? 0,
        },
      },
      tx,
    )
    return { status: "created" as const, stripeTransferId }
  }, db)
}

async function recordFailure(
  db: DbOrTx,
  transferId: string,
  failureCode: string,
): Promise<PayTransferResult> {
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(transfers)
      .set({ status: "failed", failureCode })
      .where(and(eq(transfers.id, transferId), eq(transfers.status, "pending")))
      .returning()
    if (!updated) {
      const [current] = await tx.select().from(transfers).where(eq(transfers.id, transferId))
      return { status: "skipped" as const, current: current?.status ?? "missing" }
    }
    // The money is payable again in a later batch (§19.31 step 4).
    await releaseFailedTransferEntries(tx, { transferId })
    await track(
      "payout.failed",
      {
        actorUserId: null,
        subjectType: "transfer",
        subjectId: transferId,
        properties: {
          amount_cents: updated.amountCents,
          currency: updated.currency,
          failure_code: failureCode,
        },
      },
      tx,
    )
    return { status: "failed" as const, failureCode }
  }, db)
}

async function batchSummary(
  db: DbOrTx,
  batchId: string,
): Promise<Omit<PayoutBatchSummary, "status">> {
  const [batch] = await db.select().from(payoutBatches).where(eq(payoutBatches.id, batchId))
  if (!batch) throw new Error(`payout batch ${batchId} not found`)
  return {
    batchId,
    runKey: batch.runKey,
    transferCount: batch.transferCount,
    totalCents: batch.totalCents,
    failedCount: batch.failedCount,
  }
}

/** Step 5: count what the batch paid and close it (once). */
export async function closeBatch(db: DbOrTx, batchId: string): Promise<PayoutBatchSummary> {
  return withTransaction(async (tx) => {
    const [counts] = await tx
      .select({
        paid: sql<number>`count(*) filter (where ${transfers.status} in ('created', 'partially_reversed', 'reversed'))::int`,
        total: sql<number>`coalesce(sum(${transfers.amountCents}) filter (where ${transfers.status} in ('created', 'partially_reversed', 'reversed')), 0)::int`,
        failed: sql<number>`count(*) filter (where ${transfers.status} = 'failed')::int`,
      })
      .from(transfers)
      .where(eq(transfers.batchId, batchId))
    const transferCount = counts?.paid ?? 0
    const totalCents = counts?.total ?? 0
    const failedCount = counts?.failed ?? 0

    const [closed] = await tx
      .update(payoutBatches)
      .set({ status: "completed", completedAt: now(), transferCount, totalCents, failedCount })
      .where(and(eq(payoutBatches.id, batchId), eq(payoutBatches.status, "running")))
      .returning()
    if (closed) {
      await track(
        "payout.batch_completed",
        {
          actorUserId: null,
          subjectType: "payout_batch",
          subjectId: batchId,
          properties: {
            transfer_count: transferCount,
            total_cents: totalCents,
            failed_count: failedCount,
          },
        },
        tx,
      )
    }
    const summary = await batchSummary(tx, batchId)
    return { ...summary, status: "completed" as const }
  }, db)
}
