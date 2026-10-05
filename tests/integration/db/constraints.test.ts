import { eq, sql } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { PG_ERROR } from "@/lib/db/errors"
import {
  audienceSnapshots,
  builderProfiles,
  creatorProfiles,
  handles,
  launches,
  matches,
  orders,
  PROPOSAL_TTL_DAYS,
  proposalRevisions,
  proposals,
  socialConnections,
  users,
  type MatchFeatures,
} from "@/lib/db/schema"
import { audienceSnapshotInputSchema } from "@/lib/social/types"

import { expectPgError, setupTestDatabase } from "../../helpers/db"
import {
  insertBuilder,
  insertCreator,
  insertIdea,
  insertLiveLaunch,
  insertOrder,
  insertProduct,
  insertUser,
} from "../../helpers/db-fixtures"

const testDb = setupTestDatabase()

afterEach(() => setClockForTests(null))

describe("proposals", () => {
  async function parties() {
    const creator = await insertCreator(testDb.db)
    const builder = await insertBuilder(testDb.db)
    const idea = await insertIdea(testDb.db, creator.profile.id)
    const product = await insertProduct(testDb.db, builder.profile.id)
    return { creator, builder, idea, product }
  }

  it("requires exactly one of idea_id / product_id", async () => {
    const { creator, builder, idea, product } = await parties()
    const base = { fromUserId: builder.user.id, toUserId: creator.user.id }

    await expectPgError(
      testDb.db.insert(proposals).values({ ...base, ideaId: idea.id, productId: product.id }),
      PG_ERROR.checkViolation,
      "proposals_exactly_one_target",
    )
    await expectPgError(
      testDb.db.insert(proposals).values(base),
      PG_ERROR.checkViolation,
      "proposals_exactly_one_target",
    )

    const inserted = await testDb.db
      .insert(proposals)
      .values([
        { ...base, ideaId: idea.id },
        { ...base, productId: product.id },
      ])
      .returning()
    expect(inserted).toHaveLength(2)
  })

  it("defaults expires_at to now() + 14 days from the app clock", async () => {
    const sentAt = new Date("2026-03-01T10:00:00.000Z")
    setClockForTests(sentAt)
    const { creator, builder, idea } = await parties()

    const [proposal] = await testDb.db
      .insert(proposals)
      .values({ fromUserId: builder.user.id, toUserId: creator.user.id, ideaId: idea.id })
      .returning()

    expect(proposal?.createdAt.toISOString()).toBe(sentAt.toISOString())
    expect(proposal?.expiresAt.getTime()).toBe(
      sentAt.getTime() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000,
    )
  })

  it("requires revision splits to be 0–100 and sum to 100", async () => {
    const { creator, builder, idea } = await parties()
    const [proposal] = await testDb.db
      .insert(proposals)
      .values({ fromUserId: builder.user.id, toUserId: creator.user.id, ideaId: idea.id })
      .returning()
    if (!proposal) throw new Error("no proposal")
    const revision = (creatorSplitPct: number, builderSplitPct: number) =>
      testDb.db.insert(proposalRevisions).values({
        proposalId: proposal.id,
        authorUserId: builder.user.id,
        scope: "MVP",
        creatorSplitPct,
        builderSplitPct,
        timelineWeeks: 6,
      })

    await expectPgError(revision(60, 50), PG_ERROR.checkViolation, "proposal_revisions_split_valid")
    await expectPgError(
      revision(101, -1),
      PG_ERROR.checkViolation,
      "proposal_revisions_split_valid",
    )
    await revision(70, 30)
    await revision(100, 0)
  })
})

describe("handles", () => {
  it("enforces the lowercase [a-z0-9_]{3,30} format", async () => {
    const user = await insertUser(testDb.db)
    for (const bad of ["Alice", "al", "a".repeat(31), "has-dash", "has space", "émile"]) {
      await expectPgError(
        testDb.db.insert(handles).values({ handle: bad, userId: user.id }),
        PG_ERROR.checkViolation,
        "handles_handle_format",
      )
    }
    await testDb.db.insert(handles).values({ handle: "good_handle_42", userId: user.id })
    await testDb.db.insert(handles).values({ handle: "a".repeat(30), userId: user.id })
  })

  it("is unique across creators and builders: one owner, shared by both of their profiles", async () => {
    const { user: owner } = await insertCreator(testDb.db, "shared_handle")
    // The owner's builder profile may reuse the handle.
    await testDb.db
      .insert(builderProfiles)
      .values({ userId: owner.id, handle: "shared_handle", displayName: "Owner as builder" })

    const other = await insertUser(testDb.db)
    await expectPgError(
      testDb.db.insert(handles).values({ handle: "shared_handle", userId: other.id }),
      PG_ERROR.uniqueViolation,
      "handles_pkey",
    )
    await expectPgError(
      testDb.db
        .insert(builderProfiles)
        .values({ userId: other.id, handle: "shared_handle", displayName: "Squatter" }),
      PG_ERROR.uniqueViolation,
    )
    // A profile can only use a handle its own user registered.
    await expectPgError(
      testDb.db
        .insert(creatorProfiles)
        .values({ userId: other.id, handle: "unregistered", displayName: "Nobody" }),
      PG_ERROR.foreignKeyViolation,
      "creator_profiles_handle_owner_fk",
    )
  })

  it("renaming a handle cascades to the profiles that use it", async () => {
    const { user, profile } = await insertCreator(testDb.db, "old_name")
    await testDb.db.update(handles).set({ handle: "new_name" }).where(eq(handles.userId, user.id))
    const [renamed] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.id, profile.id))
    expect(renamed?.handle).toBe("new_name")
  })
})

describe("users", () => {
  it("allows only known roles, and an active_role the user has", async () => {
    await expectPgError(
      // Raw SQL: the typed column would not even accept this value.
      testDb.db.execute(
        sql`INSERT INTO users (id, email, roles) VALUES (gen_random_uuid(), 'x@example.test', '{superuser}')`,
      ),
      PG_ERROR.checkViolation,
      "users_roles_valid",
    )
    await expectPgError(
      insertUser(testDb.db, { roles: ["creator"], activeRole: "builder" }),
      PG_ERROR.checkViolation,
      "users_active_role_in_roles",
    )
    const user = await insertUser(testDb.db, {
      roles: ["creator", "builder"],
      activeRole: "builder",
    })
    expect(user.roles).toEqual(["creator", "builder"])
    expect(user.status).toBe("active")
  })

  it("stores image in avatar_url and bumps updated_at from the app clock", async () => {
    setClockForTests(new Date("2026-01-01T00:00:00.000Z"))
    const user = await insertUser(testDb.db, { image: "https://example.test/a.png" })
    expect(user.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z")

    const later = new Date("2026-02-01T12:00:00.000Z")
    setClockForTests(later)
    const [updated] = await testDb.db
      .update(users)
      .set({ name: "Renamed" })
      .where(eq(users.id, user.id))
      .returning()
    expect(updated?.updatedAt.toISOString()).toBe(later.toISOString())
    expect(updated?.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z")

    const raw = await testDb.db.execute<{ avatar_url: string }>(
      sql`SELECT avatar_url FROM users WHERE id = ${user.id}`,
    )
    expect(raw.rows[0]?.avatar_url).toBe("https://example.test/a.png")
  })
})

describe("matches", () => {
  const features: MatchFeatures = {
    semantic: 0.8,
    topic_overlap: 0.5,
    audience_fit: 0.5,
    format_fit: 1,
    stage_fit: 0.5,
    price_fit: 0.9,
    reliability: 0.5,
  }

  it("is unique per (subject, target, model_version) and needs a known model_version", async () => {
    const user = await insertUser(testDb.db)
    const match = {
      subjectUserId: user.id,
      targetType: "product" as const,
      targetId: user.id,
      score: 0.734512,
      features,
      modelVersion: "v0",
      computedAt: new Date("2026-01-01T00:00:00Z"),
    }
    const [inserted] = await testDb.db.insert(matches).values(match).returning()
    expect(inserted?.score).toBe(0.734512)

    await expectPgError(
      testDb.db.insert(matches).values(match),
      PG_ERROR.uniqueViolation,
      "matches_subject_target_model_key",
    )
    await expectPgError(
      testDb.db.insert(matches).values({ ...match, modelVersion: "v999" }),
      PG_ERROR.foreignKeyViolation,
    )
    await expectPgError(
      testDb.db.insert(matches).values({ ...match, targetId: crypto.randomUUID(), score: 1.5 }),
      PG_ERROR.checkViolation,
      "matches_score_range",
    )
  })
})

describe("commerce", () => {
  it("keeps orders.stripe_checkout_session_id unique", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, new Date("2026-01-01T00:00:00Z"))
    await expectPgError(
      testDb.db.insert(orders).values({
        launchId: launch.id,
        buyerEmail: "someone@example.test",
        stripeCheckoutSessionId: order.stripeCheckoutSessionId,
        amountGrossCents: 1900,
        paidAt: new Date("2026-01-01T00:00:00Z"),
      }),
      PG_ERROR.uniqueViolation,
      "orders_stripe_checkout_session_id_unique",
    )
  })

  it("only lets a launch leave draft once it has a price and a delivery type", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    await expectPgError(
      testDb.db.update(launches).set({ priceCents: null }).where(eq(launches.id, launch.id)),
      PG_ERROR.checkViolation,
      "launches_complete_unless_draft",
    )
    await testDb.db
      .update(launches)
      .set({ status: "draft", priceCents: null, deliveryType: null })
      .where(eq(launches.id, launch.id))
  })
})

describe("audience snapshots", () => {
  async function insertConnection() {
    const { user } = await insertCreator(testDb.db)
    const [connection] = await testDb.db
      .insert(socialConnections)
      .values({ userId: user.id, provider: "youtube", providerAccountId: `UC${user.id}` })
      .returning()
    if (!connection) throw new Error("no connection")
    return connection
  }

  it("stores a provider's AudienceSnapshotInput as it is, demographics basis included", async () => {
    const connection = await insertConnection()
    const input = audienceSnapshotInputSchema.parse({
      followers: 12_300,
      avgViews: 4_100,
      engagementRate: 0.0523,
      topCountries: [{ country: "ES", share: 0.41 }],
      countriesBasis: "viewers",
      ageGender: {
        basis: "viewers",
        buckets: [
          { ageGroup: "18-24", gender: "female", share: 0.3 },
          { ageGroup: "25-34", gender: "unknown", share: 0.7 },
        ],
      },
      topTopics: ["productivity"],
      raw: { engagedViews: 3900, rows: [["ES", 41]] },
    })

    const [row] = await testDb.db
      .insert(audienceSnapshots)
      .values({
        socialConnectionId: connection.id,
        takenAt: new Date("2026-01-01T00:00:00Z"),
        ...input,
      })
      .returning()
    expect(row).toMatchObject(input)
  })

  it("requires the basis of non-empty country shares", async () => {
    const connection = await insertConnection()
    const base = { socialConnectionId: connection.id, takenAt: new Date("2026-01-01T00:00:00Z") }
    await expectPgError(
      testDb.db
        .insert(audienceSnapshots)
        .values({ ...base, topCountries: [{ country: "ES", share: 1 }] }),
      PG_ERROR.checkViolation,
      "audience_snapshots_countries_have_basis",
    )
    await testDb.db.insert(audienceSnapshots).values({ ...base, topCountries: [] })
    await testDb.db.insert(audienceSnapshots).values(base)
  })
})
