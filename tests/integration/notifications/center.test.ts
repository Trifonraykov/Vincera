import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { notificationPrefs, notifications } from "@/lib/db/schema"
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications/center"
import { notify } from "@/lib/notifications/notify"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import { authUserOf } from "../proposals/helpers"

/**
 * The notifications center (`/app/notifications`, the bell): the in-app list (hidden delivery rows
 * and unparseable rows skipped), unread counts, opening one (marks it read, goes where it leads)
 * and "mark all as read", including through the actions with a mocked session.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown, user: null as AuthUser | null }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
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

const { markAllNotificationsReadAction, openNotificationAction } =
  await import("@/lib/notifications/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const PROPOSAL = "0190a000-0000-7000-8000-000000000001"

beforeEach(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "center-test-"))
  mocks.db = testDb.db
  stubServiceEnv()
  setClockForTests(NOW)
})
afterEach(async () => {
  setClockForTests(null)
  await rm(mocks.dir, { recursive: true, force: true })
  await closeDb()
})

function received(userId: string, minutesAgo: number, dedupeKey?: string) {
  setClockForTests(new Date(NOW.getTime() - minutesAgo * 60_000))
  return notify(
    {
      userId,
      type: "proposal.received",
      payload: {
        proposal_id: PROPOSAL,
        counterpart_name: "Ada",
        target_kind: "idea",
        target_title: `Idea ${minutesAgo}`,
      },
      dedupeKey,
    },
    testDb.db,
  )
}

describe("notifications center", () => {
  it("lists visible rows newest first, counts unread, and marks them read", async () => {
    const user = await insertUser(testDb.db)
    const other = await insertUser(testDb.db)
    await received(user.id, 30)
    await received(user.id, 10)
    await received(other.id, 5)
    // In-app off for the type: the delivery is recorded hidden and never listed or counted.
    await testDb.db
      .insert(notificationPrefs)
      .values({ userId: user.id, type: "payouts.ready", email: true, inApp: false })
    await notify(
      {
        userId: user.id,
        type: "payouts.ready",
        payload: { stripe_account_id: "acct_fake_1" },
        dedupeKey: "payouts.ready:acct_fake_1",
      },
      testDb.db,
    )
    // A row a later release no longer understands is skipped, not shown broken.
    await testDb.db
      .insert(notifications)
      .values({ userId: user.id, type: "proposal.received", payload: { proposal_id: "x" } })
    setClockForTests(NOW)

    const { items, hasMore } = await listNotifications(testDb.db, user.id)
    expect(hasMore).toBe(false)
    expect(items.map((item) => item.payload)).toEqual([
      expect.objectContaining({ target_title: "Idea 10" }),
      expect.objectContaining({ target_title: "Idea 30" }),
    ])
    expect(items[0]?.href).toBe(`/app/proposals/${PROPOSAL}`)
    // The unparseable row still counts as unread until read (the bell counts stored rows).
    expect(await countUnreadNotifications(testDb.db, user.id)).toBe(3)

    const first = items[0]
    if (!first) throw new Error("no item")
    expect(await markNotificationRead(testDb.db, user.id, first.id)).toBe(
      `/app/proposals/${PROPOSAL}`,
    )
    // Someone else's notification is not theirs to read.
    const [theirs] = await testDb.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, other.id))
    expect(await markNotificationRead(testDb.db, user.id, theirs?.id ?? "")).toBeNull()
    expect(await countUnreadNotifications(testDb.db, user.id)).toBe(2)
    expect(await markAllNotificationsRead(testDb.db, user.id)).toBe(2)
    expect(await countUnreadNotifications(testDb.db, user.id)).toBe(0)
    expect(await countUnreadNotifications(testDb.db, other.id)).toBe(1)
  })

  it("pages with a keyset cursor", async () => {
    const user = await insertUser(testDb.db)
    for (let minutes = 1; minutes <= 5; minutes++) await received(user.id, minutes)
    setClockForTests(NOW)
    const page1 = await listNotifications(testDb.db, user.id, { limit: 2 })
    expect(page1.hasMore).toBe(true)
    const last = page1.items.at(-1)
    if (!last) throw new Error("no item")
    const page2 = await listNotifications(testDb.db, user.id, {
      limit: 2,
      before: { createdAt: last.createdAt, id: last.id },
    })
    const titles = [...page1.items, ...page2.items].map((item) =>
      item.type === "proposal.received" ? item.payload.target_title : item.type,
    )
    expect(titles).toEqual(["Idea 1", "Idea 2", "Idea 3", "Idea 4"])
  })

  it("opens a notification through the action: read, then redirected to its page", async () => {
    const user = await insertUser(testDb.db)
    const { notificationId } = await received(user.id, 1)
    mocks.user = authUserOf(user)
    let target = ""
    try {
      await openNotificationAction({ id: notificationId ?? "" })
    } catch (error) {
      target = String((error as { digest?: unknown }).digest ?? "")
    }
    expect(target).toContain(`/app/proposals/${PROPOSAL}`)
    expect(await countUnreadNotifications(testDb.db, user.id)).toBe(0)
    await received(user.id, 0)
    expect(await markAllNotificationsReadAction({})).toEqual({ ok: true, data: { marked: 1 } })
  })
})
