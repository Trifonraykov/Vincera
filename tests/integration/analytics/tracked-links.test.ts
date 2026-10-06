import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { closeDb } from "@/lib/db/client"
import { events, launches, trackedLinks, users } from "@/lib/db/schema"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { createFakeStripeGateway } from "@/lib/stripe/fake"
import {
  createTrackedLink,
  disableTrackedLink,
  renameTrackedLink,
} from "@/lib/tracked-links/service"

import { setupTestDatabase } from "../../helpers/db"
import { insertLiveLaunch, insertTrackedLink, insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"

/**
 * Tracked links (`/app/launches/[id]/links`; CLAUDE.md §19.38): members of a live launch create
 * links for themselves with an optional discount code (a Stripe promotion code first), owners
 * rename and turn them off, and nobody else can.
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

const { createTrackedLinkAction, disableTrackedLinkAction, renameTrackedLinkAction } =
  await import("@/lib/tracked-links/actions")

const testDb = setupTestDatabase()

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

function gateway() {
  return createFakeStripeGateway({
    root: path.join(mocks.dir, "fake-stripe"),
    appUrl: TEST_APP_URL,
  })
}

let counter = 0
function uniqueCode(prefix: string): string {
  counter += 1
  return `${prefix}${Date.now().toString(36).toUpperCase()}${counter}`.slice(0, 20)
}

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "tracked-links-test-"))
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.user = null
  stubServiceEnv()
  resetMemoryRateLimits()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await closeDb()
})

describe("tracked links", () => {
  it("lets a member add a plain link and one with a discount code", async () => {
    const live = await insertLiveLaunch(testDb.db)
    mocks.user = authUser(live.builder.user)
    const plain = await createTrackedLinkAction({
      launchId: live.launch.id,
      label: "  Newsletter ",
    })
    expect(plain).toMatchObject({ ok: true })
    const code = uniqueCode("SAVE")
    const discounted = await createTrackedLinkAction({
      launchId: live.launch.id,
      label: "TikTok",
      discountCode: code.toLowerCase(),
      discountPercent: "20%",
    })
    expect(discounted).toMatchObject({ ok: true })
    const rows = await testDb.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.launchId, live.launch.id))
    const tiktok = rows.find((row) => row.label === "TikTok")
    expect(rows.find((row) => row.label === "Newsletter")).toMatchObject({
      ownerUserId: live.builder.user.id,
      isDefault: false,
      discountCode: null,
    })
    expect(tiktok).toMatchObject({ discountCode: code, discountPercentOff: 20 })
    expect(tiktok?.stripePromotionCodeId).toMatch(/^promo_fake_/)
    const promo = await gateway().store.read("promotion_code", tiktok!.stripePromotionCodeId!)
    expect(promo).toMatchObject({ code, active: true })
    const created = await testDb.db
      .select()
      .from(events)
      .where(and(eq(events.subjectId, tiktok!.id), eq(events.type, "tracked_link.created")))
    expect(created[0]?.properties).toEqual({
      launch_id: live.launch.id,
      is_default: false,
      has_discount: true,
    })

    // The same code again is refused next to the field.
    const taken = await createTrackedLinkAction({
      launchId: live.launch.id,
      label: "Again",
      discountCode: code,
      discountPercent: "10",
    })
    expect(taken).toMatchObject({ ok: false, fieldErrors: { discountCode: [expect.any(String)] } })
    // A code without a percentage, or a bad one, is a field error.
    expect(
      await createTrackedLinkAction({ launchId: live.launch.id, label: "X", discountCode: "ABCD" }),
    ).toMatchObject({ ok: false, fieldErrors: { discountPercent: [expect.any(String)] } })
    expect(
      await createTrackedLinkAction({
        launchId: live.launch.id,
        label: "X",
        discountCode: "no!",
        discountPercent: "10",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { discountCode: [expect.any(String)] } })
  })

  it("refuses strangers, admins and launches that are not live", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const stranger = await insertUser(testDb.db, { roles: ["creator"], activeRole: "creator" })
    const admin = await insertUser(testDb.db, { roles: ["admin"], activeRole: "admin" })
    for (const user of [stranger, admin]) {
      mocks.user = authUser(user)
      expect(
        await createTrackedLinkAction({ launchId: live.launch.id, label: "Mine" }),
      ).toMatchObject({ ok: false })
    }
    await testDb.db
      .update(launches)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(launches.id, live.launch.id))
    mocks.user = authUser(live.creator.user)
    expect(await createTrackedLinkAction({ launchId: live.launch.id, label: "Late" })).toEqual({
      ok: false,
      error: "Links can be added while the launch is live or paused.",
    })
    expect(
      await testDb.db.select().from(trackedLinks).where(eq(trackedLinks.launchId, live.launch.id)),
    ).toHaveLength(0)
  })

  it("rate limits link creation per member", async () => {
    const live = await insertLiveLaunch(testDb.db)
    mocks.user = authUser(live.creator.user)
    const results = []
    for (let i = 0; i < 21; i += 1) {
      results.push(await createTrackedLinkAction({ launchId: live.launch.id, label: `Link ${i}` }))
    }
    expect(results.filter((result) => result.ok)).toHaveLength(20)
    expect(results.at(-1)).toMatchObject({ ok: false })
  })

  it("lets only the owner rename and turn off a link; the default stays on", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const store = gateway()
    const code = uniqueCode("OFF")
    const created = await createTrackedLink(
      testDb.db,
      {
        launchId: live.launch.id,
        label: "Stories",
        discountCode: code,
        discountPercent: 15,
        ownerUserId: live.creator.user.id,
      },
      { gateway: store },
    )
    const defaultLink = await insertTrackedLink(testDb.db, live.launch.id, live.creator.user.id, {
      isDefault: true,
      label: "Default",
    })

    mocks.user = authUser(live.builder.user)
    expect(await renameTrackedLinkAction({ linkId: created.id, label: "Mine now" })).toMatchObject({
      ok: false,
      error: "This link doesn't exist or isn't yours.",
    })
    expect(await disableTrackedLinkAction({ linkId: created.id })).toMatchObject({ ok: false })

    const creator = authUser(live.creator.user)
    expect(
      await renameTrackedLink(testDb.db, creator, { linkId: created.id, label: "Stories" }),
    ).toMatchObject({
      changed: false,
    })
    mocks.user = creator
    expect(await renameTrackedLinkAction({ linkId: created.id, label: "IG stories" })).toEqual({
      ok: true,
      data: { changed: true },
    })
    expect(await disableTrackedLinkAction({ linkId: defaultLink.id })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/default link/),
    })

    expect(
      await disableTrackedLink(testDb.db, creator, { linkId: created.id }, { gateway: store }),
    ).toMatchObject({
      changed: true,
    })
    const [row] = await testDb.db.select().from(trackedLinks).where(eq(trackedLinks.id, created.id))
    expect(row?.label).toBe("IG stories")
    expect(row?.disabledAt).not.toBeNull()
    const promo = await store.store.read("promotion_code", row!.stripePromotionCodeId!)
    expect(promo?.active).toBe(false)
    const types = (
      await testDb.db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.subjectId, created.id))
    ).map((event) => event.type)
    expect(types.sort()).toEqual([
      "tracked_link.created",
      "tracked_link.disabled",
      "tracked_link.updated",
    ])
  })
})
