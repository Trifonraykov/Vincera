import "server-only"

import { and, asc, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm"

import type { DbOrTx, Tx } from "@/lib/db/client"
import { ledgerEntries, orders, stripeAccounts, transfers, users } from "@/lib/db/schema"

import { LedgerError } from "./errors"
import { assertLinesSum } from "./split"
import type { PayableBalance, ReleaseFailedTransferResult, UserBalance } from "./types"

/**
 * Balances (§9 "Daily payout job"; CLAUDE.md §19.31 "Payout batch", §19.33). Owner: the ledger;
 * the payouts builder runs the batch with these.
 */

/**
 * What the payout job may pay at `cutoffAt`: per user and currency, the net of the entries with
 * `transfer_id IS NULL` and `available_at <= cutoffAt`, whose order is not `disputed` (a chargeback
 * freezes them, §9). Negative entries count too (a refund after a payout nets against the next one,
 * §19.10). Only active users with a payouts-ready account (payouts enabled, transfers active), and
 * only nets ≥ `minPayoutCents` and > 0.
 *
 * The entries are locked (`FOR UPDATE OF ledger_entries`): run it in the transaction that inserts
 * the transfer row and marks exactly `entryIds` with it, so a concurrent batch cannot pay them too.
 * Results are ordered by user id, then currency.
 */
export async function payableBalances(
  db: DbOrTx,
  options: { cutoffAt: Date; minPayoutCents: number; userId?: string },
): Promise<PayableBalance[]> {
  const { cutoffAt, minPayoutCents } = options
  if (!Number.isSafeInteger(minPayoutCents) || minPayoutCents < 0) {
    throw new LedgerError("invalid_input", `minPayoutCents must be ≥ 0, got ${minPayoutCents}`)
  }

  const rows = await db
    .select({
      id: ledgerEntries.id,
      userId: ledgerEntries.userId,
      currency: ledgerEntries.currency,
      amountCents: ledgerEntries.amountCents,
      stripeAccountId: stripeAccounts.stripeAccountId,
    })
    .from(ledgerEntries)
    .innerJoin(users, eq(users.id, ledgerEntries.userId))
    .innerJoin(stripeAccounts, eq(stripeAccounts.userId, ledgerEntries.userId))
    .leftJoin(orders, eq(orders.id, ledgerEntries.orderId))
    .where(
      and(
        isNull(ledgerEntries.transferId),
        isNotNull(ledgerEntries.userId),
        lte(ledgerEntries.availableAt, cutoffAt),
        or(isNull(ledgerEntries.orderId), ne(orders.status, "disputed")),
        eq(users.status, "active"),
        eq(stripeAccounts.payoutsEnabled, true),
        eq(stripeAccounts.transfersCapability, "active"),
        options.userId ? eq(ledgerEntries.userId, options.userId) : undefined,
      ),
    )
    .orderBy(asc(ledgerEntries.userId), asc(ledgerEntries.currency), asc(ledgerEntries.id))
    .for("update", { of: ledgerEntries })

  const balances = new Map<string, PayableBalance>()
  for (const row of rows) {
    if (row.userId === null) continue
    const key = `${row.userId}:${row.currency}`
    let balance = balances.get(key)
    if (!balance) {
      balance = {
        userId: row.userId,
        currency: row.currency,
        stripeAccountId: row.stripeAccountId,
        amountCents: 0,
        entryIds: [],
      }
      balances.set(key, balance)
    }
    balance.amountCents += row.amountCents
    balance.entryIds.push(row.id)
  }
  return [...balances.values()].filter(
    (balance) => balance.amountCents > 0 && balance.amountCents >= minPayoutCents,
  )
}

/**
 * A user's money at `at`, per currency (for `/app/earnings`): `pending` (still in the hold
 * period), `available` (payable now), `onHold` (frozen by an open chargeback), `paidOut` (net of
 * entries paid by transfers; a failed transfer's entries net to zero). Platform entries never
 * count. Payouts-readiness and `MIN_PAYOUT_CENTS` are not applied: this is what the user has
 * earned, not what the next batch pays.
 */
export async function userBalances(
  db: DbOrTx,
  options: { userId: string; at: Date },
): Promise<UserBalance[]> {
  const disputed = sql`coalesce(${orders.status} = 'disputed', false)`
  const unpaid = sql`${ledgerEntries.transferId} IS NULL`
  const rows = await db
    .select({
      currency: ledgerEntries.currency,
      pending: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${unpaid} and not ${disputed} and ${ledgerEntries.availableAt} > ${options.at}), 0)`,
      available: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${unpaid} and not ${disputed} and ${ledgerEntries.availableAt} <= ${options.at}), 0)`,
      onHold: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${unpaid} and ${disputed}), 0)`,
      paidOut: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.transferId} IS NOT NULL), 0)`,
    })
    .from(ledgerEntries)
    .leftJoin(orders, eq(orders.id, ledgerEntries.orderId))
    .where(eq(ledgerEntries.userId, options.userId))
    .groupBy(ledgerEntries.currency)
    .orderBy(asc(ledgerEntries.currency))

  return rows.map((row) => ({
    currency: row.currency,
    pendingCents: Number(row.pending),
    availableCents: Number(row.available),
    onHoldCents: Number(row.onHold),
    paidOutCents: Number(row.paidOut),
  }))
}

/**
 * A transfer Stripe refused (§19.31 "Payout batch" step 4): make its entries payable again without
 * changing any row. For each entry marked with the transfer: a mirror (−amount, same references,
 * `transfer_id` = the failed transfer) and a re-issue (+amount, same references, `transfer_id`
 * null, same `available_at`). The failed transfer's entries then sum to 0 and the user's balance
 * is unchanged. The transfer must already be `failed`. Idempotent: entries that net to zero are
 * `already_released`.
 */
export async function releaseFailedTransferEntries(
  tx: Tx,
  input: { transferId: string },
): Promise<ReleaseFailedTransferResult> {
  const [transfer] = await tx
    .select({ id: transfers.id, status: transfers.status })
    .from(transfers)
    .where(eq(transfers.id, input.transferId))
    .for("update")
  if (!transfer) throw new LedgerError("not_found", `transfer ${input.transferId} not found`)
  if (transfer.status !== "failed") {
    throw new LedgerError(
      "invalid_state",
      `transfer ${transfer.id} is ${transfer.status}; only failed transfers are released`,
    )
  }

  const marked = await tx
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transferId, transfer.id))
    .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id))
  if (marked.length === 0) return { status: "nothing_to_release" }
  const total = marked.reduce((sum, entry) => sum + entry.amountCents, 0)
  if (total === 0) return { status: "already_released" }

  const refs = (entry: (typeof marked)[number]) => ({
    orderId: entry.orderId,
    refundId: entry.refundId,
    chargebackId: entry.chargebackId,
    userId: entry.userId,
    account: entry.account,
    currency: entry.currency,
    availableAt: entry.availableAt,
  })
  const mirrors = marked.map((entry) => ({
    ...refs(entry),
    amountCents: -entry.amountCents,
    transferId: transfer.id,
  }))
  const reissues = marked.map((entry) => ({
    ...refs(entry),
    amountCents: entry.amountCents,
    transferId: null,
  }))
  assertLinesSum([...marked, ...mirrors], 0, "failed transfer release")
  await tx.insert(ledgerEntries).values([...mirrors, ...reissues])
  return { status: "released", entryCount: marked.length, amountCents: total }
}
