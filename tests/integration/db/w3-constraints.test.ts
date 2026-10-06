import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { PG_ERROR } from "@/lib/db/errors"
import {
  accessGrants,
  chargebacks,
  launches,
  licenseKeys,
  orders,
  payoutBatches,
  refunds,
  trackedLinks,
  transferReversals,
  transfers,
} from "@/lib/db/schema"

import { expectPgError, setupTestDatabase } from "../../helpers/db"
import {
  insertLedgerEntry,
  insertLiveLaunch,
  insertOrder,
  insertPayoutBatch,
  insertTrackedLink,
  insertTransfer,
} from "../../helpers/db-fixtures"

/** The constraints migration 0010 added for Phases 4–5 (CLAUDE.md §19.31). */

const testDb = setupTestDatabase()
const CHECK = PG_ERROR.checkViolation
const UNIQUE = PG_ERROR.uniqueViolation
const T = new Date("2026-02-01T00:00:00Z")
const TOKEN = "A".repeat(43)

describe("launches", () => {
  it("checks price range, tax code, delivery config type and slug", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    const byId = eq(launches.id, launch.id)
    await expectPgError(
      testDb.db.update(launches).set({ priceCents: 49 }).where(byId),
      CHECK,
      "launches_price_range",
    )
    await expectPgError(
      testDb.db.update(launches).set({ priceCents: 1_000_001 }).where(byId),
      CHECK,
      "launches_price_range",
    )
    await expectPgError(
      testDb.db.update(launches).set({ taxCode: "txcd_123" }).where(byId),
      CHECK,
      "launches_tax_code_format",
    )
    await testDb.db.update(launches).set({ taxCode: "txcd_10202000" }).where(byId)
    await expectPgError(
      testDb.db
        .update(launches)
        .set({ deliveryConfig: { type: "file" } })
        .where(byId),
      CHECK,
      "launches_delivery_config_matches_type",
    )
    await expectPgError(
      testDb.db.update(launches).set({ slug: "ab" }).where(byId),
      CHECK,
      "launches_slug_length",
    )
  })

  it("ties paused, ended, live and review columns to the status", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    const byId = eq(launches.id, launch.id)
    await expectPgError(
      testDb.db.update(launches).set({ status: "paused" }).where(byId),
      CHECK,
      "launches_paused_iff_paused_at",
    )
    await testDb.db
      .update(launches)
      .set({ status: "paused", pausedAt: T, pausedBy: "member" })
      .where(byId)
    // Resuming must clear the pause.
    await expectPgError(
      testDb.db.update(launches).set({ status: "live" }).where(byId),
      CHECK,
      "launches_paused_iff_paused_at",
    )
    await testDb.db
      .update(launches)
      .set({ status: "live", pausedAt: null, pausedBy: null })
      .where(byId)
    await expectPgError(
      testDb.db.update(launches).set({ status: "ended" }).where(byId),
      CHECK,
      "launches_ended_iff_ended_at",
    )
    await expectPgError(
      testDb.db.update(launches).set({ wentLiveAt: null }).where(byId),
      CHECK,
      "launches_live_has_went_live_at",
    )
    await expectPgError(
      testDb.db.update(launches).set({ status: "admin_review", submittedAt: null }).where(byId),
      CHECK,
      "launches_submitted_unless_draft",
    )
    await expectPgError(
      testDb.db.update(launches).set({ reviewedAt: T }).where(byId),
      CHECK,
      "launches_reviewed_pair",
    )
    const [ended] = await testDb.db
      .update(launches)
      .set({ status: "ended", endedAt: T })
      .where(byId)
      .returning()
    expect(ended?.status).toBe("ended")
  })
})

describe("tracked links", () => {
  it("allows one default link per launch and platform-wide unique discount codes", async () => {
    const { launch, creator } = await insertLiveLaunch(testDb.db)
    const other = await insertLiveLaunch(testDb.db)
    await insertTrackedLink(testDb.db, launch.id, creator.user.id, { isDefault: true })
    await expectPgError(
      insertTrackedLink(testDb.db, launch.id, creator.user.id, { isDefault: true }),
      UNIQUE,
      "tracked_links_one_default_per_launch_idx",
    )
    await insertTrackedLink(testDb.db, launch.id, creator.user.id, {
      discountCode: "LAUNCH20",
      discountPercentOff: 20,
    })
    await expectPgError(
      insertTrackedLink(testDb.db, other.launch.id, other.creator.user.id, {
        discountCode: "LAUNCH20",
        discountPercentOff: 10,
      }),
      UNIQUE,
      "tracked_links_discount_code_unique",
    )
  })

  it("checks discount code format and its percentage", async () => {
    const { launch, creator } = await insertLiveLaunch(testDb.db)
    await expectPgError(
      insertTrackedLink(testDb.db, launch.id, creator.user.id, {
        discountCode: "launch20",
        discountPercentOff: 20,
      }),
      CHECK,
      "tracked_links_discount_code_format",
    )
    await expectPgError(
      insertTrackedLink(testDb.db, launch.id, creator.user.id, { discountCode: "SAVE10" }),
      CHECK,
      "tracked_links_discount_pair",
    )
    await expectPgError(
      insertTrackedLink(testDb.db, launch.id, creator.user.id, {
        discountCode: "SAVE101",
        discountPercentOff: 101,
      }),
      CHECK,
      "tracked_links_discount_range",
    )
    await expectPgError(
      insertTrackedLink(testDb.db, launch.id, creator.user.id, {
        stripePromotionCodeId: "promo_123",
      }),
      CHECK,
      "tracked_links_promotion_needs_code",
    )
    await expectPgError(
      testDb.db.insert(trackedLinks).values({
        launchId: launch.id,
        ownerUserId: creator.user.id,
        code: "abcdefgh",
        label: "x".repeat(81),
      }),
      CHECK,
      "tracked_links_label_length",
    )
  })
})

describe("orders", () => {
  it("keeps status and refunded amount consistent", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, T)
    const byId = eq(orders.id, order.id)
    await expectPgError(
      testDb.db.update(orders).set({ amountRefundedCents: 500 }).where(byId),
      CHECK,
      "orders_refunded_status",
    )
    await testDb.db
      .update(orders)
      .set({ amountRefundedCents: 500, status: "partially_refunded" })
      .where(byId)
    await expectPgError(
      testDb.db.update(orders).set({ amountRefundedCents: 1900 }).where(byId),
      CHECK,
      "orders_refunded_status",
    )
    await testDb.db
      .update(orders)
      .set({ amountRefundedCents: 1900, status: "refunded" })
      .where(byId)
    await expectPgError(
      testDb.db.update(orders).set({ amountRefundedCents: 2000 }).where(byId),
      CHECK,
      "orders_refunded_range",
    )
    // A disputed order may have any refunded amount.
    await testDb.db.update(orders).set({ status: "disputed" }).where(byId)
  })

  it("needs a balance transaction to post the ledger and a link for attribution", async () => {
    const { launch, creator } = await insertLiveLaunch(testDb.db)
    await expectPgError(
      insertOrder(testDb.db, launch.id, T, { ledgerPostedAt: T }),
      CHECK,
      "orders_ledger_needs_balance_transaction",
    )
    await expectPgError(
      insertOrder(testDb.db, launch.id, T, { attribution: "cookie" }),
      CHECK,
      "orders_attribution_has_link",
    )
    const link = await insertTrackedLink(testDb.db, launch.id, creator.user.id)
    await expectPgError(
      insertOrder(testDb.db, launch.id, T, { trackedLinkId: link.id }),
      CHECK,
      "orders_attribution_has_link",
    )
    await expectPgError(
      insertOrder(testDb.db, launch.id, T, { taxCents: 2000 }),
      CHECK,
      "orders_tax_within_gross",
    )
    await expectPgError(
      insertOrder(testDb.db, launch.id, T, { buyerCountry: "es" }),
      CHECK,
      "orders_buyer_country_format",
    )
    const order = await insertOrder(testDb.db, launch.id, T, {
      trackedLinkId: link.id,
      attribution: "discount_code",
      stripeChargeId: "ch_unique",
      stripeBalanceTransactionId: "txn_unique",
      ledgerPostedAt: T,
    })
    expect(order.ledgerPostedAt).toEqual(T)
    await expectPgError(
      insertOrder(testDb.db, launch.id, T, { stripeChargeId: "ch_unique" }),
      UNIQUE,
      "orders_stripe_charge_id_unique",
    )
  })
})

describe("delivery", () => {
  it("allows one active access grant per order with a 43-character token", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, T)
    await expectPgError(
      testDb.db.insert(accessGrants).values({ orderId: order.id, token: "short" }),
      CHECK,
      "access_grants_token_format",
    )
    await testDb.db.insert(accessGrants).values({ orderId: order.id, token: TOKEN })
    await expectPgError(
      testDb.db.insert(accessGrants).values({ orderId: order.id, token: "B".repeat(43) }),
      UNIQUE,
      "access_grants_one_active_per_order_idx",
    )
    await testDb.db
      .update(accessGrants)
      .set({ revokedAt: T })
      .where(eq(accessGrants.orderId, order.id))
    await testDb.db.insert(accessGrants).values({ orderId: order.id, token: "B".repeat(43) })
  })

  it("assigns a license key together with its time", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, T)
    await expectPgError(
      testDb.db
        .insert(licenseKeys)
        .values({ launchId: launch.id, key: "KEY-1", orderId: order.id }),
      CHECK,
      "license_keys_assigned_pair",
    )
    await expectPgError(
      testDb.db.insert(licenseKeys).values({ launchId: launch.id, key: "   " }),
      CHECK,
      "license_keys_key_not_blank",
    )
    await testDb.db
      .insert(licenseKeys)
      .values({ launchId: launch.id, key: "KEY-1", orderId: order.id, assignedAt: T })
  })
})

describe("refunds and chargebacks", () => {
  it("defaults refunds to pending and keeps chargeback status and close time together", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, T)
    const [refund] = await testDb.db
      .insert(refunds)
      .values({ orderId: order.id, amountCents: 500 })
      .returning()
    expect(refund?.status).toBe("pending")
    expect(refund?.currency).toBe("eur")

    const base = {
      orderId: order.id,
      amountCents: 1900,
      stripeStatus: "needs_response",
      openedAt: T,
    }
    await expectPgError(
      testDb.db.insert(chargebacks).values({ ...base, stripeDisputeId: "du_1", status: "lost" }),
      CHECK,
      "chargebacks_closed_iff_final",
    )
    await expectPgError(
      testDb.db.insert(chargebacks).values({ ...base, stripeDisputeId: "du_2", ledgerPostedAt: T }),
      CHECK,
      "chargebacks_ledger_only_when_lost",
    )
    const [chargeback] = await testDb.db
      .insert(chargebacks)
      .values({ ...base, stripeDisputeId: "du_3" })
      .returning()
    expect(chargeback?.status).toBe("open")
    await expectPgError(
      testDb.db.insert(chargebacks).values({ ...base, stripeDisputeId: "du_3" }),
      UNIQUE,
      "chargebacks_stripe_dispute_id_unique",
    )
  })
})

describe("ledger entries", () => {
  it("allows at most one cause and needs an order for refund or chargeback entries", async () => {
    const { launch, creator } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, T)
    const [refund] = await testDb.db
      .insert(refunds)
      .values({ orderId: order.id, amountCents: 500 })
      .returning()
    const [chargeback] = await testDb.db
      .insert(chargebacks)
      .values({
        orderId: order.id,
        stripeDisputeId: "du_ledger",
        amountCents: 1900,
        stripeStatus: "needs_response",
        openedAt: T,
      })
      .returning()
    if (!refund || !chargeback) throw new Error("fixture setup failed")
    await expectPgError(
      insertLedgerEntry(testDb.db, {
        account: "creator_share",
        amountCents: -100,
        userId: creator.user.id,
        orderId: order.id,
        refundId: refund.id,
        chargebackId: chargeback.id,
      }),
      CHECK,
      "ledger_entries_one_cause",
    )
    await expectPgError(
      insertLedgerEntry(testDb.db, {
        account: "creator_share",
        amountCents: -100,
        userId: creator.user.id,
        refundId: refund.id,
      }),
      CHECK,
      "ledger_entries_cause_has_order",
    )
    const transfer = await insertTransfer(testDb.db, creator.user.id)
    await expectPgError(
      insertLedgerEntry(testDb.db, {
        account: "platform_fee",
        amountCents: 100,
        orderId: order.id,
        transferId: transfer.id,
      }),
      CHECK,
      "ledger_entries_transfer_needs_user",
    )
    await insertLedgerEntry(testDb.db, {
      account: "adjustment",
      amountCents: -12,
      orderId: order.id,
      chargebackId: chargeback.id,
    })
  })
})

describe("payout batches, transfers and reversals", () => {
  it("makes run keys unique and ties completion to the status", async () => {
    await insertPayoutBatch(testDb.db, { runKey: "daily:2026-02-01" })
    await expectPgError(
      insertPayoutBatch(testDb.db, { runKey: "daily:2026-02-01" }),
      UNIQUE,
      "payout_batches_run_key_unique",
    )
    await expectPgError(
      insertPayoutBatch(testDb.db, { status: "completed" }),
      CHECK,
      "payout_batches_completed_iff_final",
    )
    const [done] = await testDb.db
      .insert(payoutBatches)
      .values({
        runKey: "daily:2026-02-02",
        cutoffAt: T,
        startedAt: T,
        status: "completed",
        completedAt: T,
      })
      .returning()
    expect(done?.status).toBe("completed")
  })

  it("allows one transfer per user and currency per batch, with Stripe's id once created", async () => {
    const { creator } = await insertLiveLaunch(testDb.db)
    const batch = await insertPayoutBatch(testDb.db)
    await insertTransfer(testDb.db, creator.user.id, { batchId: batch.id })
    await expectPgError(
      insertTransfer(testDb.db, creator.user.id, { batchId: batch.id }),
      UNIQUE,
      "transfers_batch_user_currency_key",
    )
    await expectPgError(
      insertTransfer(testDb.db, creator.user.id, { status: "created" }),
      CHECK,
      "transfers_stripe_id_unless_pending",
    )
    await expectPgError(
      insertTransfer(testDb.db, creator.user.id, { failureCode: "balance_insufficient" }),
      CHECK,
      "transfers_failure_code_only_when_failed",
    )
    const failed = await insertTransfer(testDb.db, creator.user.id, {
      status: "failed",
      failureCode: "balance_insufficient",
    })
    expect(failed.stripeTransferId).toBeNull()
  })

  it("records reversals with one cause and Stripe's id once succeeded", async () => {
    const { launch, creator } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, T)
    const [refund] = await testDb.db
      .insert(refunds)
      .values({ orderId: order.id, amountCents: 500 })
      .returning()
    if (!refund) throw new Error("fixture setup failed")
    const transfer = await insertTransfer(testDb.db, creator.user.id, {
      status: "created",
      stripeTransferId: "tr_1",
    })
    await expectPgError(
      testDb.db.insert(transferReversals).values({
        transferId: transfer.id,
        refundId: refund.id,
        amountCents: 300,
        status: "succeeded",
      }),
      CHECK,
      "transfer_reversals_stripe_id_when_succeeded",
    )
    const [reversal] = await testDb.db
      .insert(transferReversals)
      .values({ transferId: transfer.id, refundId: refund.id, amountCents: 300 })
      .returning()
    expect(reversal?.status).toBe("pending")
    // The transfer row tracks the reversed total.
    await expectPgError(
      testDb.db
        .update(transfers)
        .set({ amountReversedCents: 2000 })
        .where(eq(transfers.id, transfer.id)),
      CHECK,
      "transfers_reversed_range",
    )
  })
})
