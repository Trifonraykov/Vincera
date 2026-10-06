import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import {
  agreementSignatures,
  agreements,
  collabMembers,
  collabs,
  messages,
  tasks,
  threads,
  users,
} from "@/lib/db/schema"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { seedCollabs } from "@/lib/seed/collabs"

import { setupTestDatabase } from "../../helpers/db"
import { stubServiceEnv } from "../../helpers/service-env"
import { onboardedBuilder, onboardedCreator, openIdea } from "../proposals/helpers"
import { makePayoutsReady, makeTempDataDir, removeTempDataDir } from "./helpers"

/**
 * The seed's "collabs" step (CLAUDE.md §19.24 "Seed", §19.28) on people shaped like the people
 * step's: four collabs made through the app's flow (half signed, ended before signing, and two
 * building with tasks and messages), and a second run that changes nothing.
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

beforeAll(async () => {
  mocks.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dir)
})
beforeEach(() => {
  mocks.db = testDb.db
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(() => setClockForTests(null))

async function seededPair(pair: number) {
  const creator = await onboardedCreator(testDb.db)
  const builder = await onboardedBuilder(testDb.db)
  const n = String(pair).padStart(2, "0")
  await testDb.db
    .update(users)
    .set({ email: `seed-creator-${n}@example.com`, name: `Seed Creator ${n}` })
    .where(eq(users.id, creator.user.id))
  await testDb.db
    .update(users)
    .set({ email: `seed-builder-${n}@example.com`, name: `Seed Builder ${n}` })
    .where(eq(users.id, builder.user.id))
  await openIdea(testDb.db, creator, `Seed idea ${n}`)
  await makePayoutsReady(testDb.db, creator.user.id)
  await makePayoutsReady(testDb.db, builder.user.id)
  return { creator, builder }
}

async function collabOf(userId: string) {
  const [row] = await testDb.db
    .select({ id: collabs.id, stage: collabs.stage })
    .from(collabMembers)
    .innerJoin(collabs, eq(collabs.id, collabMembers.collabId))
    .where(eq(collabMembers.userId, userId))
  if (!row) throw new Error("no collab")
  const [agreement] = await testDb.db
    .select()
    .from(agreements)
    .where(eq(agreements.collabId, row.id))
  return { ...row, agreement }
}

describe("seed step: collabs", () => {
  it("skips when the seeded people are missing", async () => {
    const result = await seedCollabs.run({ db: testDb.db, now: NOW, log: () => undefined })
    expect(result).toMatchObject({ skipped: expect.stringContaining("people missing") })
  })

  it("creates four collabs at four points, then changes nothing", async () => {
    const pairs = [
      await seededPair(1),
      await seededPair(2),
      await seededPair(3),
      await seededPair(4),
    ]
    const result = await seedCollabs.run({ db: testDb.db, now: NOW, log: () => undefined })
    expect(result).toEqual({ created: 4 })

    const [one, two, three, four] = await Promise.all(
      pairs.map((pair) => collabOf(pair.creator.user.id)),
    )
    // §15: collabs in different stages.
    expect(one).toMatchObject({ stage: "agreement", agreement: { status: "awaiting_signatures" } })
    expect(
      await testDb.db
        .select()
        .from(agreementSignatures)
        .where(eq(agreementSignatures.agreementId, one?.agreement?.id ?? "")),
    ).toMatchObject([{ userId: pairs[0]?.creator.user.id }])
    expect(two).toMatchObject({ stage: "ended", agreement: { status: "terminated" } })
    expect(three).toMatchObject({ stage: "building", agreement: { status: "signed" } })
    // Pair 4 stays in `building` (no launch); the launches seed takes pair 3 live.
    expect(four).toMatchObject({ stage: "building", agreement: { status: "signed" } })
    expect(new Set([one?.stage, two?.stage, three?.stage]).size).toBe(3)
    expect(three?.agreement?.pdfStorageKey).toBe(
      `agreements/${three?.id}/${three?.agreement?.id}.pdf`,
    )
    const work = await testDb.db
      .select()
      .from(tasks)
      .where(eq(tasks.collabId, three?.id ?? ""))
    expect(work).toHaveLength(3)
    expect(work.filter((task) => task.doneAt !== null)).toHaveLength(1)
    const [thread] = await testDb.db
      .select()
      .from(threads)
      .where(eq(threads.collabId, three?.id ?? ""))
    expect(
      await testDb.db
        .select()
        .from(messages)
        .where(eq(messages.threadId, thread?.id ?? "")),
    ).toHaveLength(2)

    expect(await seedCollabs.run({ db: testDb.db, now: NOW, log: () => undefined })).toEqual({
      created: 0,
    })
    expect(await testDb.db.select().from(collabs)).toHaveLength(4)
  })
})
