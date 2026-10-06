import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { events, matches, products, savedItems, users } from "@/lib/db/schema"
import {
  recordFeedOpen,
  recordFeedShown,
  saveFeedListing,
  unsaveFeedListing,
} from "@/lib/feed/interactions"
import { decodeFeedCursor, findFeedListing, listFeed } from "@/lib/feed/queries"
import { mobileEndpoints } from "@/lib/mobile-api/endpoints"
import { handleMobileRequest } from "@/lib/mobile-api/router"
import { MOBILE_API_PREFIX } from "@/lib/mobile-api/schemas"
import { createMobileSession } from "@/lib/mobile-api/sessions"
import { resetMemoryRateLimits } from "@/lib/ratelimit"

import { setupTestDatabase } from "../../helpers/db"
import { insertMatch } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  makeTempDataDir,
  onboardedBuilder,
  onboardedCreator,
  removeTempDataDir,
  seekingProduct,
} from "../proposals/helpers"

/**
 * The creator feed (CLAUDE.md §19.45): what it shows, its ranking (match score, then newest) and
 * keyset paging, the save / open / shown events, who may use it, and the mobile API endpoints
 * (feed, detail, save, shown, imports with the fake App Store).
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-06T10:00:00.000Z")

beforeAll(async () => {
  mocks.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dir)
})
beforeEach(() => {
  mocks.db = testDb.db
  stubServiceEnv({ FAKE_SERVICES: "all" })
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(async () => {
  setClockForTests(null)
  await closeDb()
})

async function productAt(
  builder: Awaited<ReturnType<typeof onboardedBuilder>>,
  minutesAgo: number,
  title: string,
) {
  const product = await seekingProduct(testDb.db, builder, {
    title,
    description: `${title} does a thing. More.`,
  })
  await testDb.db
    .update(products)
    .set({ publishedAt: new Date(NOW.getTime() - minutesAgo * 60_000) })
    .where(eq(products.id, product.id))
  return product
}

async function eventTypes(subjectId: string) {
  const rows = await testDb.db
    .select({ type: events.type })
    .from(events)
    .where(eq(events.subjectId, subjectId))
  return rows.map((row) => row.type)
}

describe("feed queries", () => {
  it("ranks matched listings first, then newest; hides own, archived, removed, dismissed and suspended", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const old = await productAt(builder, 300, "Old one")
    const fresh = await productAt(builder, 5, "Fresh one")
    const matched = await productAt(builder, 600, "Matched one")
    await insertMatch(testDb.db, {
      subjectUserId: creator.user.id,
      targetType: "product",
      targetId: matched.id,
      score: 0.81,
      status: "shown",
    })
    const archived = await productAt(builder, 1, "Archived")
    await testDb.db
      .update(products)
      .set({ status: "archived", archivedAt: NOW })
      .where(eq(products.id, archived.id))
    const removed = await productAt(builder, 2, "Removed")
    await testDb.db
      .update(products)
      .set({ source: "app_store", sourceId: "123", sourceRemovedAt: NOW })
      .where(eq(products.id, removed.id))
    const dismissed = await productAt(builder, 3, "Dismissed")
    await insertMatch(testDb.db, {
      subjectUserId: creator.user.id,
      targetType: "product",
      targetId: dismissed.id,
      status: "dismissed",
    })
    const suspendedBuilder = await onboardedBuilder(testDb.db)
    await productAt(suspendedBuilder, 1, "From a suspended builder")
    await testDb.db
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.id, suspendedBuilder.user.id))

    const page = await listFeed(testDb.db, { viewerId: creator.user.id })
    const ours = page.items.filter((item) =>
      [builder.user.id, suspendedBuilder.user.id].includes(item.builder.userId),
    )
    expect(ours.map((item) => item.title)).toEqual(["Matched one", "Fresh one", "Old one"])
    expect(page.items[0]).toMatchObject({
      score: 0.81,
      saved: false,
      hook: "Matched one does a thing.",
    })
    expect(page.nextCursor).toBeNull()

    // The builder never sees their own listings.
    const own = await listFeed(testDb.db, { viewerId: builder.user.id })
    expect(own.items.map((item) => item.id)).not.toContain(fresh.id)
    expect(old.id).toBeTruthy()
  })

  it("pages with a keyset cursor without repeats or gaps", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const made: string[] = []
    for (let i = 0; i < 7; i += 1) made.push((await productAt(builder, i * 10, `Listing ${i}`)).id)
    // Two share a timestamp: the id breaks the tie.
    await testDb.db.update(products).set({ publishedAt: NOW }).where(eq(products.id, made[1]!))
    await testDb.db.update(products).set({ publishedAt: NOW }).where(eq(products.id, made[2]!))

    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 10; i += 1) {
      const page = await listFeed(testDb.db, { viewerId: creator.user.id, cursor, limit: 3 })
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    // Other tests' listings share the database: no repeats overall, and every one of ours.
    expect(new Set(seen).size).toBe(seen.length)
    expect(made.every((id) => seen.includes(id))).toBe(true)
    expect(decodeFeedCursor("garbage")).toBeNull()
  })
})

describe("feed interactions", () => {
  it("saves through the match when one exists, else with listing events; shown and opened likewise", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const plain = await productAt(builder, 1, "Plain")
    const matched = await productAt(builder, 2, "Matched")
    const match = await insertMatch(testDb.db, {
      subjectUserId: creator.user.id,
      targetType: "product",
      targetId: matched.id,
      score: 0.7,
      status: "shown",
    })

    await saveFeedListing(testDb.db, { userId: creator.user.id, productId: plain.id, rank: 2 })
    await saveFeedListing(testDb.db, { userId: creator.user.id, productId: plain.id, rank: 2 })
    expect((await eventTypes(plain.id)).filter((t) => t === "listing.saved")).toHaveLength(1)
    await saveFeedListing(testDb.db, { userId: creator.user.id, productId: matched.id, rank: 1 })
    const [row] = await testDb.db.select().from(matches).where(eq(matches.id, match.id))
    expect(row?.status).toBe("saved")
    expect(await eventTypes(match.id)).toContain("match.saved")
    const saved = await testDb.db
      .select()
      .from(savedItems)
      .where(eq(savedItems.userId, creator.user.id))
    expect(saved).toHaveLength(2)
    expect(
      (await findFeedListing(testDb.db, { viewerId: creator.user.id, productId: plain.id }))?.saved,
    ).toBe(true)

    await unsaveFeedListing(testDb.db, { userId: creator.user.id, productId: plain.id, rank: 2 })
    expect(await eventTypes(plain.id)).toContain("listing.unsaved")

    await recordFeedOpen(testDb.db, { userId: creator.user.id, productId: plain.id, rank: 2 })
    await recordFeedOpen(testDb.db, { userId: creator.user.id, productId: matched.id, rank: 1 })
    expect(await eventTypes(plain.id)).toContain("listing.opened")
    expect(await eventTypes(match.id)).toContain("match.clicked")

    const shown = await recordFeedShown(testDb.db, {
      userId: creator.user.id,
      page: 1,
      items: [
        { productId: matched.id, matchId: match.id, rank: 1 },
        { productId: plain.id, matchId: null, rank: 2 },
      ],
    })
    expect(shown.marked).toBe(1)
    const viewed = await testDb.db
      .select({ properties: events.properties })
      .from(events)
      .where(and(eq(events.type, "feed.viewed"), eq(events.subjectId, creator.user.id)))
    expect(viewed[0]?.properties).toEqual({ items: 2, matched: 1, page: 1 })
  })

  it("refuses listings the viewer may not see", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const draft = await seekingProduct(testDb.db, builder, { status: "draft", publishedAt: null })
    await expect(
      saveFeedListing(testDb.db, { userId: creator.user.id, productId: draft.id, rank: null }),
    ).rejects.toThrow(/no longer available/)
  })
})

async function call(method: string, path: string, token?: string, body?: unknown) {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.9" })
  if (token) headers.set("authorization", `Bearer ${token}`)
  if (body !== undefined) headers.set("content-type", "application/json")
  const response = await handleMobileRequest(
    new Request(`http://localhost:3000${MOBILE_API_PREFIX}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    mobileEndpoints(),
    { db: testDb.db },
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("mobile API", () => {
  it("serves the feed, a listing and saves to creators only", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const product = await productAt(builder, 1, "Pocket tool")
    const creatorToken = (
      await createMobileSession(testDb.db, { userId: creator.user.id, deviceName: "iPhone" })
    ).token
    const builderToken = (
      await createMobileSession(testDb.db, { userId: builder.user.id, deviceName: "iPhone" })
    ).token

    const feed = await call("GET", "/feed", creatorToken)
    expect(feed.status).toBe(200)
    expect((feed.body.items as { id: string }[]).map((item) => item.id)).toContain(product.id)

    const detail = await call("GET", `/feed/${product.id}`, creatorToken)
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      title: "Pocket tool",
      builder: { userId: builder.user.id },
    })

    expect(
      (await call("POST", `/feed/${product.id}/save`, creatorToken, { rank: 1 })).body,
    ).toEqual({ saved: true })
    expect((await call("POST", `/feed/${product.id}/open`, creatorToken, { rank: 1 })).status).toBe(
      200,
    )
    expect(
      (
        await call("POST", "/feed/shown", creatorToken, {
          page: 1,
          items: [{ productId: product.id, matchId: null, rank: 1 }],
        })
      ).status,
    ).toBe(200)

    expect((await call("GET", "/feed", builderToken)).status).toBe(403)
    expect((await call("GET", "/feed")).status).toBe(401)
    expect((await call("GET", "/feed/not-a-uuid", creatorToken)).status).toBe(404)
  })

  it("imports from the fake App Store and shows the builder's grid with absolute image URLs", async () => {
    const builder = await onboardedBuilder(testDb.db)
    const creator = await onboardedCreator(testDb.db)
    const token = (
      await createMobileSession(testDb.db, { userId: builder.user.id, deviceName: "iPhone" })
    ).token
    const creatorToken = (
      await createMobileSession(testDb.db, { userId: creator.user.id, deviceName: "iPhone" })
    ).token

    const imported = await call("POST", "/listings/app-store", token, { appStore: "id1500000002" })
    expect(imported.status).toBe(200)
    expect(imported.body).toMatchObject({ developerName: "Tiny Forge Studio", created: 4 })

    const status = await call("GET", "/listings/import", token)
    expect(status.body).toMatchObject({ appStore: { verified: false } })
    expect((status.body.appStore as { verificationCode: string }).verificationCode).toMatch(/^VNC-/)

    const refused = await call("POST", "/listings/web", token, { url: "http://169.254.169.254/" })
    expect(refused.status).toBe(422)

    expect(
      (await call("POST", "/listings/app-store", creatorToken, { appStore: "1" })).status,
    ).toBe(403)

    const grid = await call("GET", `/builders/${builder.profile.handle}`, creatorToken)
    expect(grid.status).toBe(200)
    const listings = grid.body.listings as { icon: { url: string } | null; unverified: boolean }[]
    expect(listings).toHaveLength(4)
    expect(listings[0]?.icon?.url).toMatch(/^http:\/\/localhost:3000\/api\/products\//)
    expect(listings.every((listing) => listing.unverified)).toBe(true)
  })
})
