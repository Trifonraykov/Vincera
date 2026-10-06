import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { launches, trackedLinks, users } from "@/lib/db/schema"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { SEED_ADMIN_EMAIL, seedLaunches } from "@/lib/seed/launches"

import { setupTestDatabase } from "../../helpers/db"
import { insertCollab } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import { collabStage } from "./helpers"

/**
 * The seed's "launches" step (CLAUDE.md §19.31 "Seed", §19.32): collab 03 is taken live through
 * the app's own functions (both approvals, the seeded admin's review), and a second run changes
 * nothing.
 */

const mocks = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/embeddings/request", () => ({
  requestEmbeddingRefreshAfterCommit: async () => undefined,
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const run = () => seedLaunches.run({ db: testDb.db, now: NOW, log: () => undefined })

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "seed-launches-"))
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(() => setClockForTests(null))

describe("seed step: launches", () => {
  it("skips without the seeded people", async () => {
    expect(await run()).toMatchObject({ skipped: expect.stringContaining("people missing") })
  })

  it("takes collab 03 live with the creator's default link, then changes nothing", async () => {
    const { collab, creator, builder } = await insertCollab(testDb.db, { stage: "building" })
    await testDb.db
      .update(users)
      .set({ email: "seed-creator-03@example.com" })
      .where(eq(users.id, creator.user.id))
    await testDb.db
      .update(users)
      .set({ email: "seed-builder-03@example.com" })
      .where(eq(users.id, builder.user.id))

    expect(await run()).toEqual({ created: 1 })
    const [launch] = await testDb.db.select().from(launches).where(eq(launches.collabId, collab.id))
    expect(launch).toMatchObject({
      status: "live",
      slug: "printable-checklist-planner",
      priceCents: 1200,
      deliveryType: "url",
    })
    expect(await collabStage(testDb.db, collab.id)).toBe("live")
    const links = await testDb.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.launchId, launch?.id ?? ""))
    expect(links).toMatchObject([{ isDefault: true, ownerUserId: creator.user.id }])
    const [admin] = await testDb.db.select().from(users).where(eq(users.email, SEED_ADMIN_EMAIL))
    expect(admin?.roles).toContain("admin")

    expect(await run()).toEqual({ created: 0 })
  })
})
