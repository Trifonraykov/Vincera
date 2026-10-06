import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { findJob } from "@/inngest/functions"
import { setClockForTests } from "@/lib/clock"
import { sha256Hex } from "@/lib/crypto"
import { builderProfiles, creatorProfiles, ideas, products } from "@/lib/db/schema"
import { requestProfileEmbeddingRefresh } from "@/lib/embeddings/request"
import { refreshEmbedding } from "@/lib/embeddings/refresh"
import { ideaEmbeddingText } from "@/lib/embeddings/entities"

import { setupTestDatabase } from "../../helpers/db"
import { insertIdea, insertPortfolioItem, insertProduct } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import { newBuilder, newCreator, stubMatchingJobs } from "./helpers"

/**
 * The `embeddings-refresh` job (§13; CLAUDE.md §19.24 "Embeddings", §19.25): composed text,
 * skipped API calls for unchanged text, re-embedding on a model change, provider failures keeping
 * the old vector, a newer edit winning over a slow run, and matching asked after every run.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const LIVE_ENV = { VOYAGE_API_KEY: "pa-test", FAKE_SERVICES: "" }

beforeEach(() => {
  stubServiceEnv()
  setClockForTests(NOW)
  mocks.db = testDb.db
})
afterEach(() => setClockForTests(null))

/** A Voyage-shaped answer with one 1024-dim vector. */
function voyageReply(): Response {
  const embedding = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))
  return Response.json({ data: [{ index: 0, embedding }] })
}

async function ideaRow(id: string) {
  const [row] = await testDb.db.select().from(ideas).where(eq(ideas.id, id))
  if (!row) throw new Error("no idea")
  return row
}

async function openIdea() {
  const creator = await newCreator(testDb.db)
  const idea = await insertIdea(testDb.db, creator.profile.id, {
    status: "open",
    problem: "Students run out of money.",
    topics: ["budgeting"],
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  })
  return { creator, idea }
}

describe("refreshEmbedding", () => {
  it("embeds an idea once, records the text hash, and leaves updated_at alone", async () => {
    const { creator, idea } = await openIdea()
    const entity = { type: "idea", id: idea.id } as const
    expect(await refreshEmbedding(testDb.db, entity)).toEqual({
      outcome: "updated",
      ownerUserId: creator.user.id,
    })
    const row = await ideaRow(idea.id)
    expect(row).toMatchObject({
      embeddingModel: "fake:hashed-bow-1024",
      embeddingTextHash: sha256Hex(ideaEmbeddingText(row)),
      embeddedAt: NOW,
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    })
    expect(row.embedding).toHaveLength(1024)

    // Same text and model: nothing is embedded or written again.
    setClockForTests(new Date("2026-10-05T13:00:00.000Z"))
    expect((await refreshEmbedding(testDb.db, entity)).outcome).toBe("unchanged")
    expect((await ideaRow(idea.id)).embeddedAt).toEqual(NOW)
  })

  it("re-embeds when the text or the model changes", async () => {
    const { idea } = await openIdea()
    const entity = { type: "idea", id: idea.id } as const
    await refreshEmbedding(testDb.db, entity)
    await testDb.db.update(ideas).set({ title: "A better title" }).where(eq(ideas.id, idea.id))
    expect((await refreshEmbedding(testDb.db, entity)).outcome).toBe("updated")

    stubServiceEnv(LIVE_ENV)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => voyageReply())
    expect((await refreshEmbedding(testDb.db, entity, { fetch })).outcome).toBe("updated")
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await ideaRow(idea.id)).embeddingModel).toBe("voyage:voyage-3.5")
  })

  it("keeps the old vector when the provider fails", async () => {
    const { idea } = await openIdea()
    const entity = { type: "idea", id: idea.id } as const
    await refreshEmbedding(testDb.db, entity)
    const before = await ideaRow(idea.id)
    await testDb.db.update(ideas).set({ title: "Changed" }).where(eq(ideas.id, idea.id))

    stubServiceEnv(LIVE_ENV)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("down", { status: 503 }))
    expect((await refreshEmbedding(testDb.db, entity, { fetch })).outcome).toBe("failed")
    const after = await ideaRow(idea.id)
    expect(after.embeddingTextHash).toBe(before.embeddingTextHash)
    expect(after.embedding).toEqual(before.embedding)
  })

  it("gives way to an edit made while the provider was answering", async () => {
    const { idea } = await openIdea()
    stubServiceEnv(LIVE_ENV)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await testDb.db.update(ideas).set({ title: "Edited meanwhile" }).where(eq(ideas.id, idea.id))
      return voyageReply()
    })
    expect(
      (await refreshEmbedding(testDb.db, { type: "idea", id: idea.id }, { fetch })).outcome,
    ).toBe("superseded")
    expect((await ideaRow(idea.id)).embeddingTextHash).toBeNull()
  })

  it("embeds products and both kinds of profile, and skips profiles with nothing to say", async () => {
    const builder = await newBuilder(testDb.db)
    const product = await insertProduct(testDb.db, builder.profile.id, {
      description: "Invoices.",
      topics: ["invoicing"],
    })
    expect((await refreshEmbedding(testDb.db, { type: "product", id: product.id })).outcome).toBe(
      "updated",
    )
    const [productRow] = await testDb.db.select().from(products).where(eq(products.id, product.id))
    expect(productRow?.embedding).toHaveLength(1024)

    const builderEntity = { type: "builder_profile", id: builder.profile.id } as const
    expect((await refreshEmbedding(testDb.db, builderEntity)).outcome).toBe("skipped")
    await insertPortfolioItem(testDb.db, builder.profile.id)
    expect(await refreshEmbedding(testDb.db, builderEntity)).toEqual({
      outcome: "updated",
      ownerUserId: builder.user.id,
    })

    const creator = await newCreator(testDb.db)
    const creatorEntity = { type: "creator_profile", id: creator.profile.id } as const
    expect((await refreshEmbedding(testDb.db, creatorEntity)).outcome).toBe("skipped")
    await testDb.db
      .update(creatorProfiles)
      .set({ niche: "Budget cooking", topics: ["meal prep"] })
      .where(eq(creatorProfiles.id, creator.profile.id))
    expect((await refreshEmbedding(testDb.db, creatorEntity)).outcome).toBe("updated")

    expect(
      await refreshEmbedding(testDb.db, {
        type: "product",
        id: "0190a000-0000-7000-8000-00000000dead",
      }),
    ).toEqual({ outcome: "not_found", ownerUserId: null })
  })
})

describe("embeddings-refresh job", () => {
  const job = findJob("embeddings-refresh")

  it("embeds, then asks matching to rescore the target and rebuild the owner's list", async () => {
    const matching = stubMatchingJobs()
    const { creator, idea } = await openIdea()
    expect(await job?.runInline({ subjectType: "idea", subjectId: idea.id })).toEqual({
      type: "idea",
      id: idea.id,
      outcome: "updated",
      ownerUserId: creator.user.id,
    })
    expect(matching.rescore[0]).toHaveBeenCalledWith({ targetType: "idea", targetId: idea.id })
    expect(matching.recompute[0]).toHaveBeenCalledWith({
      userId: creator.user.id,
      reason: "idea_changed",
    })

    // Unchanged text still asks matching (a status change matters to it too).
    matching.rescore[0]?.mockClear()
    await job?.runInline({ subjectType: "idea", subjectId: idea.id })
    expect(matching.rescore[0]).toHaveBeenCalledTimes(1)
  })

  it("treats profiles as people targets, and does nothing for unknown ids", async () => {
    const matching = stubMatchingJobs()
    const builder = await newBuilder(testDb.db)
    await insertPortfolioItem(testDb.db, builder.profile.id)
    await job?.runInline({ subjectType: "builder_profile", subjectId: builder.profile.id })
    expect(matching.recompute[0]).toHaveBeenCalledWith({
      userId: builder.user.id,
      reason: "profile_changed",
    })
    expect(matching.rescore[0]).toHaveBeenCalledWith({
      targetType: "builder",
      targetId: builder.user.id,
    })
    const [row] = await testDb.db
      .select()
      .from(builderProfiles)
      .where(eq(builderProfiles.id, builder.profile.id))
    expect(row?.embeddedAt).toEqual(NOW)

    matching.recompute[0]?.mockClear()
    matching.rescore[0]?.mockClear()
    expect(
      await job?.runInline({
        subjectType: "creator_profile",
        subjectId: "0190a000-0000-7000-8000-00000000beef",
      }),
    ).toMatchObject({ outcome: "not_found" })
    expect(matching.recompute[0]).not.toHaveBeenCalled()
    expect(matching.rescore[0]).not.toHaveBeenCalled()
  })

  it("is what profile changes ask for (requestProfileEmbeddingRefresh)", async () => {
    stubMatchingJobs()
    const creator = await newCreator(testDb.db)
    await testDb.db
      .update(creatorProfiles)
      .set({ bio: "Weekly videos about money." })
      .where(eq(creatorProfiles.id, creator.profile.id))
    await requestProfileEmbeddingRefresh(creator.user.id, "creator", testDb.db)
    const [row] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.id, creator.profile.id))
    expect(row?.embeddedAt).toEqual(NOW)
    expect(row?.embeddingTextHash).toMatch(/^[0-9a-f]{64}$/)
    // A user without that profile: nothing to refresh.
    await expect(
      requestProfileEmbeddingRefresh(creator.user.id, "builder", testDb.db),
    ).resolves.toBeUndefined()
  })
})
