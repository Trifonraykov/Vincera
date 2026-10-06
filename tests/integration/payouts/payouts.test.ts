import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq, isNull } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { payoutsRelease } from "@/inngest/functions/payouts-release"
import { ledgerCheck } from "@/inngest/functions/ledger-check"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { ledgerEntries, orders, payoutBatches, transfers } from "@/lib/db/schema"
import { listOutbox } from "@/lib/email/outbox"
import { resetEnvCache } from "@/lib/env"
import { newId } from "@/lib/ids"
import { checkLedger } from "@/lib/ledger/check"
import { userBalances } from "@/lib/ledger/release"
import { loadEarningsOverview, listPayouts } from "@/lib/payouts/earnings"
import { runLedgerCheck } from "@/lib/payouts/ledger-check"
import { dailyRunKey, runPayoutBatch, type PayoutBatchSummary } from "@/lib/payouts/release"
import { inlineSteps, type StepRunner } from "@/lib/payouts/steps"
import { createFakeStripeGateway } from "@/lib/stripe/fake"
import { fakeConnectedBalance, setFakePlatformBalance } from "@/lib/stripe/fake-money"

import { setupTestDatabase } from "../../helpers/db"
import { insertLedgerEntry } from "../../helpers/db-fixtures"
import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"
import {
  AFTER_HOLD,
  BUILDER_SHARE,
  CREATOR_SHARE,
  DAY_MS,
  eventTypes,
  notificationTypes,
  PAID_AT,
  postedSale,
  sum,
  userEntries,
  type FakeGateway,
} from "./helpers"

/**
 * The daily payout job against Postgres and the fake Stripe gateway (§9 "Daily payout job", §16
 * Phase 5; CLAUDE.md §19.31, §19.35): nothing before the hold, the right amounts after it, the
 * minimum, payouts-readiness, chargeback freezes, idempotent re-runs and resumes, refused
 * transfers (released and paid later), the notices, the reconciliation job and the earnings data.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
const reportError = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability", () => ({ reportError }))

const testDb = setupTestDatabase()
let gateway: FakeGateway

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "payouts-test-"))
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  mocks.db = testDb.db
  reportError.mockReset()
  stubServiceEnv({ MIN_PAYOUT_CENTS: "500" })
  gateway = createFakeStripeGateway({
    root: path.join(mocks.dir, "fake-stripe"),
    appUrl: TEST_APP_URL,
  })
  setClockForTests(new Date(PAID_AT.getTime() + 60_000))
})
afterEach(async () => {
  setClockForTests(null)
  vi.unstubAllEnvs()
  resetEnvCache()
  await closeDb()
})

/** Run the job (inline) at `at` with a fresh manual run key. */
async function runJob(at: Date, runKey = `manual:${newId()}`) {
  setClockForTests(at)
  return (await payoutsRelease.runInline({ runKey })) as PayoutBatchSummary
}

async function transfersOf(userId: string) {
  return testDb.db.select().from(transfers).where(eq(transfers.userId, userId))
}

describe("payouts-release", () => {
  it("pays nothing during the hold period", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const summary = await runJob(new Date(PAID_AT.getTime() + 3 * DAY_MS))
    expect(summary.status).toBe("completed")
    expect(await transfersOf(sale.creator.user.id)).toEqual([])
    expect(await transfersOf(sale.builder.user.id)).toEqual([])
  })

  it("pays each member's share after the hold, once, and records it everywhere", async () => {
    const sale = await postedSale(testDb.db, gateway)
    const runKey = dailyRunKey(AFTER_HOLD)
    const summary = await runJob(AFTER_HOLD, runKey)
    expect(summary).toMatchObject({ status: "completed", runKey })

    const [creatorTransfer] = await transfersOf(sale.creator.user.id)
    const [builderTransfer] = await transfersOf(sale.builder.user.id)
    expect(creatorTransfer).toMatchObject({
      amountCents: CREATOR_SHARE,
      status: "created",
      currency: "eur",
      destinationAccountId: sale.accounts?.creator,
      batchId: summary.batchId,
    })
    expect(builderTransfer).toMatchObject({ amountCents: BUILDER_SHARE, status: "created" })
    expect(creatorTransfer?.stripeTransferId).toMatch(/^tr_fake_/)

    // At Stripe: the money reached the connected accounts.
    expect(await fakeConnectedBalance(gateway.store, sale.accounts!.creator, "eur")).toBe(
      CREATOR_SHARE,
    )
    expect(await fakeConnectedBalance(gateway.store, sale.accounts!.builder, "eur")).toBe(
      BUILDER_SHARE,
    )
    // Every member entry is marked with its transfer; nothing is left to pay.
    for (const entry of await userEntries(testDb.db, sale.creator.user.id)) {
      expect(entry.transferId).toBe(creatorTransfer?.id)
    }
    const [batch] = await testDb.db
      .select()
      .from(payoutBatches)
      .where(eq(payoutBatches.id, summary.batchId))
    expect(batch?.status).toBe("completed")
    expect(batch?.completedAt).not.toBeNull()

    // Events, notices and the required emails.
    expect(await eventTypes(testDb.db, creatorTransfer!.id)).toEqual(["payout.sent"])
    expect(await eventTypes(testDb.db, summary.batchId)).toEqual(["payout.batch_completed"])
    expect(await notificationTypes(testDb.db, sale.creator.user.id)).toContain("payout.sent")
    const emails = await listOutbox()
    expect(
      emails.filter(
        (email) => email.to.includes(sale.creator.user.email!) && /€8\.18/.test(email.subject),
      ),
    ).toHaveLength(1)

    // Idempotent: the same run again, or tomorrow's, pays nothing more.
    expect((await runJob(AFTER_HOLD, runKey)).status).toBe("already_completed")
    await runJob(new Date(AFTER_HOLD.getTime() + DAY_MS))
    expect(await transfersOf(sale.creator.user.id)).toHaveLength(1)
    expect(await notificationTypes(testDb.db, sale.creator.user.id)).toEqual(["payout.sent"])

    // The books balance, also against Stripe's transfers.
    const report = await checkLedger(testDb.db, {
      compareWithStripe: true,
      gateway,
      at: AFTER_HOLD,
    })
    expect(report.mismatches).toEqual([])

    // What the earnings pages show.
    const overview = await loadEarningsOverview(testDb.db, {
      userId: sale.creator.user.id,
      at: AFTER_HOLD,
    })
    expect(overview.balances).toEqual([
      expect.objectContaining({ paidOutCents: CREATOR_SHARE, availableCents: 0, pendingCents: 0 }),
    ])
    expect(overview.recentSales).toEqual([
      expect.objectContaining({ orderId: sale.order.id, shareCents: CREATOR_SHARE }),
    ])
    expect(overview.launches).toEqual([
      expect.objectContaining({ earnedCents: CREATOR_SHARE, orderCount: 1, refundedCents: 0 }),
    ])
    expect(overview.payouts).toBe("ready")
    expect(JSON.stringify(overview)).not.toContain("@")
    expect(await listPayouts(testDb.db, { userId: sale.creator.user.id })).toEqual([
      expect.objectContaining({ amountCents: CREATOR_SHARE, status: "created" }),
    ])
  })

  it("skips balances below MIN_PAYOUT_CENTS, and users who are not payouts-ready", async () => {
    stubServiceEnv({ MIN_PAYOUT_CENTS: "1000" })
    const small = await postedSale(testDb.db, gateway)
    await runJob(AFTER_HOLD)
    expect(await transfersOf(small.creator.user.id)).toEqual([])
    expect(await transfersOf(small.builder.user.id)).toEqual([])

    stubServiceEnv({ MIN_PAYOUT_CENTS: "500" })
    const notReady = await postedSale(testDb.db, gateway, { ready: false })
    await runJob(AFTER_HOLD)
    expect(await transfersOf(notReady.creator.user.id)).toEqual([])
    // Their balance waits for them.
    expect(
      await userBalances(testDb.db, { userId: notReady.creator.user.id, at: AFTER_HOLD }),
    ).toEqual([expect.objectContaining({ availableCents: CREATOR_SHARE })])
  })

  it("leaves out orders with an open chargeback (the freeze)", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await testDb.db.update(orders).set({ status: "disputed" }).where(eq(orders.id, sale.order.id))
    await runJob(AFTER_HOLD)
    expect(await transfersOf(sale.creator.user.id)).toEqual([])
    expect(await userBalances(testDb.db, { userId: sale.creator.user.id, at: AFTER_HOLD })).toEqual(
      [expect.objectContaining({ onHoldCents: CREATOR_SHARE, availableCents: 0 })],
    )

    await testDb.db.update(orders).set({ status: "paid" }).where(eq(orders.id, sale.order.id))
    await runJob(AFTER_HOLD)
    expect(await transfersOf(sale.creator.user.id)).toEqual([
      expect.objectContaining({ amountCents: CREATOR_SHARE, status: "created" }),
    ])
  })

  it("nets negative entries (a refund after a payout) into the next payout", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await insertLedgerEntry(testDb.db, {
      userId: sale.creator.user.id,
      account: "adjustment",
      amountCents: -300,
      currency: "eur",
      availableAt: PAID_AT,
    })
    await runJob(AFTER_HOLD)
    expect(await transfersOf(sale.creator.user.id)).toEqual([
      expect.objectContaining({ amountCents: CREATOR_SHARE - 300 }),
    ])
  })

  it("marks a refused transfer failed, releases its entries and pays them in a later run", async () => {
    const sale = await postedSale(testDb.db, gateway)
    await setFakePlatformBalance(gateway.store, "eur", 100)
    try {
      await runJob(AFTER_HOLD)
    } finally {
      await setFakePlatformBalance(gateway.store, "eur", null)
    }
    const [failed] = await transfersOf(sale.creator.user.id)
    expect(failed).toMatchObject({ status: "failed", failureCode: "balance_insufficient" })
    expect(await eventTypes(testDb.db, failed!.id)).toEqual(["payout.failed"])
    expect(await notificationTypes(testDb.db, sale.creator.user.id)).toEqual(["payout.failed"])
    // The platform's balance being short is reported for operations.
    expect(reportError).toHaveBeenCalled()
    // Released: the failed transfer's entries net to zero; the money is available again.
    const marked = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transferId, failed!.id))
    expect(sum(marked)).toBe(0)
    expect(await userBalances(testDb.db, { userId: sale.creator.user.id, at: AFTER_HOLD })).toEqual(
      [expect.objectContaining({ availableCents: CREATOR_SHARE, paidOutCents: 0 })],
    )

    await runJob(new Date(AFTER_HOLD.getTime() + DAY_MS))
    const all = await transfersOf(sale.creator.user.id)
    expect(all.map((t) => [t.status, t.amountCents]).sort()).toEqual([
      ["created", CREATOR_SHARE],
      ["failed", CREATOR_SHARE],
    ])
    const report = await checkLedger(testDb.db, {
      compareWithStripe: true,
      gateway,
      at: AFTER_HOLD,
    })
    expect(report.mismatches).toEqual([])
    const overview = await loadEarningsOverview(testDb.db, {
      userId: sale.creator.user.id,
      at: new Date(AFTER_HOLD.getTime() + DAY_MS),
    })
    expect(overview.recentSales[0]?.shareCents).toBe(CREATOR_SHARE)
    expect(overview.launches[0]?.earnedCents).toBe(CREATOR_SHARE)
  })

  it("resumes a crashed run without paying twice", async () => {
    const sale = await postedSale(testDb.db, gateway)
    setClockForTests(AFTER_HOLD)
    const runKey = `manual:${newId()}`
    let crashed = false
    const crashing: StepRunner = {
      run: async (id, fn) => {
        const result = await fn()
        // Stripe created the transfer, then the worker died before the step was saved.
        if (id.startsWith("pay:") && !crashed) {
          crashed = true
          throw new Error("worker lost")
        }
        return result
      },
    }
    await expect(
      runPayoutBatch({ db: testDb.db, gateway, step: crashing }, { runKey }),
    ).rejects.toThrow("worker lost")
    await runPayoutBatch({ db: testDb.db, gateway, step: inlineSteps }, { runKey })

    const paid = [
      ...(await transfersOf(sale.creator.user.id)),
      ...(await transfersOf(sale.builder.user.id)),
    ]
    expect(paid.map((t) => t.status)).toEqual(["created", "created"])
    expect(await fakeConnectedBalance(gateway.store, sale.accounts!.creator, "eur")).toBe(
      CREATOR_SHARE,
    )
    expect(await fakeConnectedBalance(gateway.store, sale.accounts!.builder, "eur")).toBe(
      BUILDER_SHARE,
    )
    const unpaid = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.userId, sale.creator.user.id), isNull(ledgerEntries.transferId)))
    expect(unpaid).toEqual([])
  })
})

describe("ledger-check", () => {
  it("reports each mismatch to Sentry with its kind and ids only", async () => {
    const sale = await postedSale(testDb.db, gateway)
    setClockForTests(AFTER_HOLD)
    // A stray line on the order breaks its sum.
    await insertLedgerEntry(testDb.db, {
      orderId: sale.order.id,
      account: "adjustment",
      amountCents: 7,
      currency: "eur",
      availableAt: PAID_AT,
    })
    const run = await runLedgerCheck(testDb.db, { gateway, at: AFTER_HOLD })
    expect(run.kinds.order_sum).toBeGreaterThanOrEqual(1)
    const call = reportError.mock.calls.find(
      ([, context]) =>
        (context as { extra?: { orderId?: string } }).extra?.orderId === sale.order.id,
    )
    expect(call?.[1]).toEqual({
      tags: { area: "ledger", job: "ledger-check", kind: "order_sum" },
      extra: {
        orderId: sale.order.id,
        transferId: undefined,
        refundId: undefined,
        chargebackId: undefined,
      },
    })
    // The job wraps the same run.
    await expect(ledgerCheck.runInline({})).resolves.toMatchObject({
      mismatchCount: expect.any(Number),
    })
  })
})
