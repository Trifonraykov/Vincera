import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { handleTrackedLinkRequest } from "@/lib/attribution/click"
import { resolveCheckoutAttribution } from "@/lib/attribution/resolve"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { launches, linkClicks, trackedLinks } from "@/lib/db/schema"
import { createLaunchUpload, addLaunchMedia } from "@/lib/launches/content"
import { mediaName, parseMedia } from "@/lib/launches/fields"
import { generateKitFor, loadKitContext } from "@/lib/launches/kit"
import { launchMediaResponse } from "@/lib/launches/media"
import { recordProductPageView } from "@/lib/launches/page-view"
import { loadPublicLaunch } from "@/lib/launches/queries"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { createLocalStorage } from "@/lib/storage/local"

import { setupTestDatabase } from "../../helpers/db"
import { insertLiveLaunch, insertTrackedLink } from "../../helpers/db-fixtures"
import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"
import { authUserOf, eventsOf, strangerUser } from "./helpers"

/**
 * Attribution and the public side of a launch (§10, §12; CLAUDE.md §19.31–§19.32): `/r/<code>`
 * (click log, cookies, redirect, bots, disabled links, rate limit), the checkout's attribution
 * resolver, the product-page view beacon, the public launch loader, launch images, and the launch
 * kit with its `ai.generated` event.
 */

const mocks = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "attribution-test-"))
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(async () => {
  setClockForTests(null)
  await closeDb()
})

function click(code: string, headers: Record<string, string> = {}) {
  return handleTrackedLinkRequest(
    new Request(`${TEST_APP_URL}/r/${code}`, {
      headers: { "user-agent": BROWSER, "x-forwarded-for": "203.0.113.9", ...headers },
    }),
    code,
    { db: testDb.db },
  )
}

async function liveWithLink() {
  const live = await insertLiveLaunch(testDb.db)
  const link = await insertTrackedLink(testDb.db, live.launch.id, live.creator.user.id, {
    code: `Ab${Math.random().toString(36).slice(2, 8)}`.slice(0, 8).padEnd(8, "Z"),
    isDefault: true,
  })
  return { ...live, link }
}

describe("/r/<code>", () => {
  it("logs the click, sets the attribution and visitor cookies and redirects to the page", async () => {
    const { launch, link } = await liveWithLink()
    const response = await click(link.code, {
      referer: "https://www.youtube.com/watch?v=secret&list=x",
      "x-vercel-ip-country": "es",
    })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.pathname).toBe(`/p/${launch.slug}`)
    expect(location.searchParams.get("ref")).toBe(link.code)
    const cookies = response.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith("attr="))).toMatch(
      new RegExp(`^attr=${link.id}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax$`),
    )
    const vid = cookies.find((c) => c.startsWith("vid="))
    expect(vid).toMatch(/^vid=[A-Za-z0-9_-]{22};/)

    const [row] = await testDb.db
      .select()
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, link.id))
    expect(row).toMatchObject({
      referrer: "https://www.youtube.com",
      country: "ES",
      isBot: false,
      clickedAt: NOW,
      visitorId: vid?.slice(4, 26),
    })
    expect(row?.uaHash).toMatch(/^[0-9a-f]{32}$/)
    const [event] = await eventsOf(testDb.db, link.id, "link.clicked")
    expect(event?.properties).toEqual({ launch_id: launch.id, is_bot: false })
    expect(event?.actorUserId).toBeNull()

    // The visitor cookie is issued once; last click wins for `attr`.
    const again = await click(link.code, { cookie: `${vid?.split(";")[0]}; attr=old` })
    const againCookies = again.headers.getSetCookie()
    expect(againCookies.some((c) => c.startsWith("vid="))).toBe(false)
    expect(againCookies.some((c) => c.startsWith(`attr=${link.id}`))).toBe(true)
  })

  it("flags bots without cookies, 404s unknown codes and unpublished launches", async () => {
    const { link, launch } = await liveWithLink()
    const bot = await click(link.code, { "user-agent": "facebookexternalhit/1.1" })
    expect(bot.status).toBe(302)
    expect(bot.headers.getSetCookie()).toEqual([])
    const rows = await testDb.db
      .select()
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, link.id))
    expect(rows).toMatchObject([{ isBot: true, visitorId: null }])

    expect((await click("Zz9Zz9Zz")).status).toBe(404)
    expect((await click("not-a-code")).status).toBe(404)
    await testDb.db
      .update(launches)
      .set({ status: "draft", wentLiveAt: null })
      .where(eq(launches.id, launch.id))
    expect((await click(link.code)).status).toBe(404)
  })

  it("still redirects a disabled link, without logging or attributing", async () => {
    const { link } = await liveWithLink()
    await testDb.db
      .update(trackedLinks)
      .set({ disabledAt: NOW })
      .where(eq(trackedLinks.id, link.id))
    const response = await click(link.code)
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get("location") ?? "").search).toBe("")
    expect(response.headers.getSetCookie()).toEqual([])
    expect(
      await testDb.db.select().from(linkClicks).where(eq(linkClicks.trackedLinkId, link.id)),
    ).toHaveLength(0)
  })

  it("keeps redirecting past the rate limit, without a log row", async () => {
    const { link } = await liveWithLink()
    for (let n = 0; n < 121; n += 1) await click(link.code)
    const rows = await testDb.db
      .select()
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, link.id))
    expect(rows).toHaveLength(120)
  })
})

describe("checkout attribution", () => {
  it("prefers an enabled cookie link of the same launch, then ?ref=, else none", async () => {
    const { launch, link } = await liveWithLink()
    const other = await liveWithLink()
    const resolve = (cookie: string | null, ref: string | null) =>
      resolveCheckoutAttribution(testDb.db, { launchId: launch.id, cookie, ref })
    expect(await resolve(link.id, null)).toEqual({ trackedLinkId: link.id, attribution: "cookie" })
    expect(await resolve(other.link.id, link.code)).toEqual({
      trackedLinkId: link.id,
      attribution: "ref",
    })
    expect(await resolve("garbage", other.link.code)).toEqual({
      trackedLinkId: null,
      attribution: null,
    })
    await testDb.db
      .update(trackedLinks)
      .set({ disabledAt: NOW })
      .where(eq(trackedLinks.id, link.id))
    expect(await resolve(link.id, link.code)).toEqual({ trackedLinkId: null, attribution: null })
  })
})

describe("the public product page", () => {
  it("loads only public launches, with the members' handles", async () => {
    const { launch, creator, builder } = await liveWithLink()
    const page = await loadPublicLaunch(testDb.db, launch.slug)
    expect(page).toMatchObject({
      status: "live",
      creator: { handle: creator.profile.handle },
      builder: { handle: builder.profile.handle },
    })
    await testDb.db
      .update(launches)
      .set({ status: "admin_review", wentLiveAt: null })
      .where(eq(launches.id, launch.id))
    expect(await loadPublicLaunch(testDb.db, launch.slug)).toBeNull()
  })

  it("records a view once per beacon with the cookie's link, skipping bots", async () => {
    const { launch, link } = await liveWithLink()
    const post = (headers: Record<string, string>) =>
      recordProductPageView(
        new Request(`${TEST_APP_URL}/p/${launch.slug}/view`, {
          method: "POST",
          headers: { "user-agent": BROWSER, ...headers },
        }),
        launch.slug,
        { db: testDb.db },
      )
    expect((await post({ cookie: `attr=${link.id}` })).status).toBe(204)
    await post({ "user-agent": "Googlebot/2.1" })
    const views = await eventsOf(testDb.db, launch.id, "product_page.viewed")
    expect(views.map((view) => view.properties)).toEqual([{ tracked_link_id: link.id }])
  })

  it("attributes a view through the forwarded ?ref= when the cookie is missing, like checkout", async () => {
    const { launch, link } = await liveWithLink()
    const other = await insertLiveLaunch(testDb.db)
    const otherLink = await insertTrackedLink(testDb.db, other.launch.id, other.creator.user.id)
    const post = (query: string) =>
      recordProductPageView(
        new Request(`${TEST_APP_URL}/p/${launch.slug}/view${query}`, {
          method: "POST",
          headers: { "user-agent": BROWSER },
        }),
        launch.slug,
        { db: testDb.db },
      )
    await post(`?ref=${link.code}`)
    // Another launch's code attributes nothing.
    await post(`?ref=${otherLink.code}`)
    const views = await eventsOf(testDb.db, launch.id, "product_page.viewed")
    expect(views.map((view) => view.properties)).toEqual([
      { tracked_link_id: link.id },
      { tracked_link_id: null },
    ])
  })

  it("serves images publicly once live, and only to members and admins before", async () => {
    const { launch, creator, collab } = await liveWithLink()
    const storage = createLocalStorage(path.join(mocks.dir, "storage"))
    // Images are added while the launch can be edited (paused here).
    await testDb.db
      .update(launches)
      .set({ status: "paused", pausedAt: NOW, pausedBy: "member" })
      .where(eq(launches.id, launch.id))
    const auth = authUserOf(creator.user)
    const { key } = await createLaunchUpload(
      { userId: creator.user.id, kind: "media", contentType: "image/png", sizeBytes: 3 },
      storage,
    )
    await storage.putObject(key, "png", "image/png")
    await addLaunchMedia(
      testDb.db,
      auth,
      { launchId: launch.id, uploadKey: key, alt: "Cover" },
      storage,
    )
    const [row] = await testDb.db.select().from(launches).where(eq(launches.id, launch.id))
    const [image] = parseMedia(row?.media)
    expect(image).toMatchObject({ kind: "image", alt: "Cover" })
    const name = mediaName(image?.url ?? "")
    const respond = async (viewer: Parameters<typeof launchMediaResponse>[0]["viewer"]) =>
      (await launchMediaResponse({ launchId: launch.id, name, viewer }, { db: testDb.db, storage }))
        .status
    expect(await respond(null)).toBe(302)
    await testDb.db
      .update(launches)
      .set({ status: "draft", pausedAt: null, pausedBy: null, wentLiveAt: null })
      .where(eq(launches.id, launch.id))
    expect(await respond(null)).toBe(404)
    expect(await respond(await strangerUser(testDb.db))).toBe(404)
    expect(await respond(auth)).toBe(302)
    void collab
  })
})

describe("the launch kit", () => {
  it("drafts posts per platform that all carry the tracked link, and records ai.generated", async () => {
    const { launch, creator, link } = await liveWithLink()
    const context = await loadKitContext(testDb.db, launch.id)
    expect(context?.link?.url).toBe(`${TEST_APP_URL}/r/${link.code}`)
    expect(context?.platforms).toEqual(["youtube", "instagram", "tiktok"])
    if (!context) throw new Error("no context")
    const result = await generateKitFor(testDb.db, { userId: creator.user.id, context })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kit.platforms).toHaveLength(3)
    for (const platform of result.kit.platforms) {
      expect(platform.posts).toHaveLength(3)
      for (const post of platform.posts) expect(post.text).toContain(context.link?.url)
    }
    const [event] = await eventsOf(testDb.db, launch.id, "ai.generated")
    expect(event?.properties).toMatchObject({
      use: "launch_kit",
      prompt_version: "launch_kit@v1",
      accepted_by_user: null,
      fallback: false,
    })
  })

  it("falls back without throwing when the model fails", async () => {
    const { launch, creator } = await liveWithLink()
    await testDb.db
      .update(launches)
      .set({ title: "FAKE_AI_ERROR kit" })
      .where(eq(launches.id, launch.id))
    const context = await loadKitContext(testDb.db, launch.id)
    if (!context) throw new Error("no context")
    const result = await generateKitFor(testDb.db, { userId: creator.user.id, context })
    expect(result).toEqual({ ok: false, reason: "fallback" })
    const [event] = await eventsOf(testDb.db, launch.id, "ai.generated")
    expect(event?.properties).toMatchObject({ fallback: true })
  })
})
