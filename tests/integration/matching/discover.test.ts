import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { matches, products, savedItems, users } from "@/lib/db/schema"
import { runJobsNow } from "@/lib/jobs/enqueue"
import {
  dismissMatch,
  markMatchesShown,
  MATCH_MESSAGES,
  recordMatchClick,
  saveMatch,
  unsaveMatch,
} from "@/lib/matching/interactions"
import { listCurrentMatches, listOtherOpenBriefs, listSavedMatches } from "@/lib/matching/queries"
import { recomputeMatchesForUser } from "@/lib/matching/recompute"
import { resetMemoryRateLimits } from "@/lib/ratelimit"

import { setupTestDatabase } from "../../helpers/db"
import { insertIdea, insertProduct } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import { currentRows, eventsOf, matchBuilder, matchCreator, vector } from "./helpers"

/**
 * What people do with matches (§8, §11; CLAUDE.md §19.24 "Statuses", §19.27): save, unsave and
 * dismiss persist and emit their events once; `match.shown` once per row; `match.clicked`; the
 * Discover queries hide targets that stopped being candidates; the server actions with a mocked
 * session; and the recompute and nightly jobs through the inline runner.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown, user: null as AuthUser | null }))
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

const {
  dismissMatchAction,
  markMatchesShownAction,
  openMatchAction,
  refreshMyMatchesAction,
  saveMatchAction,
} = await import("@/lib/matching/actions")
const { matchingNightlyFanOut } = await import("@/inngest/functions/matching-nightly")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeEach(async () => {
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
  mocks.db = testDb.db
  mocks.user = null
  // Tests share the file's database: earlier tests' people stop being candidates.
  await testDb.db.update(users).set({ status: "suspended" })
})
afterEach(() => setClockForTests(null))

/** A creator with one seeking product of a builder in their list. */
async function creatorWithProduct() {
  const db = testDb.db
  const creator = await matchCreator(db)
  const builder = await matchBuilder(db, { shipped: ["app"] })
  const product = await insertProduct(db, builder.profile.id, {
    status: "seeking",
    stage: "beta",
    topics: ["meal prep"],
    embedding: vector(1, 2),
    targetPriceCents: 1900,
  })
  await recomputeMatchesForUser(db, creator.user.id, { reason: "manual" })
  const [row] = await db
    .select()
    .from(matches)
    .where(and(eq(matches.subjectUserId, creator.user.id), eq(matches.targetId, product.id)))
  if (!row) throw new Error("no product match")
  return { creator, builder, product, match: row }
}

async function savedRows(userId: string) {
  return testDb.db.select().from(savedItems).where(eq(savedItems.userId, userId))
}

/** Next's redirect() throws an error whose digest carries the target. */
async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2] ?? ""
    }
    throw error
  }
  throw new Error("expected a redirect")
}

describe("save, unsave, dismiss", () => {
  it("saves once, keeps the status through recomputes, and unsaves", async () => {
    const db = testDb.db
    const { creator, product, match } = await creatorWithProduct()
    const userId = creator.user.id

    expect(await saveMatch(db, { userId, matchId: match.id, rank: 2 })).toEqual({
      changed: true,
      status: "saved",
    })
    // A double tap changes nothing and records nothing.
    expect(await saveMatch(db, { userId, matchId: match.id, rank: 2 })).toEqual({
      changed: false,
      status: "saved",
    })
    expect(await savedRows(userId)).toMatchObject([{ targetType: "product", targetId: product.id }])
    const saved = await eventsOf(db, "match.saved", match.id)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      actorUserId: userId,
      subjectType: "match",
      properties: { model_version: "v0", target_type: "product", rank: 2 },
    })

    await recomputeMatchesForUser(db, userId, { reason: "manual" })
    const [kept] = await db.select().from(matches).where(eq(matches.id, match.id))
    expect(kept).toMatchObject({ status: "saved", staleAt: null })

    expect(await unsaveMatch(db, { userId, matchId: match.id, rank: null })).toEqual({
      changed: true,
      status: "shown",
    })
    expect(await savedRows(userId)).toEqual([])
    expect(await eventsOf(db, "match.unsaved", match.id)).toHaveLength(1)
    await unsaveMatch(db, { userId, matchId: match.id, rank: null })
    expect(await eventsOf(db, "match.unsaved", match.id)).toHaveLength(1)
  })

  it("dismisses for good: unsaved, out of the list, and never a candidate again", async () => {
    const db = testDb.db
    const { creator, product, match } = await creatorWithProduct()
    const userId = creator.user.id
    await saveMatch(db, { userId, matchId: match.id, rank: 1 })

    expect(await dismissMatch(db, { userId, matchId: match.id, rank: 1 })).toEqual({
      changed: true,
      status: "dismissed",
    })
    expect(await dismissMatch(db, { userId, matchId: match.id, rank: 1 })).toEqual({
      changed: false,
      status: "dismissed",
    })
    expect(await eventsOf(db, "match.dismissed", match.id)).toHaveLength(1)
    expect(await savedRows(userId)).toEqual([])
    await expect(saveMatch(db, { userId, matchId: match.id, rank: 1 })).rejects.toThrow(
      MATCH_MESSAGES.dismissed,
    )

    expect(
      (await listCurrentMatches(db, userId, "creator")).map((view) => view.target.id),
    ).not.toContain(product.id)
    await recomputeMatchesForUser(db, userId, { reason: "manual" })
    expect((await currentRows(db, userId)).map((row) => row.targetId)).not.toContain(product.id)
    const [row] = await db.select().from(matches).where(eq(matches.id, match.id))
    expect(row?.status).toBe("dismissed")
  })

  it("refuses another person's match as not found", async () => {
    const db = testDb.db
    const { match } = await creatorWithProduct()
    const other = await matchCreator(db)
    await expect(
      saveMatch(db, { userId: other.user.id, matchId: match.id, rank: null }),
    ).rejects.toThrow(MATCH_MESSAGES.notFound)
    await expect(
      dismissMatch(db, { userId: other.user.id, matchId: match.id, rank: null }),
    ).rejects.toThrow(MATCH_MESSAGES.notFound)
  })
})

describe("shown and clicked", () => {
  it("records match.shown once per row, only for the person's own rows", async () => {
    const db = testDb.db
    const { creator, match } = await creatorWithProduct()
    const other = await creatorWithProduct()
    const items = [
      { matchId: match.id, rank: 1 },
      { matchId: other.match.id, rank: 2 },
    ]
    expect(await markMatchesShown(db, { userId: creator.user.id, items })).toEqual({ marked: 1 })
    expect(await markMatchesShown(db, { userId: creator.user.id, items })).toEqual({ marked: 0 })
    const shown = await eventsOf(db, "match.shown", match.id)
    expect(shown).toHaveLength(1)
    expect(shown[0]?.properties).toMatchObject({ rank: 1, target_type: "product" })
    expect(await eventsOf(db, "match.shown", other.match.id)).toEqual([])
    const [row] = await db.select().from(matches).where(eq(matches.id, match.id))
    expect(row?.shownAt).toEqual(NOW)
  })

  it("records match.clicked and leads to the target's page", async () => {
    const db = testDb.db
    const { creator, builder, product, match } = await creatorWithProduct()
    expect(
      await recordMatchClick(db, { userId: creator.user.id, matchId: match.id, rank: 3 }),
    ).toBe(`/app/products/${product.id}`)
    expect(await eventsOf(db, "match.clicked", match.id)).toHaveLength(1)

    const [builderMatch] = await db
      .select()
      .from(matches)
      .where(and(eq(matches.subjectUserId, creator.user.id), eq(matches.targetId, builder.user.id)))
    expect(
      await recordMatchClick(db, {
        userId: creator.user.id,
        matchId: builderMatch!.id,
        rank: null,
      }),
    ).toBe(`/b/${builder.profile.handle}`)
  })
})

describe("Discover queries", () => {
  it("lists current matches best first with a sentence, hiding targets that closed", async () => {
    const db = testDb.db
    const { creator, product, match } = await creatorWithProduct()
    const list = await listCurrentMatches(db, creator.user.id, "creator")
    expect(list.map((view) => view.target.type).sort()).toEqual(["builder", "product"])
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.score).toBeGreaterThanOrEqual(list[i]!.score)
    }
    // No cached sentence yet: the template for the same two features.
    const view = list.find((entry) => entry.id === match.id)
    expect(view?.explanation).toMatch(/^[A-Z].+\.$/)
    expect(view?.target).toMatchObject({ type: "product", available: true })

    await saveMatch(db, { userId: creator.user.id, matchId: match.id, rank: 1 })
    await db
      .update(products)
      .set({ status: "archived", archivedAt: NOW })
      .where(eq(products.id, product.id))
    expect(
      (await listCurrentMatches(db, creator.user.id, "creator")).map((entry) => entry.id),
    ).not.toContain(match.id)
    // Saved keeps it, marked as no longer open.
    const saved = await listSavedMatches(db, creator.user.id, "creator")
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ id: match.id, target: { available: false } })
  })

  it("lists other open briefs for a builder, without their own or dismissed ones", async () => {
    const db = testDb.db
    const builder = await matchBuilder(db)
    const creator = await matchCreator(db)
    const shown = await insertIdea(db, creator.profile.id, {
      status: "open",
      publishedAt: NOW,
      embedding: vector(1, 2),
    })
    const dismissed = await insertIdea(db, creator.profile.id, {
      status: "open",
      publishedAt: NOW,
      embedding: vector(1, 2),
    })
    const draft = await insertIdea(db, creator.profile.id, { status: "draft" })
    await recomputeMatchesForUser(db, builder.user.id, { reason: "manual" })
    const [dismissedRow] = await db
      .select()
      .from(matches)
      .where(and(eq(matches.subjectUserId, builder.user.id), eq(matches.targetId, dismissed.id)))
    await dismissMatch(db, { userId: builder.user.id, matchId: dismissedRow!.id, rank: null })

    const briefs = await listOtherOpenBriefs(db, builder.user.id)
    const ids = briefs.items.map((item) => item.id)
    expect(ids).toContain(shown.id)
    expect(ids).not.toContain(dismissed.id)
    expect(ids).not.toContain(draft.id)
    expect(
      (await listOtherOpenBriefs(db, builder.user.id, { excludeIds: [shown.id] })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(shown.id)
  })
})

describe("server actions", () => {
  it("lets only the match's own person act on it", async () => {
    const db = testDb.db
    const { creator, match } = await creatorWithProduct()
    const stranger = await matchCreator(db)

    mocks.user = stranger.auth
    const refused = await saveMatchAction({ matchId: match.id, rank: 1 })
    expect(refused.ok).toBe(false)
    expect((await markMatchesShownAction({ items: [{ matchId: match.id, rank: 1 }] })).ok).toBe(
      false,
    )
    const missing = await dismissMatchAction({ matchId: "0190a0a0-0000-7000-8000-000000000000" })
    expect(missing).toMatchObject({ ok: false, error: MATCH_MESSAGES.notFound })

    mocks.user = creator.auth
    expect(await saveMatchAction({ matchId: match.id, rank: "1" })).toMatchObject({
      ok: true,
      data: { status: "saved" },
    })
    expect(await markMatchesShownAction({ items: [{ matchId: match.id, rank: 1 }] })).toEqual({
      ok: true,
      data: { marked: 1 },
    })
    expect(await redirectTarget(openMatchAction({ matchId: match.id, rank: 1 }))).toBe(
      `/app/products/${match.targetId}`,
    )
    expect(await dismissMatchAction({ matchId: match.id })).toMatchObject({
      ok: true,
      data: { status: "dismissed" },
    })
    expect((await saveMatchAction({ matchId: "not-a-uuid" })).ok).toBe(false)
  })

  it("refreshes a person's matches with explanations, a few times an hour", async () => {
    const db = testDb.db
    const { creator } = await creatorWithProduct()
    await db.delete(matches).where(eq(matches.subjectUserId, creator.user.id))
    mocks.user = creator.auth

    expect(await refreshMyMatchesAction({ role: "creator" })).toEqual({
      ok: true,
      data: { stored: 2 },
    })
    const rows = await currentRows(db, creator.user.id)
    expect(rows).toHaveLength(2)
    // Outside a request the explanations run inline (fake AI: the template sentence).
    expect(rows.every((row) => row.explanation && row.explanationPromptVersion)).toBe(true)
    expect((await refreshMyMatchesAction({ role: "builder" })).ok).toBe(false)

    for (let i = 0; i < 4; i++) await refreshMyMatchesAction({ role: "creator" })
    expect(await refreshMyMatchesAction({ role: "creator" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("just updated"),
    })
  })
})

describe("jobs", () => {
  it("matching-recompute stores the list and caches explanations with ai.generated", async () => {
    const db = testDb.db
    const { creator } = await creatorWithProduct()
    await db.delete(matches).where(eq(matches.subjectUserId, creator.user.id))

    await runJobsNow("matching/recompute.requested", {
      userId: creator.user.id,
      reason: "profile_changed",
    })
    const rows = await currentRows(db, creator.user.id)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.explanationPromptVersion).toBe("match_explanation@v1")
      expect(await eventsOf(db, "ai.generated", row.id)).toHaveLength(1)
    }
    const computed = await eventsOf(db, "match.computed", creator.user.id)
    expect(computed.at(-1)?.properties).toMatchObject({ trigger: "on_change", stored: 2 })
  })

  it("matching-nightly recomputes every eligible person, page by page", async () => {
    const db = testDb.db
    const first = await creatorWithProduct()
    const second = await creatorWithProduct()
    const notOnboarded = await matchCreator(db, { onboarded: false })
    await db.delete(matches)

    const step = { run: <T>(_id: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
    const result = await matchingNightlyFanOut({ step, mode: "inline", pageSize: 2 })
    // Two creators and two builders are active and onboarded.
    expect(result).toEqual({ users: 4, failed: 0 })
    for (const userId of [first.creator.user.id, second.creator.user.id]) {
      expect((await currentRows(db, userId)).length).toBeGreaterThan(0)
      expect((await eventsOf(db, "match.computed", userId)).at(-1)?.properties).toMatchObject({
        trigger: "nightly",
      })
    }
    expect(await currentRows(db, notOnboarded.user.id)).toEqual([])
  })

  it("under Inngest, sends one batch of recompute events per page", async () => {
    await creatorWithProduct()
    const batches: { ids: readonly string[]; day: string }[] = []
    const step = { run: <T>(_id: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
    const result = await matchingNightlyFanOut({
      step,
      mode: "inngest",
      pageSize: 1,
      send: async (ids, day) => {
        batches.push({ ids, day })
      },
    })
    expect(result).toEqual({ users: 2, failed: 0 })
    expect(batches.map((batch) => batch.ids.length)).toEqual([1, 1])
    expect(batches.every((batch) => batch.day === "2026-10-05")).toBe(true)
  })
})
