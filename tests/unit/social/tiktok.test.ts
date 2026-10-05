import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SocialProviderError, SocialRetryableError, SocialTokenError } from "@/lib/social/errors"
import { tiktokRawSchema } from "@/lib/social/raw"
import { TIKTOK_MAX_VIDEOS, TIKTOK_SCOPES } from "@/lib/social/tiktok"
import { tokenNeedsRefresh } from "@/lib/social/tokens"
import { audienceSnapshotInputSchema } from "@/lib/social/types"

import {
  callbackUrl,
  connect,
  fakeProvider,
  jsonResponse,
  liveLikeProvider,
  NOW,
  rejectionOf,
  resetSocialTest,
  setClock,
  setupSocialTest,
} from "./helpers"

beforeEach(() => setupSocialTest())
afterEach(() => resetSocialTest())

const DAY = 86_400_000
const LOG_ID = "202610050000000000TEST"

describe("TikTok: authorization URL", () => {
  it("uses client_key and comma-separated scopes, without PKCE", () => {
    const provider = liveLikeProvider("tiktok")
    const url = new URL(provider.authUrl("state-t"))
    expect(`${url.origin}${url.pathname}`).toBe("https://www.tiktok.com/v2/auth/authorize/")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_key: "live-tiktok-client",
      response_type: "code",
      scope: "user.info.basic,user.info.profile,user.info.stats,video.list",
      redirect_uri: callbackUrl("tiktok"),
      state: "state-t",
    })
    expect(provider.supportsPkce).toBe(false)
  })
})

describe("TikTok: tokens", () => {
  it("exchanges the code for 24h access and 365-day refresh tokens", async () => {
    const { provider } = fakeProvider("tiktok")
    const token = await connect(provider, "max-moves")
    expect(token).toMatchObject({
      providerAccountId: "723f24d7-e717-40f8-a2b6-cb8464cd23b4",
      scopes: [...TIKTOK_SCOPES],
      expiresAt: new Date(NOW.getTime() + DAY),
      refreshExpiresAt: new Date(NOW.getTime() + 365 * DAY),
      obtainedAt: NOW,
    })
    expect(token.refreshToken).toMatch(/^fkr_/)
  })

  it("rotates the refresh token on every refresh", async () => {
    const { provider, callsTo } = fakeProvider("tiktok")
    const token = await connect(provider, "max-moves")

    const later = new Date(NOW.getTime() + DAY + 60_000)
    setClock(later)
    expect(tokenNeedsRefresh("tiktok", token, later)).toBe(true)
    expect(await rejectionOf(provider.fetchProfile(token))).toBeInstanceOf(SocialTokenError)

    const refreshed = await provider.refresh(token)
    expect(refreshed.refreshToken).not.toBe(token.refreshToken)
    expect(refreshed.accessToken).not.toBe(token.accessToken)
    expect(refreshed.refreshExpiresAt).toEqual(new Date(later.getTime() + 365 * DAY))
    expect(refreshed.expiresAt).toEqual(new Date(later.getTime() + DAY))
    const form = new URLSearchParams(callsTo("/oauth/token/").at(-1)!.init.body)
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("client_key")).toBe("fake-tiktok-client")

    expect((await provider.fetchProfile(refreshed)).username).toBe("maxmoves")
  })

  it("rejects an expired refresh token without calling TikTok", async () => {
    const { provider, calls } = fakeProvider("tiktok")
    const token = await connect(provider, "max-moves")
    const before = calls.length
    setClock(new Date(NOW.getTime() + 366 * DAY))
    expect(await rejectionOf(provider.refresh(token))).toBeInstanceOf(SocialTokenError)
    expect(calls).toHaveLength(before)
  })

  it("maps invalid_grant on refresh to SocialTokenError", async () => {
    const { provider } = fakeProvider("tiktok")
    const token = await connect(provider, "max-moves")
    const error = await rejectionOf(provider.refresh({ ...token, refreshToken: "fkr_forged.x" }))
    expect(error).toBeInstanceOf(SocialTokenError)
    expect(error.message).not.toContain("fkr_forged")
  })

  it("reads token errors that arrive with HTTP 200, and never expires on our own errors", async () => {
    let reply = { error: "invalid_grant", error_description: "Refresh token is invalid." }
    const { provider } = fakeProvider("tiktok", (url) =>
      url.pathname === "/v2/oauth/token/"
        ? jsonResponse(200, { ...reply, log_id: LOG_ID })
        : undefined,
    )
    const token = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW,
      refreshExpiresAt: null,
      scopes: [],
      providerAccountId: null,
    }
    expect(await rejectionOf(provider.refresh(token))).toBeInstanceOf(SocialTokenError)

    for (const code of ["invalid_client", "invalid_request"]) {
      reply = { error: code, error_description: "nope" }
      const error = await rejectionOf(provider.refresh(token))
      expect(error).toBeInstanceOf(SocialProviderError)
      expect((error as SocialProviderError).code).toBe("provider_error")
    }

    reply = { error: "rate_limit_exceeded", error_description: "slow down" }
    expect(await rejectionOf(provider.refresh(token))).toBeInstanceOf(SocialRetryableError)

    reply = { error: "invalid_grant", error_description: "Authorization code is expired." }
    const exchange = await rejectionOf(provider.exchangeCode("code"))
    expect((exchange as SocialProviderError).code).toBe("invalid_code")
  })
})

describe("TikTok: profile and audience", () => {
  it("maps the profile", async () => {
    const { provider } = fakeProvider("tiktok")
    const profile = await provider.fetchProfile(await connect(provider, "max-moves"))
    expect(profile).toMatchObject({
      providerAccountId: "723f24d7-e717-40f8-a2b6-cb8464cd23b4",
      username: "maxmoves",
      displayName: "Max Moves",
      profileUrl: "https://www.tiktok.com/@maxmoves",
      followers: 86_400,
    })
  })

  it("maps recent videos and reports no demographics", async () => {
    const { provider, callsTo } = fakeProvider("tiktok")
    const token = await connect(provider, "max-moves")
    const snapshot = await provider.fetchAudience(token)

    expect(audienceSnapshotInputSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot).toMatchObject({
      followers: 86_400,
      avgViews: 167_650,
      engagementRate: 0.134,
      topCountries: [],
      countriesBasis: null,
      ageGender: null,
    })
    expect(snapshot.topTopics).toContain("dance")
    expect(snapshot.topTopics).toContain("tutorial")

    const raw = tiktokRawSchema.parse(snapshot.raw)
    expect(raw.recentVideos).toHaveLength(8)
    expect(raw.recentVideos[0]).toMatchObject({
      id: "7421000000000000008",
      createdAt: "2026-10-03T20:00:00.000Z",
    })
    expect(raw.missingScopes).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain(token.accessToken)

    const [list] = callsTo("/video/list/")
    expect(list!.method).toBe("POST")
    expect(JSON.parse(list!.init.body!)).toEqual({ max_count: TIKTOK_MAX_VIDEOS })
    expect(TIKTOK_MAX_VIDEOS).toBe(20)
    expect(list!.url.searchParams.get("fields")).toContain("view_count")
  })

  it("asks only for the fields of granted scopes, and copes with no videos", async () => {
    const { provider, callsTo } = fakeProvider("tiktok")
    const token = await connect(provider, "fresh-start")
    expect(token.scopes).toEqual(["user.info.basic", "video.list"])

    const snapshot = await provider.fetchAudience(token)
    expect(callsTo("/user/info/")[0]!.url.searchParams.get("fields")).toBe(
      "open_id,union_id,avatar_url,display_name",
    )
    expect(snapshot).toMatchObject({
      followers: null,
      avgViews: null,
      engagementRate: null,
      topTopics: [],
      ageGender: null,
    })
    expect(tiktokRawSchema.parse(snapshot.raw).missingScopes).toEqual([
      "user.info.profile",
      "user.info.stats",
    ])
    const profile = await provider.fetchProfile(token)
    expect(profile).toMatchObject({ username: null, profileUrl: null, followers: null })
  })

  it("does not list videos without video.list", async () => {
    const { provider, callsTo } = fakeProvider("tiktok")
    const token = await connect(provider, "max-moves")
    const snapshot = await provider.fetchAudience({
      ...token,
      scopes: ["user.info.basic", "user.info.profile", "user.info.stats"],
    })
    expect(callsTo("/video/list/")).toHaveLength(0)
    expect(snapshot.followers).toBe(86_400)
    expect(snapshot.avgViews).toBeNull()
  })

  it("maps Display API error envelopes", async () => {
    let envelope = { code: "rate_limit_exceeded", status: 429 }
    const { provider } = fakeProvider("tiktok", (url) =>
      url.pathname === "/v2/user/info/"
        ? jsonResponse(envelope.status, {
            data: {},
            error: { code: envelope.code, message: "x", log_id: LOG_ID },
          })
        : undefined,
    )
    const token = await connect(provider, "max-moves")

    expect(await rejectionOf(provider.fetchProfile(token))).toBeInstanceOf(SocialRetryableError)

    envelope = { code: "access_token_invalid", status: 401 }
    expect(await rejectionOf(provider.fetchProfile(token))).toBeInstanceOf(SocialTokenError)

    envelope = { code: "scope_not_authorized", status: 200 }
    const scope = await rejectionOf(provider.fetchProfile(token))
    expect((scope as SocialProviderError).code).toBe("scope_missing")

    envelope = { code: "internal_error", status: 500 }
    const down = await rejectionOf(provider.fetchProfile(token))
    expect((down as SocialRetryableError).reason).toBe("unavailable")
  })

  it("turns a malformed user payload into invalid_response", async () => {
    const { provider } = fakeProvider("tiktok", (url) =>
      url.pathname === "/v2/user/info/"
        ? jsonResponse(200, {
            data: { user: { display_name: "no id" } },
            error: { code: "ok", message: "", log_id: LOG_ID },
          })
        : undefined,
    )
    const error = await rejectionOf(provider.fetchProfile(await connect(provider, "max-moves")))
    expect((error as SocialProviderError).code).toBe("invalid_response")
  })
})
