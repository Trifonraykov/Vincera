import "server-only"

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  collabMembers,
  launches,
  ledgerEntries,
  orders,
  stripeAccounts,
  transfers,
} from "@/lib/db/schema"
import type { OrderStatus, TransferStatus } from "@/lib/db/schema/enums"
import { userBalances } from "@/lib/ledger/release"
import type { UserBalance } from "@/lib/ledger/types"
import { payoutsStateOf } from "@/lib/payouts/readiness"

/**
 * What `/app/earnings` and `/app/earnings/payouts` show (§12; CLAUDE.md §19.31, §19.35): one
 * user's own money only. Amounts, dates and launch titles; never a buyer's email or another
 * member's share.
 */

const MEMBER_ACCOUNTS = ["creator_share", "builder_share"] as const

export type PendingRelease = { date: string; currency: string; amountCents: number }

export type LaunchEarnings = {
  launchId: string
  title: string
  slug: string
  currency: string
  orderCount: number
  /** The user's share of the sales. */
  earnedCents: number
  /** Given back for refunds and lost chargebacks (≤ 0). */
  refundedCents: number
}

export type RecentSale = {
  orderId: string
  launchTitle: string
  paidAt: Date
  currency: string
  grossCents: number
  refundedCents: number
  status: OrderStatus
  /** The user's share of the sale; null while the Stripe fee is not known yet ("fee pending"). */
  shareCents: number | null
}

export type EarningsOverview = {
  balances: UserBalance[]
  /** Upcoming releases from the hold period, by UTC day. */
  releases: PendingRelease[]
  launches: LaunchEarnings[]
  recentSales: RecentSale[]
  /** Sales whose ledger is not posted yet (the fee is still pending at Stripe). */
  feePendingCount: number
  payouts: "none" | "pending" | "ready"
}

export async function loadEarningsOverview(
  db: DbOrTx,
  input: { userId: string; at: Date },
): Promise<EarningsOverview> {
  const { userId, at } = input
  const [balances, releases, launchRows, recentSales, feePending, account] = await Promise.all([
    userBalances(db, { userId, at }),
    db
      .select({
        date: sql<string>`to_char(${ledgerEntries.availableAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        currency: ledgerEntries.currency,
        amountCents: sql<number>`sum(${ledgerEntries.amountCents})::int`,
      })
      .from(ledgerEntries)
      .leftJoin(orders, eq(orders.id, ledgerEntries.orderId))
      .where(
        and(
          eq(ledgerEntries.userId, userId),
          isNull(ledgerEntries.transferId),
          gt(ledgerEntries.availableAt, at),
          sql`coalesce(${orders.status} <> 'disputed', true)`,
        ),
      )
      .groupBy(sql`1`, ledgerEntries.currency)
      .orderBy(sql`1`)
      .limit(10),
    db
      .select({
        launchId: launches.id,
        title: launches.title,
        slug: launches.slug,
        currency: ledgerEntries.currency,
        orderCount: sql<number>`count(distinct ${orders.id})::int`,
        earnedCents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.refundId} is null and ${ledgerEntries.chargebackId} is null), 0)::int`,
        refundedCents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.refundId} is not null or ${ledgerEntries.chargebackId} is not null), 0)::int`,
      })
      .from(ledgerEntries)
      .innerJoin(orders, eq(orders.id, ledgerEntries.orderId))
      .innerJoin(launches, eq(launches.id, orders.launchId))
      .where(
        and(
          eq(ledgerEntries.userId, userId),
          inArray(ledgerEntries.account, [...MEMBER_ACCOUNTS]),
          // A failed transfer's release lines (mirror + re-issue) cancel out; leave them out.
          sql`not exists (select 1 from ${transfers} t where t.id = ${ledgerEntries.transferId} and t.status = 'failed')`,
        ),
      )
      .groupBy(launches.id, launches.title, launches.slug, ledgerEntries.currency)
      .orderBy(desc(sql`3`), asc(launches.title)),
    recentSalesOf(db, userId),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .innerJoin(launches, eq(launches.id, orders.launchId))
      .innerJoin(collabMembers, eq(collabMembers.collabId, launches.collabId))
      .where(and(eq(collabMembers.userId, userId), isNull(orders.ledgerPostedAt))),
    db
      .select({
        payoutsEnabled: stripeAccounts.payoutsEnabled,
        transfersCapability: stripeAccounts.transfersCapability,
      })
      .from(stripeAccounts)
      .where(eq(stripeAccounts.userId, userId)),
  ])

  return {
    balances,
    releases,
    launches: launchRows,
    recentSales,
    feePendingCount: feePending[0]?.n ?? 0,
    payouts: payoutsStateOf(account[0] ?? null),
  }
}

/** The newest 20 orders of the user's launches, with the user's own share of each. */
async function recentSalesOf(db: DbOrTx, userId: string): Promise<RecentSale[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      launchTitle: launches.title,
      paidAt: orders.paidAt,
      currency: orders.currency,
      grossCents: orders.amountGrossCents,
      refundedCents: orders.amountRefundedCents,
      status: orders.status,
      posted: isNotNull(orders.ledgerPostedAt).mapWith(Boolean),
    })
    .from(orders)
    .innerJoin(launches, eq(launches.id, orders.launchId))
    .innerJoin(collabMembers, eq(collabMembers.collabId, launches.collabId))
    .where(eq(collabMembers.userId, userId))
    .orderBy(desc(orders.paidAt), desc(orders.id))
    .limit(20)
  if (rows.length === 0) return []

  const shares = await db
    .select({
      orderId: ledgerEntries.orderId,
      cents: sql<number>`sum(${ledgerEntries.amountCents})::int`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        inArray(
          ledgerEntries.orderId,
          rows.map((row) => row.orderId),
        ),
        isNull(ledgerEntries.refundId),
        isNull(ledgerEntries.chargebackId),
        inArray(ledgerEntries.account, [...MEMBER_ACCOUNTS]),
        // A failed transfer's release lines cancel out; the re-issued line is the share.
        sql`not exists (select 1 from ${transfers} t where t.id = ${ledgerEntries.transferId} and t.status = 'failed')`,
      ),
    )
    .groupBy(ledgerEntries.orderId)
  const shareByOrder = new Map(shares.map((share) => [share.orderId, share.cents]))
  return rows.map(({ posted, ...row }) => ({
    ...row,
    shareCents: posted ? (shareByOrder.get(row.orderId) ?? 0) : null,
  }))
}

export type PayoutRow = {
  id: string
  createdAt: Date
  amountCents: number
  amountReversedCents: number
  currency: string
  status: TransferStatus
  failureCode: string | null
  /** Stripe's `tr_…` id (shown to help support find it). */
  stripeTransferId: string | null
}

/** The user's payout transfers, newest first. */
export async function listPayouts(
  db: DbOrTx,
  input: { userId: string; limit?: number },
): Promise<PayoutRow[]> {
  return db
    .select({
      id: transfers.id,
      createdAt: transfers.createdAt,
      amountCents: transfers.amountCents,
      amountReversedCents: transfers.amountReversedCents,
      currency: transfers.currency,
      status: transfers.status,
      failureCode: transfers.failureCode,
      stripeTransferId: transfers.stripeTransferId,
    })
    .from(transfers)
    .where(and(eq(transfers.userId, input.userId), ne(transfers.amountCents, 0)))
    .orderBy(desc(transfers.createdAt), desc(transfers.id))
    .limit(input.limit ?? 100)
}
