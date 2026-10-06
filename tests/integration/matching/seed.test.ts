import { and, count, eq, inArray, isNotNull, isNull, like, sql } from "drizzle-orm"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  audienceSnapshots,
  builderProfiles,
  creatorProfiles,
  events,
  ideas,
  matches,
  portfolioItems,
  products,
  socialConnections,
  stripeAccounts,
  users,
} from "@/lib/db/schema"
import { SEED_BUILDERS, SEED_CREATORS } from "@/lib/seed/data"
import { seedMatches } from "@/lib/seed/matches"
import { seedPeople } from "@/lib/seed/people"
import { seedSupply } from "@/lib/seed/supply"
import type { SeedContext } from "@/lib/seed/types"

import { setupTestDatabase } from "../../helpers/db"
import { stubServiceEnv } from "../../helpers/service-env"

/**
 * The matching-owned seed steps (§15 part 1; CLAUDE.md §19.24 "Seed", §19.27): 10 creators with a
 * verified YouTube audience, 10 builders with GitHub and a portfolio, ideas and products, embedded,
 * then ranked matches with explanations for everyone. Idempotent.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})

const testDb = setupTestDatabase()
const STEPS = [seedPeople, seedSupply, seedMatches]

beforeEach(() => {
  stubServiceEnv()
  mocks.db = testDb.db
})

async function runSteps(): Promise<Record<string, number | string>> {
  const ctx: SeedContext = { db: testDb.db, now: new Date(), log: () => undefined }
  const results: Record<string, number | string> = {}
  for (const step of STEPS) {
    const result = await step.run(ctx)
    results[step.name] = "created" in result ? result.created : result.skipped
  }
  return results
}

describe("seed: people, supply, matches", () => {
  it("creates the demo platform once, with ranked, explained matches for everyone", async () => {
    const db = testDb.db
    const first = await runSteps()
    expect(first.people).toBe(SEED_CREATORS.length + SEED_BUILDERS.length)
    expect(first.supply).toBeGreaterThan(0)
    expect(first.matches).toBeGreaterThan(0)

    const seeded = await db
      .select({ id: users.id, email: users.email, roles: users.roles })
      .from(users)
      .where(and(like(users.email, "seed-%@example.com"), isNotNull(users.onboardingCompletedAt)))
    expect(seeded).toHaveLength(20)

    // Creators: a verified YouTube connection with a snapshot, a size tier, a summary, a vector.
    const creators = await db
      .select({
        userId: creatorProfiles.userId,
        sizeTier: creatorProfiles.sizeTier,
        summary: creatorProfiles.audienceSummary,
        embedded: sql<boolean>`${creatorProfiles.embedding} IS NOT NULL`,
      })
      .from(creatorProfiles)
    expect(creators).toHaveLength(10)
    expect(creators.every((row) => row.sizeTier && row.summary && row.embedded)).toBe(true)
    const verified = await db
      .select({ provider: socialConnections.provider, total: count() })
      .from(socialConnections)
      .innerJoin(audienceSnapshots, eq(audienceSnapshots.socialConnectionId, socialConnections.id))
      .where(and(eq(socialConnections.status, "active"), isNotNull(socialConnections.verifiedAt)))
      .groupBy(socialConnections.provider)
    expect(Object.fromEntries(verified.map((row) => [row.provider, row.total]))).toEqual({
      youtube: 10,
      github: 10,
    })

    // Builders: a portfolio and a vector; everyone payouts-ready.
    const builders = await db
      .select({ embedded: sql<boolean>`${builderProfiles.embedding} IS NOT NULL` })
      .from(builderProfiles)
    expect(builders).toHaveLength(10)
    expect(builders.every((row) => row.embedded)).toBe(true)
    const [portfolio] = await db.select({ total: count() }).from(portfolioItems)
    expect(portfolio?.total).toBeGreaterThanOrEqual(10)
    const [ready] = await db
      .select({ total: count() })
      .from(stripeAccounts)
      .where(
        and(
          eq(stripeAccounts.payoutsEnabled, true),
          eq(stripeAccounts.transfersCapability, "active"),
        ),
      )
    expect(ready?.total).toBe(20)

    // Ideas and products in several statuses, published ones embedded.
    const ideaStatuses = await db.selectDistinct({ status: ideas.status }).from(ideas)
    expect(ideaStatuses.map((row) => row.status).sort()).toEqual(["archived", "draft", "open"])
    const productStatuses = await db.selectDistinct({ status: products.status }).from(products)
    expect(productStatuses.map((row) => row.status).sort()).toEqual(["draft", "seeking"])
    const [unembedded] = await db
      .select({ total: count() })
      .from(ideas)
      .where(and(eq(ideas.status, "open"), isNull(ideas.embedding)))
    expect(unembedded?.total).toBe(0)

    // Every seeded person has a current, ranked list; every row has an explanation.
    for (const person of seeded) {
      const rows = await db
        .select()
        .from(matches)
        .where(and(eq(matches.subjectUserId, person.id), isNull(matches.staleAt)))
      expect(rows.length, person.email ?? "").toBeGreaterThan(0)
      expect(rows.length).toBeLessThanOrEqual(30)
      expect(rows.every((row) => row.explanation && row.explanationPromptVersion)).toBe(true)
      const types = new Set(rows.map((row) => row.targetType))
      if (person.roles.includes("creator"))
        expect([...types].sort()).toEqual(["builder", "product"])
      else expect([...types].sort()).toEqual(["creator", "idea"])
    }
    const computed = await db
      .select({ total: count() })
      .from(events)
      .where(eq(events.type, "match.computed"))
    expect(computed[0]?.total).toBe(20)

    // No email address in any event property (§11).
    const leaked = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`${events.properties}::text LIKE '%@example.com%'`)
    expect(leaked).toEqual([])

    // A second run creates nothing.
    const before = await db.select({ total: count() }).from(matches)
    expect(await runSteps()).toEqual({ people: 0, supply: 0, matches: 0 })
    const after = await db.select({ total: count() }).from(matches)
    expect(after).toEqual(before)
    const ids = seeded.map((person) => person.id)
    const [again] = await db
      .select({ total: count() })
      .from(events)
      .where(and(eq(events.type, "match.computed"), inArray(events.subjectId, ids)))
    expect(again?.total).toBe(20)
  })
})
