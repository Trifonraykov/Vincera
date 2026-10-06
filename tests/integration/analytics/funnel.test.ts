import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  launchDailyCounts,
  launchLinkCounts,
  loadLaunchFunnel,
  loadFunnelLaunch,
  viewerShareOfOrders,
} from "@/lib/analytics/funnel"
import { setClockForTests } from "@/lib/clock"
import { loadLinksWithCounts } from "@/lib/tracked-links/queries"

import { setupTestDatabase } from "../../helpers/db"
import {
  insertLedgerEntry,
  insertLiveLaunch,
  insertOrder,
  insertTrackedLink,
} from "../../helpers/db-fixtures"
import { at, checkoutStarted, click, view } from "./helpers"

/**
 * The collab analytics funnel (§10; CLAUDE.md §19.38) on fixture data: clicks (bots out, distinct
 * visitors), views and checkouts from events, orders by `paid_at`, attribution per link with a
 * "No link" row, daily buckets in UTC, the range, and the viewer's own share only.
 */

const testDb = setupTestDatabase()
const RANGE = { from: "2026-09-30", to: "2026-10-05" }

beforeEach(() => setClockForTests(at("2026-10-05")))
afterEach(() => setClockForTests(null))

async function fixture() {
  const db = testDb.db
  const live = await insertLiveLaunch(db)
  const launchId = live.launch.id
  const a = await insertTrackedLink(db, launchId, live.creator.user.id, {
    isDefault: true,
    label: "Default",
  })
  const b = await insertTrackedLink(db, launchId, live.builder.user.id, { label: "YouTube" })

  // Day 1 (2026-10-01): three people clicks on A (two visitors), one bot; outside the range: one.
  await click(db, a.id, at("2026-10-01", "08:00:00"), { visitorId: "v1" })
  await click(db, a.id, at("2026-10-01", "09:00:00"), { visitorId: "v1" })
  await click(db, a.id, at("2026-10-01", "23:59:59"), { visitorId: "v2" })
  await click(db, a.id, at("2026-10-01"), { visitorId: "bot", isBot: true })
  await click(db, a.id, at("2026-08-01"), { visitorId: "old" })
  // Day 3 (2026-10-03): two on B.
  await click(db, b.id, at("2026-10-03"), { visitorId: "v3" })
  await click(db, b.id, at("2026-10-03"), { visitorId: "v4" })

  await view(db, launchId, a.id, at("2026-10-01"))
  await view(db, launchId, a.id, at("2026-10-01"))
  await view(db, launchId, b.id, at("2026-10-03"))
  await view(db, launchId, null, at("2026-10-03"))
  await view(db, launchId, null, at("2026-10-03"))
  await view(db, launchId, null, at("2026-08-01"))
  await checkoutStarted(db, launchId, a.id, at("2026-10-01"))
  await checkoutStarted(db, launchId, null, at("2026-10-03"))

  const attributed = await insertOrder(db, launchId, at("2026-10-01", "13:00:00"), {
    trackedLinkId: a.id,
    attribution: "cookie",
    amountRefundedCents: 500,
    status: "partially_refunded",
  })
  const direct = await insertOrder(db, launchId, at("2026-10-03", "13:00:00"))
  const old = await insertOrder(db, launchId, at("2026-08-01"))

  const creator = live.creator.user.id
  await insertLedgerEntry(db, {
    account: "creator_share",
    amountCents: 818,
    userId: creator,
    orderId: attributed.id,
  })
  await insertLedgerEntry(db, {
    account: "creator_share",
    amountCents: 818,
    userId: creator,
    orderId: direct.id,
  })
  await insertLedgerEntry(db, {
    account: "creator_share",
    amountCents: 818,
    userId: creator,
    orderId: old.id,
  })
  await insertLedgerEntry(db, {
    account: "builder_share",
    amountCents: 546,
    userId: live.builder.user.id,
    orderId: attributed.id,
  })
  // Another launch's sale of the same creator never counts here.
  const other = await insertLiveLaunch(db)
  const otherOrder = await insertOrder(db, other.launch.id, at("2026-10-02"))
  await insertLedgerEntry(db, {
    account: "creator_share",
    amountCents: 999,
    userId: creator,
    orderId: otherOrder.id,
  })

  return { live, launchId, a, b }
}

describe("collab analytics funnel", () => {
  it("counts each step once, by link and overall, inside the range", async () => {
    const { launchId, a, b } = await fixture()
    const { totals, byLink } = await launchLinkCounts(testDb.db, launchId, RANGE)
    expect(totals).toEqual({
      clicks: 5,
      visitors: 4,
      views: 5,
      checkouts: 2,
      orders: 2,
      grossCents: 3800,
      refundedCents: 500,
    })
    expect(byLink.map((row) => row.linkId)).toEqual([a.id, b.id, null])
    expect(byLink[0]).toMatchObject({
      clicks: 3,
      visitors: 2,
      views: 2,
      checkouts: 1,
      orders: 1,
      grossCents: 1900,
    })
    expect(byLink[1]).toMatchObject({ clicks: 2, visitors: 2, views: 1, checkouts: 0, orders: 0 })
    expect(byLink[2]).toMatchObject({
      clicks: 0,
      views: 2,
      checkouts: 1,
      orders: 1,
      grossCents: 1900,
    })
  })

  it("counts all time when no range is given", async () => {
    const { launchId } = await fixture()
    const { totals } = await launchLinkCounts(testDb.db, launchId, null)
    expect(totals).toMatchObject({ clicks: 6, visitors: 5, views: 6, orders: 3 })
  })

  it("buckets by UTC day, every day of the range present", async () => {
    const { launchId } = await fixture()
    const daily = await launchDailyCounts(testDb.db, launchId, RANGE)
    expect(daily.map((d) => d.day)).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ])
    expect(daily[1]).toMatchObject({
      clicks: 3,
      views: 2,
      checkouts: 1,
      orders: 1,
      grossCents: 1900,
    })
    expect(daily[3]).toMatchObject({ clicks: 2, views: 3, checkouts: 1, orders: 1 })
    expect(daily[2]).toMatchObject({ clicks: 0, views: 0, orders: 0 })
  })

  it("gives the viewer their own share only, and none to admins", async () => {
    const { live, launchId } = await fixture()
    expect(
      await viewerShareOfOrders(testDb.db, {
        launchId,
        userId: live.creator.user.id,
        range: RANGE,
      }),
    ).toBe(1636)
    expect(
      await viewerShareOfOrders(testDb.db, {
        launchId,
        userId: live.builder.user.id,
        range: RANGE,
      }),
    ).toBe(546)
    const launch = await loadFunnelLaunch(testDb.db, live.collab.id)
    if (!launch) throw new Error("no launch")
    const forAdmin = await loadLaunchFunnel(testDb.db, { launch, range: RANGE, viewerUserId: null })
    expect(forAdmin.viewerShareCents).toBeNull()
    expect(forAdmin.totals.orders).toBe(2)
  })

  it("names each link's owner for the links table", async () => {
    const { live, launchId } = await fixture()
    const { rows } = await loadLinksWithCounts(testDb.db, {
      launchId,
      collabId: live.collab.id,
      range: RANGE,
    })
    expect(rows.map((row) => row.link?.label ?? null)).toEqual(["Default", "YouTube", null])
    expect(rows[0]?.link?.ownerRole).toBe("creator")
    expect(rows[1]?.link?.ownerRole).toBe("builder")
  })
})
