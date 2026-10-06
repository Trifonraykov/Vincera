import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { users } from "@/lib/db/schema"
import { resetEnvCache } from "@/lib/env"
import { checkLedger } from "@/lib/ledger/check"
import { seedOrders } from "@/lib/seed/orders"

import { setupTestDatabase } from "../../helpers/db"
import { stubServiceEnv } from "../../helpers/service-env"
import { liveLaunchWithLink, ordersOfLaunch } from "./helpers"

/**
 * The seed's "orders" step (CLAUDE.md §19.31 "Seed", §19.34): three purchases of creator 03's live
 * launch through the fake gateway and the real webhook processing; idempotent; the ledger checks out.
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

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const run = () => seedOrders.run({ db: testDb.db, now: NOW, log: () => undefined })

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "seed-orders-"))
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  mocks.db = testDb.db
  stubServiceEnv()
  setClockForTests(NOW)
})
afterEach(async () => {
  setClockForTests(null)
  vi.unstubAllEnvs()
  resetEnvCache()
  await closeDb()
})

describe("seed step: orders", () => {
  it("skips without creator 03's live launch", async () => {
    expect(await run()).toMatchObject({ skipped: expect.stringContaining("creator 03") })
  })

  it("buys the launch three times through the real path, then changes nothing", async () => {
    const live = await liveLaunchWithLink(testDb.db)
    await testDb.db
      .update(users)
      .set({ email: "seed-creator-03@example.com" })
      .where(eq(users.id, live.creator.user.id))

    expect(await run()).toEqual({ created: 3 })
    const placed = await ordersOfLaunch(testDb.db, live.launch.id)
    expect(placed.map((order) => order.buyerEmail).sort()).toEqual([
      "seed-buyer-01@example.com",
      "seed-buyer-02@example.com",
      "seed-buyer-03@example.com",
    ])
    expect(placed.filter((order) => order.trackedLinkId === live.link.id)).toHaveLength(2)
    expect(placed.every((order) => order.ledgerPostedAt !== null)).toBe(true)

    expect(await run()).toEqual({ created: 0 })
    expect(await ordersOfLaunch(testDb.db, live.launch.id)).toHaveLength(3)
    const report = await checkLedger(testDb.db, { at: NOW })
    expect(report.mismatches).toEqual([])
  })
})
