import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SocialProviderError, SocialRetryableError, SocialTokenError } from "@/lib/social/errors"
import { mintFakeAuthorizationCode } from "@/lib/social/fake/transport"
import { createCodeVerifier, pkceChallenge } from "@/lib/social/pkce"
import { youtubeRawSchema } from "@/lib/social/raw"
import {
  YOUTUBE_ANALYTICS_SCOPE,
  YOUTUBE_READONLY_SCOPE,
  normalizeYouTubeAgeGroup,
} from "@/lib/social/youtube"
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

const HOUR = 3_600_000

describe("YouTube: authorization URL", () => {
  it("asks Google for offline access with both read-only scopes and PKCE S256", () => {
    const provider = liveLikeProvider("youtube")
    const pkce = pkceChallenge(createCodeVerifier())
    const url = new URL(provider.authUrl("state-123", pkce))

    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "live-youtube-client",
      redirect_uri: callbackUrl("youtube"),
      response_type: "code",
      scope: `${YOUTUBE_READONLY_SCOPE} ${YOUTUBE_ANALYTICS_SCOPE}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: "state-123",
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    })
    expect(provider.supportsPkce).toBe(true)
  })

  it("points the fake provider at the dev authorize page", () => {
    const { provider } = fakeProvider("youtube")
    const url = new URL(provider.authUrl("s"))
    expect(url.pathname).toBe("/api/dev/fake-oauth/youtube/authorize")
    expect(url.searchParams.get("redirect_uri")).toBe(callbackUrl("youtube"))
  })
})

describe("YouTube: tokens", () => {
  it("exchanges a fake code with its PKCE verifier for offline tokens", async () => {
    const { provider, callsTo } = fakeProvider("youtube")
    const token = await connect(provider, "ada-codes")

    expect(token.accessToken).toMatch(/^fka_/)
    expect(token.refreshToken).toMatch(/^fkr_/)
    expect(token.expiresAt).toEqual(new Date(NOW.getTime() + 3599 * 1000))
    expect(token.refreshExpiresAt).toBeNull()
    expect(token.scopes).toEqual([YOUTUBE_READONLY_SCOPE, YOUTUBE_ANALYTICS_SCOPE])
    expect(token.obtainedAt).toEqual(NOW)

    const [exchange] = callsTo("/token")
    const form = new URLSearchParams(exchange!.init.body)
    expect(form.get("grant_type")).toBe("authorization_code")
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(form.get("redirect_uri")).toBe(callbackUrl("youtube"))
  })

  it("refuses a code redeemed with the wrong verifier, late, or for another provider", async () => {
    const { provider } = fakeProvider("youtube")
    const mint = (provider: "youtube" | "github", codeChallenge?: string) =>
      mintFakeAuthorizationCode({
        provider,
        account: provider === "youtube" ? "ada-codes" : "octo-builder",
        redirectUri: callbackUrl("youtube"),
        codeChallenge,
      })

    const verifier = createCodeVerifier()
    const withChallenge = mint("youtube", pkceChallenge(verifier).codeChallenge)
    for (const attempt of [
      provider.exchangeCode(withChallenge, { codeVerifier: createCodeVerifier() }),
      provider.exchangeCode(withChallenge),
      provider.exchangeCode(mint("github")),
      provider.exchangeCode("not-a-code"),
    ]) {
      const error = await rejectionOf(attempt)
      expect(error).toBeInstanceOf(SocialProviderError)
      expect((error as SocialProviderError).code).toBe("invalid_code")
    }

    const code = mint("youtube")
    setClock(new Date(NOW.getTime() + 11 * 60_000))
    const late = await rejectionOf(provider.exchangeCode(code))
    expect((late as SocialProviderError).code).toBe("invalid_code")
  })

  it("refreshes an expired access token and keeps the refresh token Google does not resend", async () => {
    const { provider, callsTo } = fakeProvider("youtube")
    const token = await connect(provider, "ada-codes")

    const later = new Date(NOW.getTime() + 2 * HOUR)
    setClock(later)
    const expired = await rejectionOf(provider.fetchProfile(token))
    expect(expired).toBeInstanceOf(SocialTokenError)

    const refreshed = await provider.refresh(token)
    expect(refreshed.accessToken).not.toBe(token.accessToken)
    expect(refreshed.refreshToken).toBe(token.refreshToken)
    expect(refreshed.expiresAt).toEqual(new Date(later.getTime() + 3599 * 1000))
    expect(refreshed.obtainedAt).toEqual(later)
    expect(new URLSearchParams(callsTo("/token").at(-1)!.init.body).get("grant_type")).toBe(
      "refresh_token",
    )

    const profile = await provider.fetchProfile(refreshed)
    expect(profile.providerAccountId).toBe("UCaDaC0des5x7Qm1RkT9pLzw")
  })

  it("reports a revoked refresh token (invalid_grant) as SocialTokenError", async () => {
    const { provider } = fakeProvider("youtube")
    const token = await connect(provider, "lapsed-lens")
    // Testing-status apps get 7-day refresh tokens.
    expect(token.refreshExpiresAt).toEqual(new Date(NOW.getTime() + 604_799 * 1000))

    setClock(new Date(NOW.getTime() + 2 * HOUR))
    const error = await rejectionOf(provider.refresh(token))
    expect(error).toBeInstanceOf(SocialTokenError)
    expect(error.message).not.toContain(token.refreshToken!)
  })

  it("cannot refresh without a refresh token", async () => {
    const { provider, calls } = fakeProvider("youtube")
    const token = await connect(provider, "ada-codes")
    const error = await rejectionOf(provider.refresh({ ...token, refreshToken: null }))
    expect(error).toBeInstanceOf(SocialTokenError)
    expect(calls).toHaveLength(1)
  })

  it("treats invalid_client on refresh as our configuration error, not an expired token", async () => {
    const { provider } = fakeProvider("youtube", (url) =>
      url.pathname === "/token"
        ? jsonResponse(401, { error: "invalid_client", error_description: "Unauthorized" })
        : undefined,
    )
    const error = await rejectionOf(
      provider.refresh({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: NOW,
        refreshExpiresAt: null,
        scopes: [],
        providerAccountId: null,
      }),
    )
    expect(error).toBeInstanceOf(SocialProviderError)
    expect((error as SocialProviderError).code).toBe("provider_error")
  })

  it("refuses a grant without youtube.readonly (unticked on the consent screen)", async () => {
    const { provider } = fakeProvider("youtube", (url) =>
      url.pathname === "/token"
        ? jsonResponse(200, {
            access_token: "ya29.x",
            expires_in: 3599,
            scope: YOUTUBE_ANALYTICS_SCOPE,
            token_type: "Bearer",
          })
        : undefined,
    )
    const error = await rejectionOf(provider.exchangeCode("any-code"))
    expect((error as SocialProviderError).code).toBe("scope_missing")
  })
})

describe("YouTube: profile and audience", () => {
  it("maps the channel profile", async () => {
    const { provider } = fakeProvider("youtube")
    const profile = await provider.fetchProfile(await connect(provider, "ada-codes"))
    expect(profile).toMatchObject({
      providerAccountId: "UCaDaC0des5x7Qm1RkT9pLzw",
      username: "@adacodes",
      profileUrl: "https://www.youtube.com/@adacodes",
      followers: 48_200,
    })
    expect(profile.avatarUrl).toMatch(/^https:\/\/yt3\.ggpht\.com\//)
  })

  it("maps a full channel: recent videos, viewer countries and demographics", async () => {
    const { provider, calls, callsTo } = fakeProvider("youtube")
    const token = await connect(provider, "ada-codes")
    const snapshot = await provider.fetchAudience(token)

    expect(audienceSnapshotInputSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot.followers).toBe(48_200)
    // 12 settled videos: the upcoming premiere and yesterday's upload are skipped.
    expect(snapshot.avgViews).toBe(33_532)
    // (likes + comments) / views over those videos; missing likes/comments count as 0.
    expect(snapshot.engagementRate).toBe(0.044)

    // Countries by share of the window's views; ZZ (unknown) is dropped.
    expect(snapshot.countriesBasis).toBe("viewers")
    expect(snapshot.topCountries.slice(0, 3)).toEqual([
      { country: "ES", share: 0.278 },
      { country: "MX", share: 0.1634 },
      { country: "US", share: 0.138 },
    ])
    expect(snapshot.topCountries.map((c) => c.country)).not.toContain("ZZ")
    expect(snapshot.topCountries).toHaveLength(9)

    expect(snapshot.ageGender?.basis).toBe("viewers")
    expect(snapshot.ageGender?.buckets).toContainEqual({
      ageGroup: "25-34",
      gender: "male",
      share: 0.214,
    })
    expect(snapshot.ageGender?.buckets).toContainEqual({
      ageGroup: "65+",
      gender: "female",
      share: 0.004,
    })
    expect(snapshot.ageGender?.buckets).toContainEqual({
      ageGroup: "18-24",
      gender: "other",
      share: 0.012,
    })
    expect(snapshot.topTopics.length).toBeGreaterThan(0)
    expect(snapshot.topTopics).toContain("notion")

    const raw = youtubeRawSchema.parse(snapshot.raw)
    expect(raw.recentVideos).toHaveLength(12)
    expect(raw.recentVideos.map((v) => v.id)).not.toContain("aDa0000live")
    expect(raw.recentVideos.map((v) => v.id)).not.toContain("aDa00000013")
    expect(raw.recentVideos[0]).toMatchObject({ id: "aDa00000012", durationSeconds: 581 })
    expect(raw.analytics).toMatchObject({
      available: true,
      startDate: "2026-07-07",
      endDate: "2026-10-04",
      totals: { views: 1_843_210, engagedViews: 1_702_334 },
    })
    // Never tokens in raw.
    expect(JSON.stringify(snapshot)).not.toContain(token.accessToken)

    // Quota rules: no search.list; videos.list with ≤ 50 ids; analytics for the own channel.
    expect(calls.some((call) => call.url.pathname.includes("/search"))).toBe(false)
    const [videos] = callsTo("/videos")
    expect(videos!.url.searchParams.get("id")!.split(",").length).toBeLessThanOrEqual(50)
    const reports = callsTo("/reports")
    expect(reports).toHaveLength(3)
    for (const report of reports) {
      expect(report.url.searchParams.get("ids")).toBe("channel==MINE")
      expect(report.url.searchParams.get("startDate")).toBe("2026-07-07")
      expect(report.url.searchParams.get("endDate")).toBe("2026-10-04")
    }
  })

  it("handles a hidden subscriber count and analytics without rows", async () => {
    const { provider } = fakeProvider("youtube")
    const token = await connect(provider, "quiet-kitchen")

    expect((await provider.fetchProfile(token)).followers).toBeNull()

    const snapshot = await provider.fetchAudience(token)
    expect(snapshot.followers).toBeNull()
    expect(snapshot.avgViews).toBe(4_650)
    expect(snapshot.engagementRate).toBe(0.0602)
    expect(snapshot.topCountries).toEqual([])
    expect(snapshot.countriesBasis).toBeNull()
    expect(snapshot.ageGender).toBeNull()
    expect(snapshot.topTopics.slice(0, 4)).toEqual(["vegan", "meal prep", "onepot", "budget"])

    const raw = youtubeRawSchema.parse(snapshot.raw)
    expect(raw.channel).toMatchObject({ subscriberCount: null, hiddenSubscriberCount: true })
    expect(raw.analytics).toMatchObject({ available: true, totals: { views: null } })
  })

  it("keeps countries when demographics are below YouTube's thresholds", async () => {
    const { provider } = fakeProvider("youtube")
    const snapshot = await provider.fetchAudience(await connect(provider, "lapsed-lens"))
    expect(snapshot.followers).toBe(3_210)
    expect(snapshot.topCountries).toEqual([
      { country: "PT", share: 0.2977 },
      { country: "BR", share: 0.1961 },
      { country: "US", share: 0.1489 },
      { country: "ES", share: 0.0704 },
    ])
    expect(snapshot.ageGender).toBeNull()
  })

  it("skips Analytics when its scope was not granted", async () => {
    const { provider, callsTo } = fakeProvider("youtube")
    const token = await connect(provider, "ada-codes")
    const snapshot = await provider.fetchAudience({ ...token, scopes: [YOUTUBE_READONLY_SCOPE] })

    expect(callsTo("/reports")).toHaveLength(0)
    expect(snapshot.topCountries).toEqual([])
    expect(snapshot.ageGender).toBeNull()
    expect(snapshot.avgViews).toBe(33_532)
    expect(youtubeRawSchema.parse(snapshot.raw).analytics).toEqual({
      available: false,
      reason: "scope_not_granted",
    })
  })

  it("falls back to Data API numbers when Analytics answers 403", async () => {
    const { provider } = fakeProvider("youtube", (url) =>
      url.pathname === "/v2/reports"
        ? jsonResponse(403, {
            error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "forbidden" }] },
          })
        : undefined,
    )
    const snapshot = await provider.fetchAudience(await connect(provider, "ada-codes"))
    expect(snapshot.followers).toBe(48_200)
    expect(snapshot.topCountries).toEqual([])
    expect(youtubeRawSchema.parse(snapshot.raw).analytics).toEqual({
      available: false,
      reason: "forbidden",
    })
  })

  it("reports an account without a channel", async () => {
    const { provider } = fakeProvider("youtube", (url) =>
      url.pathname === "/youtube/v3/channels"
        ? jsonResponse(200, { kind: "youtube#channelListResponse", pageInfo: { totalResults: 0 } })
        : undefined,
    )
    const error = await rejectionOf(provider.fetchProfile(await connect(provider, "ada-codes")))
    expect((error as SocialProviderError).code).toBe("no_channel")
  })

  it("turns a malformed response into a clean invalid_response error", async () => {
    const { provider } = fakeProvider("youtube", (url) =>
      url.pathname === "/youtube/v3/channels"
        ? jsonResponse(200, {
            items: [{ id: "UC1", statistics: { subscriberCount: "lots", secret: "s3cr3t" } }],
          })
        : undefined,
    )
    const token = await connect(provider, "ada-codes")
    const error = await rejectionOf(provider.fetchProfile(token))
    expect(error).toBeInstanceOf(SocialProviderError)
    expect((error as SocialProviderError).code).toBe("invalid_response")
    expect(error.message).toContain("channels.list")
    expect(error.message).not.toContain("lots")
    expect(error.message).not.toContain(token.accessToken)
  })

  it("classifies quota, rate-limit and outage responses as retryable", async () => {
    const respond = { status: 0, body: {} as unknown, headers: {} as Record<string, string> }
    const { provider } = fakeProvider("youtube", (url) =>
      url.pathname === "/youtube/v3/channels"
        ? jsonResponse(respond.status, respond.body, respond.headers)
        : undefined,
    )
    const token = await connect(provider, "ada-codes")

    Object.assign(respond, {
      status: 403,
      body: { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } },
      headers: {},
    })
    const quota = await rejectionOf(provider.fetchProfile(token))
    expect(quota).toBeInstanceOf(SocialRetryableError)
    expect((quota as SocialRetryableError).reason).toBe("rate_limited")

    Object.assign(respond, { status: 429, body: {}, headers: { "Retry-After": "30" } })
    const limited = (await rejectionOf(provider.fetchProfile(token))) as SocialRetryableError
    expect(limited.reason).toBe("rate_limited")
    expect(limited.retryAfterSeconds).toBe(30)

    Object.assign(respond, { status: 503, body: {}, headers: {} })
    const down = (await rejectionOf(provider.fetchProfile(token))) as SocialRetryableError
    expect(down).toBeInstanceOf(SocialRetryableError)
    expect(down.reason).toBe("unavailable")
    expect(down.retryAfterSeconds).toBeNull()
  })

  it("treats a network failure as retryable without leaking the URL", async () => {
    const provider = liveLikeProvider("youtube", async () => {
      throw new TypeError("fetch failed: https://www.googleapis.com/?access_token=leak")
    })
    const error = await rejectionOf(
      provider.fetchProfile({
        accessToken: "leak",
        refreshToken: null,
        expiresAt: null,
        refreshExpiresAt: null,
        scopes: [],
        providerAccountId: null,
      }),
    )
    expect(error).toBeInstanceOf(SocialRetryableError)
    expect(error.message).not.toContain("leak")
  })
})

describe("normalizeYouTubeAgeGroup", () => {
  it("maps YouTube's age groups to plain ranges", () => {
    expect(normalizeYouTubeAgeGroup("age13-17")).toBe("13-17")
    expect(normalizeYouTubeAgeGroup("age65-")).toBe("65+")
  })
})
