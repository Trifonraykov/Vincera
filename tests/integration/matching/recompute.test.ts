import { and, eq, sql } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setClockForTests } from "@/lib/clock"
import {
  collabMembers,
  collabs,
  disputes,
  ideas,
  matches,
  products,
  savedItems,
  users,
} from "@/lib/db/schema"
import { explainMatches } from "@/lib/matching/explain"
import { explanationKey } from "@/lib/matching/explanation-text"
import { recomputeMatchesForUser, rescoreTarget, MATCH_LIST_SIZE } from "@/lib/matching/recompute"
import { V0_WEIGHTS } from "@/lib/matching/score"

import { setupTestDatabase } from "../../helpers/db"
import { insertIdea, insertProduct, insertProposal } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  addBuilderProfile,
  currentRows,
  eventsOf,
  matchBuilder,
  matchCreator,
  matchRows,
  vector,
} from "./helpers"

/**
 * Matching v0 runs against Postgres + pgvector (§8; CLAUDE.md §19.24, §19.27): candidates and
 * exclusions, ranking, the stored feature vector, the top-30 cap and stale rows, target rescores,
 * explanations cached with `ai.generated`, and statuses that survive recomputes.
 */

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeEach(async () => {
  stubServiceEnv()
  setClockForTests(NOW)
  // Tests share the file's database: earlier tests' people stop being candidates.
  await testDb.db.update(users).set({ status: "suspended" })
})
afterEach(() => setClockForTests(null))

async function seekingProduct(
  builderProfileId: string,
  overrides: Partial<typeof products.$inferInsert> = {},
) {
  return insertProduct(testDb.db, builderProfileId, {
    status: "seeking",
    stage: "beta",
    topics: ["meal prep"],
    embedding: vector(1, 2),
    targetPriceCents: 1900,
    ...overrides,
  })
}

async function openIdea(
  creatorProfileId: string,
  overrides: Partial<typeof ideas.$inferInsert> = {},
) {
  return insertIdea(testDb.db, creatorProfileId, {
    status: "open",
    topics: ["meal prep"],
    embedding: vector(1, 2),
    targetPriceCents: 1900,
    ...overrides,
  })
}

describe("recomputeMatchesForUser (creator)", () => {
  it("ranks seeking products and available builders with the full feature vector", async () => {
    const db = testDb.db
    const creator = await matchCreator(db, { topics: ["meal prep", "budget cooking"] })
    const close = await matchBuilder(db, { embedding: vector(1, 2), shipped: ["tool"] })
    const far = await matchBuilder(db, {
      embedding: vector(700, 701),
      skills: ["golang"],
      stack: [],
    })
    const closeProduct = await seekingProduct(close.profile.id, { format: "tool" })
    const farProduct = await seekingProduct(far.profile.id, {
      embedding: vector(700),
      topics: ["devops"],
    })

    const result = await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    expect(result.modelVersion).toBe("v0")
    expect(result.roles).toEqual([
      { role: "creator", eligible: true, candidates: 4, stored: 4, staled: 0 },
    ])

    const rows = await currentRows(db, creator.user.id)
    expect(rows.map((row) => `${row.targetType}:${row.targetId}`).sort()).toEqual(
      [
        `product:${closeProduct.id}`,
        `product:${farProduct.id}`,
        `builder:${close.user.id}`,
        `builder:${far.user.id}`,
      ].sort(),
    )
    const byTarget = new Map(rows.map((row) => [row.targetId, row]))
    const good = byTarget.get(closeProduct.id)
    const bad = byTarget.get(farProduct.id)
    expect(good && bad && good.score > bad.score).toBe(true)
    expect(good).toMatchObject({
      modelVersion: "v0",
      status: "shown",
      computedAt: NOW,
      staleAt: null,
      features: {
        semantic: 1,
        topic_overlap: 0.5, // {meal prep} vs {meal prep, budget cooking}
        format_fit: 1, // shipped a tool
        stage_fit: 1, // micro × beta
        price_fit: 0.5, // the creator has no idea with a price
        reliability: 0.5,
      },
    })
    expect(Object.keys(good?.features ?? {}).sort()).toEqual(
      [
        "audience_fit",
        "format_fit",
        "price_fit",
        "reliability",
        "semantic",
        "stage_fit",
        "topic_overlap",
      ].sort(),
    )

    const [computed] = await eventsOf(db, "match.computed", creator.user.id)
    expect(computed?.properties).toMatchObject({
      model_version: "v0",
      trigger: "manual",
      candidates: 4,
      stored: 4,
    })
    expect(computed?.properties.top_score).toBeCloseTo(Math.max(...rows.map((row) => row.score)))
  })

  it("excludes yourself, dismissed targets, closed builders and people who cannot be matched", async () => {
    const db = testDb.db
    const creator = await matchCreator(db)
    // The creator is also a builder, with a product of their own.
    const ownProfile = await addBuilderProfile(db, creator.user.id, creator.profile.handle)
    const ownProduct = await seekingProduct(ownProfile.id)
    const closed = await matchBuilder(db, { availability: "closed" })
    const notOnboarded = await matchBuilder(db, { onboarded: false })
    const suspended = await matchBuilder(db)
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, suspended.user.id))
    const dismissedTarget = await matchBuilder(db)
    const kept = await matchBuilder(db)
    const draft = await insertProduct(db, kept.profile.id, { status: "draft" })
    const suspendedProduct = await seekingProduct(suspended.profile.id)
    const closedOwnersProduct = await seekingProduct(closed.profile.id)

    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    const first = await currentRows(db, creator.user.id)
    const dismissedRow = first.find((row) => row.targetId === dismissedTarget.user.id)
    if (!dismissedRow) throw new Error("expected a row for the builder to dismiss")
    await db.update(matches).set({ status: "dismissed" }).where(eq(matches.id, dismissedRow.id))

    const result = await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    // Both roles have a list; the builder side sees no idea of their own (they have none here).
    expect(result.roles.map((role) => role.role)).toEqual(["creator", "builder"])
    const rows = await currentRows(db, creator.user.id)
    const targets = rows.map((row) => row.targetId)
    expect(targets).toContain(kept.user.id)
    // A closed builder is not a candidate, but their seeking product is.
    expect(targets).not.toContain(closed.user.id)
    expect(targets).toContain(closedOwnersProduct.id)
    for (const excluded of [
      creator.user.id,
      ownProduct.id,
      notOnboarded.user.id,
      suspended.user.id,
      suspendedProduct.id,
      draft.id,
      dismissedTarget.user.id,
    ]) {
      expect(targets).not.toContain(excluded)
    }
    // The dismissed row is kept (training data), out of the list, still dismissed.
    const [dismissed] = await db.select().from(matches).where(eq(matches.id, dismissedRow.id))
    expect(dismissed).toMatchObject({ status: "dismissed", staleAt: NOW })
  })
})

describe("recomputeMatchesForUser (builder)", () => {
  it("ranks open ideas and creators with a verified connection", async () => {
    const db = testDb.db
    const builder = await matchBuilder(db, { shipped: ["app"] })
    const verified = await matchCreator(db)
    const unverified = await matchCreator(db, { audience: null })
    const idea = await openIdea(verified.profile.id, { format: "app" })
    const draftIdea = await insertIdea(db, unverified.profile.id, { status: "draft" })
    const unverifiedIdea = await openIdea(unverified.profile.id)

    const result = await recomputeMatchesForUser(db, builder.user.id, { reason: "nightly" })
    expect(result.roles).toEqual([
      { role: "builder", eligible: true, candidates: 3, stored: 3, staled: 0 },
    ])
    const rows = await currentRows(db, builder.user.id)
    const targets = rows.map((row) => `${row.targetType}:${row.targetId}`)
    expect(targets).toEqual(
      expect.arrayContaining([
        `idea:${idea.id}`,
        `idea:${unverifiedIdea.id}`,
        `creator:${verified.user.id}`,
      ]),
    )
    expect(targets).not.toContain(`creator:${unverified.user.id}`)
    expect(targets).not.toContain(`idea:${draftIdea.id}`)
    expect(rows.find((row) => row.targetId === idea.id)?.features.format_fit).toBe(1)
    const [computed] = await eventsOf(db, "match.computed", builder.user.id)
    expect(computed?.properties.trigger).toBe("nightly")
  })

  it("counts completed collabs up and disputes against the person down (reliability)", async () => {
    const db = testDb.db
    const builder = await matchBuilder(db)
    const trusted = await matchCreator(db)
    const disputed = await matchCreator(db)
    const trustedIdea = await openIdea(trusted.profile.id)
    const disputedIdea = await openIdea(disputed.profile.id)

    for (const [creator, stage] of [
      [trusted, "live"],
      [disputed, "building"],
    ] as const) {
      const past = await insertIdea(db, creator.profile.id, { status: "in_collab" })
      const other = await matchBuilder(db)
      const { proposal } = await insertProposal(db, {
        fromUserId: other.user.id,
        toUserId: creator.user.id,
        ideaId: past.id,
        status: "accepted",
      })
      const [collab] = await db
        .insert(collabs)
        .values({ proposalId: proposal.id, ideaId: past.id, stage })
        .returning()
      if (!collab) throw new Error("no collab")
      await db.insert(collabMembers).values([
        { collabId: collab.id, userId: creator.user.id, role: "creator", splitPct: 50 },
        { collabId: collab.id, userId: other.user.id, role: "builder", splitPct: 50 },
      ])
      if (stage === "building") {
        await db.insert(disputes).values({
          collabId: collab.id,
          raisedByUserId: other.user.id,
          kind: "non_delivery",
          description: "Nothing delivered.",
        })
      }
    }

    await recomputeMatchesForUser(db, builder.user.id, { reason: "manual" })
    const rows = await currentRows(db, builder.user.id)
    expect(rows.find((row) => row.targetId === trustedIdea.id)?.features.reliability).toBe(0.625)
    expect(rows.find((row) => row.targetId === disputedIdea.id)?.features.reliability).toBeCloseTo(
      0.3,
    )
  })
})

describe("the stored list", () => {
  it("keeps the top 30, stales the rest, and is idempotent", async () => {
    const db = testDb.db
    const creator = await matchCreator(db)
    const owner = await matchBuilder(db, { availability: "closed" })
    const created = []
    for (let i = 0; i < MATCH_LIST_SIZE + 3; i += 1) {
      // Descending similarity: product i shares fewer dimensions with the creator.
      created.push(
        await seekingProduct(owner.profile.id, {
          embedding: i < 10 ? vector(1, 2) : vector(1, 500 + i),
          topics: [],
          title: `Product ${i}`,
        }),
      )
    }
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    const first = await currentRows(db, creator.user.id)
    expect(first).toHaveLength(MATCH_LIST_SIZE)
    expect(await matchRows(db, creator.user.id)).toHaveLength(MATCH_LIST_SIZE)

    // A product drops out (archived); the next best takes its place, the old row stays as history.
    const leaving = first[0]
    if (!leaving) throw new Error("no row")
    await db
      .update(products)
      .set({ status: "archived", archivedAt: NOW })
      .where(eq(products.id, leaving.targetId))
    setClockForTests(new Date(NOW.getTime() + 60_000))
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    const second = await currentRows(db, creator.user.id)
    expect(second).toHaveLength(MATCH_LIST_SIZE)
    expect(second.map((row) => row.targetId)).not.toContain(leaving.targetId)
    const all = await matchRows(db, creator.user.id)
    expect(all).toHaveLength(MATCH_LIST_SIZE + 1)
    expect(all.find((row) => row.id === leaving.id)?.staleAt).toEqual(
      new Date(NOW.getTime() + 60_000),
    )

    // Same data again: same rows, nothing new.
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    expect(await matchRows(db, creator.user.id)).toHaveLength(MATCH_LIST_SIZE + 1)
    expect(created).toHaveLength(MATCH_LIST_SIZE + 3)
  })

  it("never changes a status, and a new model's row starts saved when the target was saved", async () => {
    const db = testDb.db
    const creator = await matchCreator(db)
    const builder = await matchBuilder(db)
    const product = await seekingProduct(builder.profile.id)
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    const [row] = (await currentRows(db, creator.user.id)).filter((r) => r.targetId === product.id)
    if (!row) throw new Error("no row")
    await db.update(matches).set({ status: "saved" }).where(eq(matches.id, row.id))
    await db
      .insert(savedItems)
      .values({ userId: creator.user.id, targetType: "product", targetId: product.id })
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    const [after] = await db.select().from(matches).where(eq(matches.id, row.id))
    expect(after?.status).toBe("saved")

    // Matching v1 becomes active: its rows are new, the saved target starts saved.
    await db.execute(sql`UPDATE matching_config SET active = false`)
    await db.execute(
      sql`INSERT INTO matching_config (id, model_version, weights, active) SELECT gen_random_uuid(), 'v1', weights, true FROM matching_config WHERE model_version = 'v0'`,
    )
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    const [v1] = await db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.subjectUserId, creator.user.id),
          eq(matches.targetId, product.id),
          eq(matches.modelVersion, "v1"),
        ),
      )
    expect(v1?.status).toBe("saved")
    await db.execute(sql`DELETE FROM matches WHERE model_version = 'v1'`)
    await db.execute(sql`DELETE FROM matching_config WHERE model_version = 'v1'`)
    await db.execute(sql`UPDATE matching_config SET active = true WHERE model_version = 'v0'`)
  })

  it("stales a person's whole list when they can no longer be matched", async () => {
    const db = testDb.db
    const creator = await matchCreator(db)
    const builder = await matchBuilder(db)
    await seekingProduct(builder.profile.id)
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    expect(await currentRows(db, creator.user.id)).toHaveLength(2)
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, creator.user.id))
    const result = await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    expect(result.roles).toEqual([
      { role: "creator", eligible: false, candidates: 0, stored: 0, staled: 2 },
    ])
    expect(await currentRows(db, creator.user.id)).toHaveLength(0)
  })
})

describe("explanations", () => {
  it("caches the sentence with its prompt version and ai.generated, and keeps it while the top two hold", async () => {
    const db = testDb.db
    const creator = await matchCreator(db, { topics: ["meal prep"] })
    const builder = await matchBuilder(db)
    const product = await seekingProduct(builder.profile.id)

    const first = await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    expect(first.pending).toHaveLength(2)
    const pendingProduct = first.pending.find((item) => item.input.targetType === "product")
    expect(pendingProduct?.input.evidence?.sharedTopics).toEqual(["meal prep"])
    const explained = await explainMatches(db, first.pending)
    expect(explained).toEqual({ generated: 2, stored: 2, fallbacks: 0 })

    const [row] = (await currentRows(db, creator.user.id)).filter((r) => r.targetId === product.id)
    expect(row?.explanation).toMatch(/meal prep/)
    expect(row?.explanationPromptVersion).toBe("match_explanation@v1")
    const generated = await eventsOf(db, "ai.generated", row?.id)
    expect(generated).toHaveLength(1)
    expect(generated[0]?.properties).toMatchObject({
      use: "match_explanation",
      prompt_version: "match_explanation@v1",
      accepted_by_user: null,
      fallback: false,
    })

    // Unchanged data: the sentence is kept and nothing is pending.
    const second = await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    expect(second.pending).toHaveLength(0)

    // The leading features change (no topics in common any more): the sentence is cleared.
    await db
      .update(products)
      .set({ topics: ["devops"], embedding: vector(900) })
      .where(eq(products.id, product.id))
    const third = await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    const [cleared] = await db
      .select()
      .from(matches)
      .where(eq(matches.id, row?.id ?? ""))
    expect(cleared?.explanation).toBeNull()
    expect(third.pending.map((item) => item.matchId)).toContain(row?.id)
    expect(explanationKey(cleared?.features ?? row!.features, V0_WEIGHTS)).not.toBe(
      explanationKey(row!.features, V0_WEIGHTS),
    )
  })

  it("stores nothing when the model fails, and never overwrites a row that changed meanwhile", async () => {
    const db = testDb.db
    const creator = await matchCreator(db)
    const builder = await matchBuilder(db)
    await seekingProduct(builder.profile.id)
    const { pending } = await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    const failing = await explainMatches(db, pending, {
      transport: async () => {
        throw new Error("down")
      },
    })
    expect(failing).toEqual({ generated: 2, stored: 0, fallbacks: 2 })
    for (const row of await currentRows(db, creator.user.id)) expect(row.explanation).toBeNull()
    const pendingIds = new Set(pending.map((item) => item.matchId))
    const generated = (await eventsOf(db, "ai.generated")).filter((event) =>
      pendingIds.has(event.subjectId ?? ""),
    )
    expect(generated.map((event) => event.properties.fallback)).toEqual([true, true])

    // A row whose features changed since: the late sentence is not written.
    const [target] = pending
    if (!target) throw new Error("no pending")
    await db
      .update(matches)
      .set({ features: { ...target.features, reliability: 1 } })
      .where(eq(matches.id, target.matchId))
    const late = await explainMatches(db, [target])
    expect(late).toEqual({ generated: 1, stored: 0, fallbacks: 0 })
  })
})

describe("rescoreTarget", () => {
  it("merges a newly published product into the lists of creators who may see it", async () => {
    const db = testDb.db
    const creatorA = await matchCreator(db)
    const creatorB = await matchCreator(db)
    const builder = await matchBuilder(db)
    await recomputeMatchesForUser(db, creatorA.user.id, { reason: "manual" })
    expect((await currentRows(db, creatorA.user.id)).map((row) => row.targetType)).toEqual([
      "builder",
    ])

    const product = await seekingProduct(builder.profile.id)
    const results = await rescoreTarget(db, { targetType: "product", targetId: product.id })
    expect(results.map(({ pending: _pending, ...result }) => result)).toEqual([
      { targetType: "product", targetId: product.id, eligible: true, subjects: 2, changed: 2 },
      // The owner is re-scored as a person too (their products changed).
      { targetType: "builder", targetId: builder.user.id, eligible: true, subjects: 2, changed: 2 },
    ])
    for (const creator of [creatorA, creatorB]) {
      const targets = (await currentRows(db, creator.user.id)).map((row) => row.targetId)
      expect(targets).toEqual(expect.arrayContaining([product.id, builder.user.id]))
    }
    // No match.computed for a rescore (only full recomputes summarise a list).
    expect(await eventsOf(db, "match.computed", creatorB.user.id)).toHaveLength(0)
  })

  it("stales every row of a target that stopped being a candidate", async () => {
    const db = testDb.db
    const creator = await matchCreator(db)
    const builder = await matchBuilder(db)
    const product = await seekingProduct(builder.profile.id)
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    await db
      .update(products)
      .set({ status: "archived", archivedAt: NOW })
      .where(eq(products.id, product.id))
    const [result] = await rescoreTarget(db, { targetType: "product", targetId: product.id })
    expect(result).toMatchObject({ eligible: false, changed: 1 })
    expect((await currentRows(db, creator.user.id)).map((row) => row.targetId)).toEqual([
      builder.user.id,
    ])
  })

  it("pushes the lowest row out of a full list, and skips people who dismissed the target", async () => {
    const db = testDb.db
    const creator = await matchCreator(db, { topics: [] })
    const other = await matchCreator(db)
    const owner = await matchBuilder(db, { availability: "closed" })
    for (let i = 0; i < MATCH_LIST_SIZE; i += 1) {
      await seekingProduct(owner.profile.id, { embedding: vector(1, 600 + i), topics: [] })
    }
    await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
    await recomputeMatchesForUser(db, other.user.id, { reason: "manual" })
    const before = await currentRows(db, creator.user.id)
    expect(before).toHaveLength(MATCH_LIST_SIZE)
    // The list's order: score, then target type and id (ties are common here).
    const lowest = [...before]
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.targetType.localeCompare(b.targetType) ||
          a.targetId.localeCompare(b.targetId),
      )
      .at(-1)

    const best = await seekingProduct(owner.profile.id, { embedding: vector(1, 2) })
    // `other` dismissed it before it was even scored for them (a stale dismissal row).
    await db.insert(matches).values({
      subjectUserId: other.user.id,
      targetType: "product",
      targetId: best.id,
      score: 0.1,
      features: {
        semantic: 0.1,
        topic_overlap: 0.1,
        audience_fit: 0.1,
        format_fit: 0.5,
        stage_fit: 0.5,
        price_fit: 0.5,
        reliability: 0.5,
      },
      modelVersion: "v0",
      computedAt: NOW,
      status: "dismissed",
    })
    const [result] = await rescoreTarget(
      db,
      { targetType: "product", targetId: best.id },
      { includeOwner: false },
    )
    expect(result).toMatchObject({ eligible: true, subjects: 1 })
    const after = await currentRows(db, creator.user.id)
    expect(after).toHaveLength(MATCH_LIST_SIZE)
    expect(after.map((row) => row.targetId)).toContain(best.id)
    expect(after.map((row) => row.id)).not.toContain(lowest?.id)
  })
})
