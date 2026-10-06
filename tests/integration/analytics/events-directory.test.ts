import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { listDirectoryLaunches } from "@/lib/analytics/directory"
import {
  countEventsByTypePerDay,
  formatEventCursor,
  listEvents,
  parseEventCursor,
  parseEventFilters,
} from "@/lib/analytics/events-explorer"
import { setClockForTests } from "@/lib/clock"
import { launches, users } from "@/lib/db/schema"
import { track } from "@/lib/events/track"

import { setupTestDatabase } from "../../helpers/db"
import { insertLiveLaunch, insertUser } from "../../helpers/db-fixtures"
import { at, view } from "./helpers"

/**
 * `/admin/events` (filters, keyset paging, counts by type per day; admins only) and the public
 * `/launches` directory (live launches only) against Postgres (CLAUDE.md §19.38).
 */

const mocks = vi.hoisted(() => ({ db: null as unknown, user: null as AuthUser | null }))
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>()
  return {
    ...original,
    requireAdmin: async () => {
      if (!mocks.user) throw new Error("no user")
      return mocks.user
    },
  }
})

const testDb = setupTestDatabase()
const NOW = at("2026-10-05")

beforeEach(() => {
  mocks.db = testDb.db
  setClockForTests(NOW)
})
afterEach(() => setClockForTests(null))

function authUser(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email ?? "x@example.test",
    name: row.name,
    image: null,
    roles: row.roles,
    activeRole: row.activeRole,
    status: row.status,
    onboardingCompletedAt: row.onboardingCompletedAt,
  }
}

describe("events explorer", () => {
  it("filters, pages newest first without gaps, and counts by type per day", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const launchId = live.launch.id
    for (let i = 0; i < 55; i += 1) {
      await view(testDb.db, launchId, null, new Date(at("2026-10-04").getTime() + i * 1000))
    }
    await track(
      "launch.paused",
      {
        actorUserId: live.creator.user.id,
        subjectType: "launch",
        subjectId: launchId,
        properties: { collab_id: live.collab.id, by: "member" },
        occurredAt: at("2026-10-03"),
      },
      testDb.db,
    )

    const filters = parseEventFilters({ subject_id: launchId }, NOW)
    expect(filters.range).toEqual({ from: "2026-09-29", to: "2026-10-05" })
    const first = await listEvents(testDb.db, filters, null)
    expect(first.events).toHaveLength(50)
    expect(first.events[0]?.type).toBe("product_page.viewed")
    expect(first.next).not.toBeNull()
    const cursor = parseEventCursor(formatEventCursor(first.next!))
    const second = await listEvents(testDb.db, filters, cursor)
    expect(second.events).toHaveLength(6)
    expect(second.next).toBeNull()
    const ids = new Set([...first.events, ...second.events].map((event) => event.id))
    expect(ids.size).toBe(56)
    expect(second.events.at(-1)?.type).toBe("launch.paused")

    const byActor = await listEvents(
      testDb.db,
      parseEventFilters({ actor_id: live.creator.user.id, subject_id: launchId }, NOW),
      null,
    )
    expect(byActor.events.map((event) => event.type)).toEqual(["launch.paused"])

    const typed = parseEventFilters({ type: "launch.paused", subject_id: launchId }, NOW)
    expect((await listEvents(testDb.db, typed, null)).events).toHaveLength(1)

    const counts = await countEventsByTypePerDay(testDb.db, filters)
    expect(counts.days).toHaveLength(7)
    expect(counts.types.map((row) => [row.type, row.total])).toEqual([
      ["product_page.viewed", 55],
      ["launch.paused", 1],
    ])
    expect(counts.totals[5]).toBe(55)
    expect(counts.totals[4]).toBe(1)
  })

  it("drops invalid filters and caps the range at 90 days", () => {
    const filters = parseEventFilters(
      { type: "not.a.type", subject_id: "nope", from: "2025-01-01", to: "2026-10-05" },
      NOW,
    )
    expect(filters.type).toBeNull()
    expect(filters.subjectId).toBeNull()
    expect(filters.range).toEqual({ from: "2026-07-08", to: "2026-10-05" })
    expect(parseEventCursor("garbage")).toBeNull()
  })

  it("is for admins only", async () => {
    const { default: AdminEventsPage } = await import("@/app/admin/events/page")
    const admin = await insertUser(testDb.db, { roles: ["admin"], activeRole: "admin" })
    const member = await insertUser(testDb.db, { roles: ["creator"], activeRole: "creator" })
    mocks.user = authUser(member)
    await expect(AdminEventsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      /NEXT_REDIRECT/,
    )
    mocks.user = authUser(admin)
    await expect(AdminEventsPage({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy()
  })
})

describe("launches directory", () => {
  it("lists live launches only, newest first, with public fields", async () => {
    const older = await insertLiveLaunch(testDb.db)
    await testDb.db
      .update(launches)
      .set({ wentLiveAt: at("2026-09-01"), tagline: "Track every euro" })
      .where(eq(launches.id, older.launch.id))
    const newer = await insertLiveLaunch(testDb.db)
    await testDb.db
      .update(launches)
      .set({ wentLiveAt: at("2026-10-01") })
      .where(eq(launches.id, newer.launch.id))
    const paused = await insertLiveLaunch(testDb.db)
    await testDb.db
      .update(launches)
      .set({ status: "paused", pausedAt: NOW, pausedBy: "member" })
      .where(eq(launches.id, paused.launch.id))
    const ended = await insertLiveLaunch(testDb.db)
    await testDb.db
      .update(launches)
      .set({ status: "ended", endedAt: NOW })
      .where(eq(launches.id, ended.launch.id))

    const items = await listDirectoryLaunches(testDb.db)
    const slugs = items.map((item) => item.slug)
    expect(slugs).not.toContain(paused.launch.slug)
    expect(slugs).not.toContain(ended.launch.slug)
    expect(slugs.indexOf(newer.launch.slug)).toBeLessThan(slugs.indexOf(older.launch.slug))
    const card = items.find((item) => item.slug === older.launch.slug)
    expect(card).toMatchObject({
      title: "Budget tracker",
      tagline: "Track every euro",
      priceCents: 1900,
      format: older.idea.format,
      creator: { handle: older.creator.profile.handle },
      builder: { handle: older.builder.profile.handle },
    })
    expect(JSON.stringify(items)).not.toMatch(/@example/)
  })

  it("leaves out suspended members' names", async () => {
    const live = await insertLiveLaunch(testDb.db)
    await testDb.db
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.id, live.builder.user.id))
    const card = (await listDirectoryLaunches(testDb.db)).find(
      (item) => item.slug === live.launch.slug,
    )
    expect(card?.builder).toBeNull()
    expect(card?.creator).not.toBeNull()
  })
})
