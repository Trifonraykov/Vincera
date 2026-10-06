import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import {
  adminAuditLog,
  collabs,
  events,
  launches,
  matches,
  matchingConfig,
  users,
} from "@/lib/db/schema"
import {
  loadActiveMatchingConfig,
  MIN_COMPLETED_LAUNCHES_FOR_V1,
  V0_MODEL_VERSION,
} from "@/lib/matching/config"
import { recomputeMatchesForUser } from "@/lib/matching/recompute"
import { V0_WEIGHTS } from "@/lib/matching/score"
import { activateMatchingModel, deactivateMatchingModel } from "@/lib/matching/v1/activation"
import { loadMatchOutcomes } from "@/lib/matching/v1/dataset"
import { scoreBucketFunnel } from "@/lib/matching/v1/funnel"
import { listModelVersions } from "@/lib/matching/v1/queries"
import { trainMatchingModel } from "@/lib/matching/v1/train"
import { InsufficientTrainingDataError } from "@/lib/matching/v1/train-core"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { seedMatchingHistory } from "@/lib/seed/matching-history"

import { setupTestDatabase } from "../../helpers/db"
import {
  insertBuilder,
  insertCreator,
  insertIdea,
  insertLiveLaunch,
  insertMatch,
  insertOrder,
  insertProposal,
  insertUser,
} from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import { matchBuilder, matchCreator, vector } from "../matching/helpers"

/**
 * Matching v1 against Postgres (§8 Phase 7; CLAUDE.md §19.38, §19.42): labels and linking, the
 * score-bucket funnel, training from the seeded history (stored inactive, event, audit), the
 * flag (≥ 50 completed launches or forced), the recompute ranking with v1, and audited activation.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown, user: null as AuthUser | null, dir: "" }))
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => {
    if (!mocks.user) throw new Error("no user")
    return mocks.user
  },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})

const { activateMatchingModelAction, deactivateMatchingModelAction, trainMatchingModelAction } =
  await import("@/lib/matching/v1/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-06T12:00:00.000Z")
const EARLY = new Date("2026-09-01T00:00:00.000Z")
const LATER = new Date("2026-09-10T00:00:00.000Z")
const OFF = { MATCHING_V1_FORCE: false, MATCHING_MODEL_VERSION: undefined }
const FORCED = { MATCHING_V1_FORCE: true, MATCHING_MODEL_VERSION: undefined }

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "matching-v1-"))
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
  mocks.db = testDb.db
  mocks.user = null
})
afterEach(() => setClockForTests(null))

async function insertAdmin(): Promise<AuthUser> {
  const row = await insertUser(testDb.db, {
    roles: ["admin"],
    activeRole: "admin",
    onboardingCompletedAt: EARLY,
  })
  return {
    id: row.id,
    email: row.email ?? "admin@example.test",
    name: row.name,
    image: null,
    roles: row.roles,
    activeRole: row.activeRole,
    status: row.status,
    onboardingCompletedAt: row.onboardingCompletedAt,
  }
}

describe("labels and the score-bucket funnel", () => {
  it("links proposals to shown matches and labels accepted and sale outcomes", async () => {
    const db = testDb.db
    const version = "v1-2026-01-01"
    // A version of its own keeps these rows apart from the seeded history below.
    await db.insert(matchingConfig).values({ modelVersion: version, weights: V0_WEIGHTS })
    const { creator, builder, idea, proposal, collab, launch } = await insertLiveLaunch(db)
    const other = await insertCreator(db)
    const otherIdea = await insertIdea(db, other.profile.id, { status: "open" })
    const third = await insertBuilder(db)
    const at = { createdAt: EARLY, computedAt: EARLY, shownAt: EARLY, modelVersion: version }

    // 1. Builder's idea match: the accepted proposal is linked by pair and idea (sent later).
    const sold = await insertMatch(db, {
      subjectUserId: builder.user.id,
      targetType: "idea",
      targetId: idea.id,
      score: 0.85,
      ...at,
    })
    await db.update(collabs).set({ createdAt: LATER }).where(eq(collabs.id, collab.id))
    await db.execute(sql`UPDATE proposals SET created_at = ${LATER} WHERE id = ${proposal.id}`)
    await insertOrder(db, launch.id, LATER)
    // 2. Creator's builder match (person target): same proposal, other direction.
    const person = await insertMatch(db, {
      subjectUserId: creator.user.id,
      targetType: "builder",
      targetId: builder.user.id,
      score: 0.65,
      ...at,
    })
    // 3. A declined proposal named by match_id.
    const declined = await insertMatch(db, {
      subjectUserId: third.user.id,
      targetType: "idea",
      targetId: otherIdea.id,
      score: 0.45,
      ...at,
    })
    const { proposal: declinedProposal } = await insertProposal(db, {
      fromUserId: third.user.id,
      toUserId: other.user.id,
      ideaId: otherIdea.id,
      status: "declined",
    })
    await db.execute(
      sql`UPDATE proposals SET match_id = ${declined.id}, created_at = ${LATER} WHERE id = ${declinedProposal.id}`,
    )
    // 4. A proposal sent before the match row existed is not linked.
    const tooEarly = await insertMatch(db, {
      subjectUserId: builder.user.id,
      targetType: "creator",
      targetId: creator.user.id,
      score: 0.25,
      ...at,
      createdAt: new Date("2026-09-20T00:00:00Z"),
    })
    // 5. Never shown: not in the data at all.
    await insertMatch(db, {
      subjectUserId: third.user.id,
      targetType: "creator",
      targetId: other.user.id,
      score: 0.05,
      ...at,
      shownAt: null,
    })

    const outcomes = new Map(
      (await loadMatchOutcomes(db, version)).map((row) => [row.matchId, row]),
    )
    expect(outcomes.size).toBe(4)
    expect(outcomes.get(sold.id)).toMatchObject({
      sent: true,
      accepted: true,
      live: true,
      sale: true,
    })
    expect(outcomes.get(person.id)).toMatchObject({ sent: true, accepted: true, sale: true })
    expect(outcomes.get(declined.id)).toMatchObject({ sent: true, accepted: false, sale: false })
    expect(outcomes.get(tooEarly.id)).toMatchObject({ sent: false, accepted: false })
    expect(outcomes.get(sold.id)?.firstProposalAt?.toISOString()).toBe(LATER.toISOString())

    // A refunded order is no sale.
    await db.execute(
      sql`UPDATE orders SET status = 'refunded', amount_refunded_cents = amount_gross_cents WHERE launch_id = ${launch.id}`,
    )
    const refunded = await loadMatchOutcomes(db, version)
    expect(refunded.find((row) => row.matchId === sold.id)).toMatchObject({
      live: true,
      sale: false,
    })

    const funnel = await scoreBucketFunnel(db, version)
    expect(funnel.buckets.map((bucket) => bucket.shown)).toEqual([0, 1, 1, 1, 1])
    expect(funnel.buckets[4]).toMatchObject({ sent: 1, accepted: 1, live: 1, sale: 0 })
    expect(funnel.buckets[3]).toMatchObject({ sent: 1, accepted: 1, live: 1 })
    expect(funnel.buckets[2]).toMatchObject({ sent: 1, accepted: 0 })
    expect(funnel.total).toMatchObject({ shown: 4, sent: 3, accepted: 2, live: 2, sale: 0 })
  })
})

describe("training, the flag and activation", () => {
  it("refuses to train without enough history", async () => {
    await expect(trainMatchingModel(testDb.db, { requestedByUserId: null })).rejects.toBeInstanceOf(
      InsufficientTrainingDataError,
    )
  })

  it("trains from the seeded history, stores it inactive, and gates and activates it", async () => {
    const db = testDb.db
    const seeded = await seedMatchingHistory.run({ db, now: NOW, log: () => undefined })
    expect(seeded).toEqual({ created: 600 })
    expect(await seedMatchingHistory.run({ db, now: NOW, log: () => undefined })).toEqual({
      skipped: "history already seeded",
    })
    const [historyUsers] = await db
      .select({ value: count() })
      .from(users)
      .where(and(sql`${users.email} LIKE 'seed-history-%'`, isNull(users.onboardingCompletedAt)))
    expect(historyUsers?.value).toBe(20)

    const v0Funnel = await scoreBucketFunnel(db, V0_MODEL_VERSION)
    expect(v0Funnel.total.shown).toBeGreaterThanOrEqual(600)
    expect(v0Funnel.total.accepted).toBeGreaterThan(40)
    expect(v0Funnel.total.sale).toBeGreaterThan(10)

    const admin = await insertAdmin()
    const trained = await trainMatchingModel(db, { requestedByUserId: admin.id })
    expect(trained.modelVersion).toBe("v1-2026-10-06")
    expect(trained.metrics.targets.accepted.v1!.auc!).toBeGreaterThan(
      trained.metrics.targets.accepted.v0.auc!,
    )
    expect(trained.metrics.targets.sale.fitted).toBe(true)
    const again = await trainMatchingModel(db, { requestedByUserId: null })
    expect(again.modelVersion).toBe("v1-2026-10-06-2")

    const versions = await listModelVersions(db)
    const stored = versions.find((version) => version.modelVersion === trained.modelVersion)
    expect(stored).toMatchObject({ kind: "logistic", active: false })
    expect(stored?.metrics?.rows.training).toBe(trained.metrics.rows.training)
    const trainedEvents = await db
      .select()
      .from(events)
      .where(eq(events.type, "matching.model_trained"))
    expect(trainedEvents).toHaveLength(2)
    const audits = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, "matching.model_trained"))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.adminUserId).toBe(admin.id)

    // Activation is audited; v1 does not rank before 50 completed launches unless forced.
    const activated = await activateMatchingModel(db, {
      adminUserId: admin.id,
      modelVersion: trained.modelVersion,
      flags: OFF,
    })
    expect(activated).toEqual({
      modelVersion: trained.modelVersion,
      previousVersion: "v0",
      forced: false,
    })
    const [completed] = await db
      .select({ value: count() })
      .from(launches)
      .where(isNotNull(launches.wentLiveAt))
    expect(completed!.value).toBeLessThan(MIN_COMPLETED_LAUNCHES_FOR_V1)
    const gated = await loadActiveMatchingConfig(db, { flags: OFF })
    expect(gated.modelVersion).toBe("v0")
    expect(gated.requestedVersion).toBe(trained.modelVersion)
    expect(gated.fallbackReason).toContain("50")
    const forced = await loadActiveMatchingConfig(db, { flags: FORCED })
    expect(forced).toMatchObject({ modelVersion: trained.modelVersion, kind: "logistic" })
    expect(forced.model).not.toBeNull()
    // Pins win over the active row; an unknown pin falls back to v0.
    expect(
      (await loadActiveMatchingConfig(db, { flags: { ...OFF, MATCHING_MODEL_VERSION: "v0" } }))
        .modelVersion,
    ).toBe("v0")
    const missing = await loadActiveMatchingConfig(db, {
      flags: { ...FORCED, MATCHING_MODEL_VERSION: "v1-2020-01-01" },
    })
    expect(missing.modelVersion).toBe("v0")
    expect(missing.fallbackReason).toContain("does not exist")

    // The recompute ranks with v1 when it may, and the v0 rows leave the list.
    const creator = await matchCreator(db, { topics: ["meal prep"], embedding: vector(1) })
    const builder = await matchBuilder(db, { skills: ["meal prep"], embedding: vector(1) })
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual", config: gated })
    const v0Rows = await db
      .select()
      .from(matches)
      .where(and(eq(matches.subjectUserId, creator.user.id), eq(matches.targetId, builder.user.id)))
    expect(v0Rows.map((row) => row.modelVersion)).toEqual(["v0"])
    const result = await recomputeMatchesForUser(db, creator.user.id, {
      reason: "manual",
      config: forced,
    })
    expect(result.modelVersion).toBe(trained.modelVersion)
    const rows = await db
      .select()
      .from(matches)
      .where(and(eq(matches.subjectUserId, creator.user.id), eq(matches.targetId, builder.user.id)))
    const v1Row = rows.find((row) => row.modelVersion === trained.modelVersion)
    const oldRow = rows.find((row) => row.modelVersion === "v0")
    expect(v1Row?.staleAt).toBeNull()
    expect(v1Row?.score).toBeGreaterThan(0)
    expect(oldRow?.staleAt).not.toBeNull()

    // With 50 completed launches v1 ranks without the force flag.
    for (let i = completed!.value; i < MIN_COMPLETED_LAUNCHES_FOR_V1; i++)
      await insertLiveLaunch(db)
    expect((await loadActiveMatchingConfig(db, { flags: OFF })).modelVersion).toBe(
      trained.modelVersion,
    )

    // Deactivating re-activates v0, audited; refusals are plain.
    await expect(
      activateMatchingModel(db, {
        adminUserId: admin.id,
        modelVersion: trained.modelVersion,
        flags: OFF,
      }),
    ).rejects.toThrow("already active")
    await expect(
      deactivateMatchingModel(db, { adminUserId: admin.id, modelVersion: "v0", flags: OFF }),
    ).rejects.toThrow("baseline")
    await deactivateMatchingModel(db, {
      adminUserId: admin.id,
      modelVersion: trained.modelVersion,
      flags: OFF,
    })
    const [active] = await db
      .select({ modelVersion: matchingConfig.modelVersion })
      .from(matchingConfig)
      .where(eq(matchingConfig.active, true))
    expect(active?.modelVersion).toBe("v0")
    const switchAudits = await db
      .select({ action: adminAuditLog.action })
      .from(adminAuditLog)
      .where(sql`${adminAuditLog.action} LIKE 'matching.model_%activated'`)
    expect(switchAudits.map((row) => row.action).sort()).toEqual([
      "matching.model_activated",
      "matching.model_deactivated",
    ])
    const activatedEvents = await db
      .select({ properties: events.properties })
      .from(events)
      .where(eq(events.type, "matching.model_activated"))
    expect(activatedEvents).toHaveLength(2)
  })

  it("lets only admins train and switch models through the actions", async () => {
    const creator = await matchCreator(testDb.db)
    mocks.user = {
      id: creator.user.id,
      email: "c@example.test",
      name: null,
      image: null,
      roles: ["creator"],
      activeRole: "creator",
      status: "active",
      onboardingCompletedAt: EARLY,
    }
    const refused = await trainMatchingModelAction({})
    expect(refused.ok).toBe(false)
    const refusedSwitch = await activateMatchingModelAction({ modelVersion: "v1-2026-10-06" })
    expect(refusedSwitch.ok).toBe(false)

    mocks.user = await insertAdmin()
    const trained = await trainMatchingModelAction({})
    expect(trained).toMatchObject({ ok: true, data: { modelVersion: "v1-2026-10-06-3" } })
    const on = await activateMatchingModelAction({ modelVersion: "v1-2026-10-06-3" })
    expect(on).toMatchObject({ ok: true, data: { previousVersion: "v0" } })
    const off = await deactivateMatchingModelAction({ modelVersion: "v1-2026-10-06-3" })
    expect(off).toMatchObject({ ok: true, data: { modelVersion: "v0" } })
    const bad = await activateMatchingModelAction({ modelVersion: "not-a-version" })
    expect(bad.ok).toBe(false)
  })
})
