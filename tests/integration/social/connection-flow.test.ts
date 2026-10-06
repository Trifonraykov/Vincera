import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { allowGdprErasure } from "@/lib/db/append-only"
import { audienceSnapshots, socialConnections } from "@/lib/db/schema"
import { loadPublicCreatorProfile } from "@/lib/public-profiles/load"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { loadAudienceOverview } from "@/lib/social/audience"
import { disconnectConnection, tokenSetOf } from "@/lib/social/connections"
import { recomputeSizeTier } from "@/lib/social/derived"
import { oauthStateCookieName } from "@/lib/social/oauth-cookie"
import { oauthCallbackResponse, oauthStartResponse } from "@/lib/social/oauth-flow"
import { syncConnection } from "@/lib/social/sync"

import { setupTestDatabase } from "../../helpers/db"
import { insertBuilder } from "../../helpers/db-fixtures"
import { TEST_APP_URL } from "../../helpers/service-env"
import { stubSocialEnv } from "../../unit/social/helpers"
import {
  authUserOf,
  eventsOf,
  makeTempDataDir,
  newCreator,
  removeTempDataDir,
  runOAuthFlow,
} from "./helpers"

/**
 * The OAuth data-connection flow end to end against the fake providers (§7.1, §14, CLAUDE.md
 * §19.14): `/api/oauth/[provider]/start` and `/callback` logic, encrypted token storage,
 * `social.connected`, the sync being queued, state/user checks, reconnects, accounts already in
 * use, and disconnecting (tokens and snapshots deleted).
 */

const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(dataRoot.dir, ...segments) }
})

const NOW = new Date("2026-10-05T12:00:00.000Z")
const testDb = setupTestDatabase()

beforeEach(async () => {
  dataRoot.dir = await makeTempDataDir()
  stubSocialEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
  // Fixture accounts are shared by the tests of this file: start each without connections.
  await testDb.db.transaction(async (tx) => {
    await allowGdprErasure(tx)
    await tx.delete(socialConnections)
  })
})

afterEach(async () => {
  setClockForTests(null)
  await removeTempDataDir(dataRoot.dir)
})

async function connectionsOf(userId: string) {
  return testDb.db.select().from(socialConnections).where(eq(socialConnections.userId, userId))
}

describe("GET /api/oauth/[provider]/start", () => {
  it("sets the encrypted state cookie and redirects to the fake consent page with PKCE", async () => {
    const creator = await newCreator(testDb.db)
    const response = await oauthStartResponse(
      new NextRequest(`${TEST_APP_URL}/api/oauth/youtube/start?returnTo=/app/audience`),
      "youtube",
      { user: creator.auth, db: testDb.db },
    )
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.pathname).toBe("/api/dev/fake-oauth/youtube/authorize")
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${TEST_APP_URL}/api/oauth/youtube/callback`,
    )
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    const cookie = response.headers.getSetCookie()[0] ?? ""
    expect(cookie).toMatch(/^oauth_state_youtube=/)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/api/oauth/youtube")
    expect(cookie.toLowerCase()).toContain("samesite=lax")
    // The state and verifier are inside the ciphertext, not readable.
    expect(cookie).not.toContain(location.searchParams.get("state") ?? "state")
  })

  it("sends signed-out visitors to sign in and comes back to the page", async () => {
    const response = await oauthStartResponse(
      new NextRequest(
        `${TEST_APP_URL}/api/oauth/youtube/start?returnTo=/onboarding/creator/connect`,
      ),
      "youtube",
      { user: null, db: testDb.db },
    )
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.pathname).toBe("/sign-in")
    expect(location.searchParams.get("callbackUrl")).toBe("/onboarding/creator/connect")
  })

  it("refuses providers the user's roles do not allow, and unknown providers", async () => {
    const builder = await insertBuilder(testDb.db)
    const response = await oauthStartResponse(
      new NextRequest(`${TEST_APP_URL}/api/oauth/youtube/start?returnTo=/app/settings/connections`),
      "youtube",
      { user: authUserOf(builder.user), db: testDb.db },
    )
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.pathname).toBe("/app/settings/connections")
    expect(location.searchParams.get("error")).toBe("not_allowed")
    expect(response.headers.getSetCookie()).toEqual([])

    const unknown = await oauthStartResponse(
      new NextRequest(`${TEST_APP_URL}/api/oauth/myspace/start`),
      "myspace",
      { user: authUserOf(builder.user), db: testDb.db },
    )
    expect(unknown.status).toBe(404)
  })

  it("ignores off-site returnTo values", async () => {
    const creator = await newCreator(testDb.db)
    const response = await oauthStartResponse(
      new NextRequest(`${TEST_APP_URL}/api/oauth/youtube/start?returnTo=https://evil.example/x`),
      "youtube",
      { user: { ...creator.auth, roles: [] }, db: testDb.db },
    )
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.origin).toBe(TEST_APP_URL)
    expect(location.pathname).toBe("/app/settings/connections")
  })

  it("rate limits starting connections per user", async () => {
    const creator = await newCreator(testDb.db)
    const start = () =>
      oauthStartResponse(
        new NextRequest(`${TEST_APP_URL}/api/oauth/tiktok/start?returnTo=/app/audience`),
        "tiktok",
        { user: creator.auth, db: testDb.db },
      )
    for (let i = 0; i < 10; i++) {
      expect(new URL((await start()).headers.get("location") ?? "").pathname).toBe(
        "/api/dev/fake-oauth/tiktok/authorize",
      )
    }
    const limited = new URL((await start()).headers.get("location") ?? "")
    expect(limited.pathname).toBe("/app/audience")
    expect(limited.searchParams.get("error")).toBe("rate_limited")
  })

  it("refuses providers switched off with SOCIAL_OAUTH_DISABLED, at the start and the callback", async () => {
    const creator = await newCreator(testDb.db)
    stubSocialEnv({ SOCIAL_OAUTH_DISABLED: "instagram" })
    const response = await oauthStartResponse(
      new NextRequest(`${TEST_APP_URL}/api/oauth/instagram/start?returnTo=/app/audience`),
      "instagram",
      { user: creator.auth, db: testDb.db },
    )
    expect(response.headers.get("location")).toBe(
      `${TEST_APP_URL}/app/audience?error=oauth_disabled&provider=instagram`,
    )

    // A flow that started before the switch is refused when it comes back.
    const run = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
      mutate: () => stubSocialEnv({ SOCIAL_OAUTH_DISABLED: "youtube" }),
    })
    expect(run.landing).toBe("/onboarding/creator/connect?error=oauth_disabled&provider=youtube")
    expect(await connectionsOf(creator.user.id)).toEqual([])
  })

  it("pauses the syncs of a provider switched off after it was connected", async () => {
    const creator = await newCreator(testDb.db)
    await runOAuthFlow(testDb.db, { user: creator.auth, provider: "youtube", account: "ada-codes" })
    const [connection] = await connectionsOf(creator.user.id)
    stubSocialEnv({ SOCIAL_OAUTH_DISABLED: "youtube" })
    expect(await syncConnection(connection!.id, { db: testDb.db })).toEqual({
      status: "skipped",
      reason: "oauth_disabled",
    })
    expect(
      await testDb.db
        .select()
        .from(audienceSnapshots)
        .where(eq(audienceSnapshots.socialConnectionId, connection!.id)),
    ).toEqual([])
  })
})

describe("GET /api/oauth/[provider]/callback", () => {
  it("stores the connection with encrypted tokens, emits social.connected and queues the sync", async () => {
    const creator = await newCreator(testDb.db)
    const run = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
    })

    expect(run.callback.status).toBe(303)
    expect(run.landing).toBe("/onboarding/creator/connect?connected=youtube")
    // The single-use state cookie is cleared.
    expect(run.callback.headers.getSetCookie()[0]).toMatch(/^oauth_state_youtube=;.*Max-Age=0/i)

    const [row, ...others] = await connectionsOf(creator.user.id)
    expect(others).toEqual([])
    expect(row).toMatchObject({
      provider: "youtube",
      source: "oauth",
      status: "active",
      username: expect.any(String),
      verifiedAt: NOW,
      tokenObtainedAt: NOW,
      lastSyncError: null,
    })
    expect(row?.providerAccountId).toBeTruthy()
    expect(row?.scopes).toContain("https://www.googleapis.com/auth/yt-analytics.readonly")
    expect(row?.expiresAt?.getTime()).toBe(NOW.getTime() + 3599 * 1000)

    // Ciphertexts only; they decrypt back to working tokens bound to this row.
    expect(row?.accessTokenEnc).toMatch(/^v1:/)
    expect(row?.refreshTokenEnc).toMatch(/^v1:/)
    const tokens = row ? tokenSetOf(row) : null
    expect(tokens?.accessToken).toBeTruthy()
    expect(row?.accessTokenEnc).not.toContain(tokens?.accessToken ?? "-")
    expect(tokenSetOf({ ...row!, id: crypto.randomUUID() })).toBeNull()

    expect(run.enqueued).toEqual([row?.id])
    const connected = await eventsOf(testDb.db, "social.connected", row?.id)
    expect(connected).toEqual([
      expect.objectContaining({
        actorUserId: creator.user.id,
        properties: { provider: "youtube", source: "oauth" },
      }),
    ])
  })

  it("connects GitHub for a builder (PKCE) and TikTok for a creator (no PKCE)", async () => {
    const builder = await insertBuilder(testDb.db)
    const github = await runOAuthFlow(testDb.db, {
      user: authUserOf(builder.user),
      provider: "github",
      account: "octo-builder",
      returnTo: "/onboarding/builder/portfolio",
    })
    expect(github.authorizeUrl.searchParams.get("code_challenge")).toBeTruthy()
    expect(github.landing).toBe("/onboarding/builder/portfolio?connected=github")

    const creator = await newCreator(testDb.db)
    const tiktok = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "tiktok",
      account: "max-moves",
    })
    expect(tiktok.authorizeUrl.searchParams.get("code_challenge")).toBeNull()
    expect(tiktok.landing).toBe("/onboarding/creator/connect?connected=tiktok")
  })

  it("rejects a state that does not match the cookie", async () => {
    const creator = await newCreator(testDb.db)
    const run = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
      mutate: (url) => url.searchParams.set("state", "forged-state-value"),
    })
    expect(run.landing).toBe("/onboarding/creator/connect?error=state_invalid&provider=youtube")
    expect(run.enqueued).toEqual([])
    expect(await connectionsOf(creator.user.id)).toEqual([])
  })

  it("rejects a callback finished by a different signed-in user", async () => {
    const alice = await newCreator(testDb.db)
    const mallory = await newCreator(testDb.db)
    const run = await runOAuthFlow(testDb.db, {
      user: alice.auth,
      provider: "youtube",
      account: "ada-codes",
      callbackUser: mallory.auth,
    })
    expect(run.landing).toBe("/onboarding/creator/connect?error=state_invalid&provider=youtube")
    expect(await connectionsOf(alice.user.id)).toEqual([])
    expect(await connectionsOf(mallory.user.id)).toEqual([])
  })

  it("rejects a callback without the state cookie, and an expired one", async () => {
    const creator = await newCreator(testDb.db)
    const missing = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
      dropCookie: true,
      returnTo: "/app/audience",
    })
    // Without the cookie the return path is unknown: the default settings page.
    expect(missing.landing).toBe("/app/settings/connections?error=state_invalid&provider=youtube")

    const start = await oauthStartResponse(
      new NextRequest(`${TEST_APP_URL}/api/oauth/youtube/start?returnTo=/app/audience`),
      "youtube",
      { user: creator.auth, db: testDb.db },
    )
    const cookie = start.headers.getSetCookie()[0]?.split(";")[0] ?? ""
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
    setClockForTests(new Date(NOW.getTime() + 11 * 60 * 1000))
    const late = await oauthCallbackResponse(
      new NextRequest(`${TEST_APP_URL}/api/oauth/youtube/callback?code=x&state=${state}`, {
        headers: { cookie },
      }),
      "youtube",
      { user: creator.auth, db: testDb.db, enqueueSync: async () => {} },
    )
    expect(late.headers.get("location")).toBe(
      `${TEST_APP_URL}/app/audience?error=session_expired&provider=youtube`,
    )
  })

  it("returns access_denied when the user cancels on the consent screen", async () => {
    const creator = await newCreator(testDb.db)
    const run = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
      mutate: (url) => {
        url.searchParams.delete("code")
        url.searchParams.set("error", "access_denied")
      },
    })
    expect(run.landing).toBe("/onboarding/creator/connect?error=access_denied&provider=youtube")
  })

  it("maps a refused code to invalid_code", async () => {
    const creator = await newCreator(testDb.db)
    const run = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
      mutate: (url) => url.searchParams.set("code", "fkc_not-a-real-code"),
    })
    expect(run.landing).toBe("/onboarding/creator/connect?error=invalid_code&provider=youtube")
  })

  it("updates the same row on reconnect instead of adding one", async () => {
    const creator = await newCreator(testDb.db)
    await runOAuthFlow(testDb.db, { user: creator.auth, provider: "youtube", account: "ada-codes" })
    const [first] = await connectionsOf(creator.user.id)
    await testDb.db
      .update(socialConnections)
      .set({ status: "expired", lastSyncError: "token_expired", lastSyncErrorAt: NOW })
      .where(eq(socialConnections.id, first!.id))

    setClockForTests(new Date(NOW.getTime() + 60 * 60 * 1000))
    const again = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
    })
    expect(again.landing).toContain("connected=youtube")
    const rows = await connectionsOf(creator.user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: first?.id,
      status: "active",
      lastSyncError: null,
      lastSyncErrorAt: null,
      providerAccountId: first?.providerAccountId,
    })
    expect(rows[0]?.accessTokenEnc).not.toBe(first?.accessTokenEnc)
    expect(rows[0]?.tokenObtainedAt?.getTime()).toBe(NOW.getTime() + 60 * 60 * 1000)
    expect(await eventsOf(testDb.db, "social.connected", first?.id)).toHaveLength(2)
  })

  it("refuses a provider account already connected by another user", async () => {
    const owner = await newCreator(testDb.db)
    const other = await newCreator(testDb.db)
    await runOAuthFlow(testDb.db, { user: owner.auth, provider: "youtube", account: "ada-codes" })
    const run = await runOAuthFlow(testDb.db, {
      user: other.auth,
      provider: "youtube",
      account: "ada-codes",
    })
    expect(run.landing).toBe("/onboarding/creator/connect?error=account_in_use&provider=youtube")
    expect(await connectionsOf(other.user.id)).toEqual([])
  })

  it("upgrades a manual entry to OAuth in place, without passing the typed number as verified", async () => {
    const creator = await newCreator(testDb.db)
    const [manual] = await testDb.db
      .insert(socialConnections)
      .values({
        userId: creator.user.id,
        provider: "youtube",
        source: "manual",
        profileUrl: "https://www.youtube.com/@ada",
        evidenceStorageKey: `social-evidence/${creator.user.id}/youtube-x.png`,
        lastSyncedAt: NOW,
      })
      .returning()
    // The creator typed a far larger number than the channel has.
    await testDb.db.insert(audienceSnapshots).values({
      socialConnectionId: manual!.id,
      takenAt: NOW,
      followers: 900_000,
      topCountries: [],
      topTopics: [],
      raw: { source: "manual", v: 1 },
    })
    await recomputeSizeTier(testDb.db, creator.user.id)

    const run = await runOAuthFlow(testDb.db, {
      user: creator.auth,
      provider: "youtube",
      account: "ada-codes",
    })
    expect(run.landing).toBe("/onboarding/creator/connect?connected=youtube")
    const rows = await connectionsOf(creator.user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: manual?.id,
      source: "oauth",
      verifiedAt: NOW,
      evidenceStorageKey: null,
      lastSyncedAt: null,
    })

    // Until the first OAuth sync, nothing reads the typed number as verified.
    expect(
      await testDb.db
        .select()
        .from(audienceSnapshots)
        .where(eq(audienceSnapshots.socialConnectionId, manual!.id)),
    ).toEqual([])
    const overview = await loadAudienceOverview(testDb.db, creator.user.id)
    expect(overview.connections[0]).toMatchObject({ health: "syncing", latest: null })
    expect(overview.syncPending).toBe(true)
    expect(overview.profile?.sizeTier).toBeNull()
    const publicProfile = await loadPublicCreatorProfile(testDb.db, creator.profile.handle)
    expect(publicProfile).toMatchObject({ sizeTier: null, verifiedReach: null })
    expect(publicProfile?.platforms.some((platform) => platform.followers === 900_000)).toBe(false)

    // The first sync brings the platform's own numbers.
    expect((await syncConnection(manual!.id, { db: testDb.db })).status).toBe("synced")
    const synced = await loadAudienceOverview(testDb.db, creator.user.id)
    expect(synced.connections[0]).toMatchObject({ health: "ok", verified: true })
    expect(synced.connections[0]?.latest?.followers).not.toBe(900_000)
  })
})

describe("disconnect", () => {
  it("deletes the row, its tokens and its snapshots in one transaction", async () => {
    const creator = await newCreator(testDb.db)
    await runOAuthFlow(testDb.db, { user: creator.auth, provider: "youtube", account: "ada-codes" })
    const [row] = await connectionsOf(creator.user.id)
    expect((await syncConnection(row!.id, { db: testDb.db })).status).toBe("synced")
    expect(
      await testDb.db
        .select()
        .from(audienceSnapshots)
        .where(eq(audienceSnapshots.socialConnectionId, row!.id)),
    ).toHaveLength(1)

    const removed = await disconnectConnection(testDb.db, {
      connectionId: row!.id,
      userId: creator.user.id,
    })
    expect(removed).toMatchObject({ id: row?.id, provider: "youtube", source: "oauth" })
    expect(removed?.tokens?.accessToken).toBeTruthy()
    expect(await connectionsOf(creator.user.id)).toEqual([])
    expect(
      await testDb.db
        .select()
        .from(audienceSnapshots)
        .where(eq(audienceSnapshots.socialConnectionId, row!.id)),
    ).toEqual([])
    expect(await eventsOf(testDb.db, "social.disconnected", row?.id)).toEqual([
      expect.objectContaining({ properties: { provider: "youtube", source: "oauth" } }),
    ])
  })

  it("does nothing for another user's connection", async () => {
    const owner = await newCreator(testDb.db)
    const other = await newCreator(testDb.db)
    await runOAuthFlow(testDb.db, { user: owner.auth, provider: "youtube", account: "ada-codes" })
    const [row] = await connectionsOf(owner.user.id)
    expect(
      await disconnectConnection(testDb.db, { connectionId: row!.id, userId: other.user.id }),
    ).toBeNull()
    expect(await connectionsOf(owner.user.id)).toHaveLength(1)
  })
})

it("names the state cookie per provider", () => {
  expect(oauthStateCookieName("github")).toBe("oauth_state_github")
})
