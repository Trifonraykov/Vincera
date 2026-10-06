import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SocialProviderError, SocialRetryableError, SocialTokenError } from "@/lib/social/errors"
import { mintFakeAuthorizationCode } from "@/lib/social/fake/transport"
import { INSTAGRAM_BASIC_SCOPE, INSTAGRAM_INSIGHTS_SCOPE } from "@/lib/social/instagram"
import { instagramRawSchema } from "@/lib/social/raw"
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
const LONG_LIVED_SECONDS = 5_183_944

describe("Instagram: authorization URL", () => {
  it("asks for the two business scopes, comma-separated, without PKCE", () => {
    const provider = liveLikeProvider("instagram")
    const url = new URL(provider.authUrl("state-1"))
    expect(`${url.origin}${url.pathname}`).toBe("https://www.instagram.com/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "live-instagram-client",
      redirect_uri: callbackUrl("instagram"),
      response_type: "code",
      scope: `${INSTAGRAM_BASIC_SCOPE},${INSTAGRAM_INSIGHTS_SCOPE}`,
      state: "state-1",
    })
    expect(provider.supportsPkce).toBe(false)
  })
})

describe("Instagram: tokens", () => {
  it("exchanges the code, then swaps the short-lived token for a 60-day one", async () => {
    const { provider, calls } = fakeProvider("instagram")
    const token = await connect(provider, "luna-bakes")

    expect(token).toMatchObject({
      refreshToken: null,
      refreshExpiresAt: null,
      scopes: [INSTAGRAM_BASIC_SCOPE, INSTAGRAM_INSIGHTS_SCOPE],
      // The profile's professional account id is the identity, not the token's user_id.
      providerAccountId: null,
      obtainedAt: NOW,
    })
    expect(token.accessToken).toMatch(/^fka_/)
    expect(token.expiresAt).toEqual(new Date(NOW.getTime() + LONG_LIVED_SECONDS * 1000))

    expect(calls.map((call) => `${call.method} ${call.url.origin}${call.url.pathname}`)).toEqual([
      "POST https://api.instagram.com/oauth/access_token",
      "GET https://graph.instagram.com/access_token",
    ])
    expect(calls[1]!.url.searchParams.get("grant_type")).toBe("ig_exchange_token")
  })

  it("accepts the flat token reply with a numeric user_id and a permissions array", async () => {
    const { provider } = fakeProvider("instagram")
    const token = await connect(provider, "tiny-studio")
    expect(token.scopes).toEqual([INSTAGRAM_BASIC_SCOPE, INSTAGRAM_INSIGHTS_SCOPE])
    expect(token.providerAccountId).toBeNull()
  })

  it("strips the #_ Instagram appends to the code", async () => {
    const { provider } = fakeProvider("instagram")
    const code = mintFakeAuthorizationCode({
      provider: "instagram",
      account: "luna-bakes",
      redirectUri: callbackUrl("instagram"),
    })
    const token = await provider.exchangeCode(`${code}#_`)
    expect(token.accessToken).toMatch(/^fka_/)
  })

  it("reports a bad code as invalid_code, and a refused client secret as our error", async () => {
    const { provider } = fakeProvider("instagram")
    const bad = await rejectionOf(provider.exchangeCode("fkc_forged.code"))
    expect((bad as SocialProviderError).code).toBe("invalid_code")

    const misconfigured = fakeProvider("instagram", (url) =>
      url.hostname === "api.instagram.com"
        ? jsonResponse(400, {
            error_type: "OAuthException",
            code: 101,
            error_message: "Error validating client secret.",
          })
        : undefined,
    )
    const error = await rejectionOf(misconfigured.provider.exchangeCode("x"))
    expect((error as SocialProviderError).code).toBe("provider_error")
  })

  it("refuses a grant without the basic scope", async () => {
    const { provider } = fakeProvider("instagram", (url) =>
      url.hostname === "api.instagram.com"
        ? jsonResponse(200, {
            data: [{ access_token: "short", user_id: "1", permissions: INSTAGRAM_INSIGHTS_SCOPE }],
          })
        : undefined,
    )
    const error = await rejectionOf(provider.exchangeCode("x"))
    expect((error as SocialProviderError).code).toBe("scope_missing")
  })

  it("does not refresh a token younger than 24 hours", async () => {
    const { provider, calls } = fakeProvider("instagram")
    const token = await connect(provider, "luna-bakes")
    const before = calls.length

    setClock(new Date(NOW.getTime() + 23 * 3_600_000))
    expect(tokenNeedsRefresh("instagram", token, new Date(NOW.getTime() + 23 * 3_600_000))).toBe(
      false,
    )
    expect(await provider.refresh(token)).toBe(token)
    expect(calls).toHaveLength(before)
  })

  it("refreshes with ig_refresh_token once the token is a day old", async () => {
    const { provider, calls } = fakeProvider("instagram")
    const token = await connect(provider, "luna-bakes")

    const later = new Date(NOW.getTime() + 2 * DAY)
    setClock(later)
    expect(tokenNeedsRefresh("instagram", token, later)).toBe(true)
    const refreshed = await provider.refresh(token)

    const call = calls.at(-1)!
    expect(`${call.url.origin}${call.url.pathname}`).toBe(
      "https://graph.instagram.com/refresh_access_token",
    )
    expect(call.url.searchParams.get("grant_type")).toBe("ig_refresh_token")
    expect(refreshed.accessToken).not.toBe(token.accessToken)
    expect(refreshed.expiresAt).toEqual(new Date(later.getTime() + LONG_LIVED_SECONDS * 1000))
    expect(refreshed.obtainedAt).toEqual(later)
    expect(refreshed.refreshToken).toBeNull()
  })

  it("estimates a token's age from its expiry when obtainedAt is unknown", async () => {
    const { provider, calls } = fakeProvider("instagram")
    const token = await connect(provider, "luna-bakes")
    const before = calls.length

    // A fresh 60-day expiry means a fresh token: nothing to do.
    const fresh = { ...token, obtainedAt: undefined }
    expect(await provider.refresh(fresh)).toBe(fresh)
    expect(calls).toHaveLength(before)

    // 30 days left means it was issued about 30 days ago.
    const aging = { ...fresh, expiresAt: new Date(NOW.getTime() + 30 * DAY) }
    expect(tokenNeedsRefresh("instagram", aging, NOW)).toBe(true)
    const refreshed = await provider.refresh(aging)
    expect(calls).toHaveLength(before + 1)
    expect(refreshed.accessToken).not.toBe(token.accessToken)
    expect(refreshed.obtainedAt).toEqual(NOW)
  })

  it("cannot refresh an expired token (the user must reconnect)", async () => {
    const { provider, calls } = fakeProvider("instagram")
    const token = await connect(provider, "luna-bakes")
    const before = calls.length
    setClock(new Date(NOW.getTime() + 61 * DAY))
    const error = await rejectionOf(provider.refresh(token))
    expect(error).toBeInstanceOf(SocialTokenError)
    expect(calls).toHaveLength(before)
  })

  it("maps a rejected access token (Graph error 190) to SocialTokenError", async () => {
    const { provider } = fakeProvider("instagram")
    const token = await connect(provider, "luna-bakes")
    const error = await rejectionOf(provider.fetchProfile({ ...token, accessToken: "fka_bogus" }))
    expect(error).toBeInstanceOf(SocialTokenError)
    expect(error.message).not.toContain("fka_bogus")
  })
})

describe("Instagram: profile and audience", () => {
  it("maps the professional account profile", async () => {
    const { provider } = fakeProvider("instagram")
    const profile = await provider.fetchProfile(await connect(provider, "luna-bakes"))
    expect(profile).toEqual({
      providerAccountId: "17841400008460056",
      username: "luna.bakes",
      displayName: "Luna Bakes",
      avatarUrl: "https://scontent.cdninstagram.com/v/t51.2885-19/fake_luna_bakes.jpg",
      profileUrl: "https://www.instagram.com/luna.bakes/",
      followers: 12_480,
      bio: null,
    })
  })

  it("maps posts, insights and follower demographics, tolerating a failed insight", async () => {
    const { provider, callsTo } = fakeProvider("instagram")
    const token = await connect(provider, "luna-bakes")
    const snapshot = await provider.fetchAudience(token)

    expect(audienceSnapshotInputSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot.followers).toBe(12_480)
    // 7 posts with views (the carousel's insights failed with #100).
    expect(snapshot.avgViews).toBe(37_459)
    // (likes + comments + shares) / views.
    expect(snapshot.engagementRate).toBe(0.0496)

    // Shares of all followers (only the top 45 countries are listed); top 10 kept.
    expect(snapshot.countriesBasis).toBe("followers")
    expect(snapshot.topCountries).toHaveLength(10)
    expect(snapshot.topCountries[0]).toEqual({ country: "ES", share: 0.25 })
    expect(snapshot.topCountries.map((c) => c.country)).not.toContain("PT")

    expect(snapshot.ageGender?.basis).toBe("followers")
    expect(snapshot.ageGender?.buckets).toContainEqual({
      ageGroup: "25-34",
      gender: "female",
      share: 0.281,
    })
    expect(snapshot.ageGender?.buckets).toContainEqual({
      ageGroup: "25-34",
      gender: "unknown",
      share: 0.0173,
    })
    const total = snapshot.ageGender!.buckets.reduce((sum, b) => sum + b.share, 0)
    expect(total).toBeCloseTo(1, 2)
    expect(snapshot.topTopics).toContain("sourdough")

    const raw = instagramRawSchema.parse(snapshot.raw)
    expect(raw.insights).toEqual({ available: true, failedMedia: 1 })
    expect(raw.demographics).toEqual({ available: true, totalFollowersCounted: 12_170 })
    const carousel = raw.recentMedia.find((m) => m.id === "18030000000000008")
    expect(carousel).toMatchObject({ views: null, likes: 1410, comments: 88 })
    expect(JSON.stringify(snapshot)).not.toContain(token.accessToken)

    // Graph API v26.0, the views metric (never the deprecated impressions/plays).
    for (const call of callsTo("/insights")) {
      expect(call.url.pathname.startsWith("/v26.0/")).toBe(true)
      expect(call.url.searchParams.get("metric")).not.toMatch(/impressions|plays/)
    }
  })

  it("skips demographics below 100 followers", async () => {
    const { provider, callsTo } = fakeProvider("instagram")
    const snapshot = await provider.fetchAudience(await connect(provider, "tiny-studio"))

    expect(snapshot.followers).toBe(64)
    expect(snapshot.avgViews).toBe(560)
    expect(snapshot.engagementRate).toBe(0.053)
    expect(snapshot.topCountries).toEqual([])
    expect(snapshot.countriesBasis).toBeNull()
    expect(snapshot.ageGender).toBeNull()
    expect(
      callsTo("/insights").filter(
        (call) => call.url.searchParams.get("metric") === "follower_demographics",
      ),
    ).toHaveLength(0)
    expect(instagramRawSchema.parse(snapshot.raw).demographics).toEqual({
      available: false,
      reason: "below_minimum",
    })
  })

  it("reads no insights when the insights scope was not granted", async () => {
    const { provider, callsTo } = fakeProvider("instagram")
    const token = await connect(provider, "luna-bakes")
    const snapshot = await provider.fetchAudience({ ...token, scopes: [INSTAGRAM_BASIC_SCOPE] })

    expect(callsTo("/insights")).toHaveLength(0)
    expect(snapshot.avgViews).toBeNull()
    expect(snapshot.engagementRate).toBeNull()
    expect(snapshot.ageGender).toBeNull()
    const raw = instagramRawSchema.parse(snapshot.raw)
    expect(raw.demographics).toEqual({ available: false, reason: "scope_not_granted" })
    expect(raw.recentMedia[0]).toMatchObject({ likes: 1820, views: null })
  })

  it("refuses personal accounts", async () => {
    const { provider } = fakeProvider("instagram", (url) =>
      url.pathname === "/v26.0/me"
        ? jsonResponse(200, { id: "1", user_id: "2", username: "me", account_type: "PERSONAL" })
        : undefined,
    )
    const error = await rejectionOf(provider.fetchProfile(await connect(provider, "luna-bakes")))
    expect((error as SocialProviderError).code).toBe("not_eligible")
  })

  it("classifies Graph rate limits as retryable", async () => {
    const { provider } = fakeProvider("instagram", (url) =>
      url.pathname === "/v26.0/me"
        ? jsonResponse(400, {
            error: {
              message: "Application request limit reached",
              type: "OAuthException",
              code: 4,
            },
          })
        : undefined,
    )
    const error = await rejectionOf(provider.fetchProfile(await connect(provider, "luna-bakes")))
    expect(error).toBeInstanceOf(SocialRetryableError)
    expect((error as SocialRetryableError).reason).toBe("rate_limited")
  })

  it("turns a malformed media list into invalid_response", async () => {
    const { provider } = fakeProvider("instagram", (url) =>
      url.pathname.endsWith("/media") ? jsonResponse(200, { data: "nope" }) : undefined,
    )
    const error = await rejectionOf(provider.fetchAudience(await connect(provider, "luna-bakes")))
    expect((error as SocialProviderError).code).toBe("invalid_response")
  })
})
