import { describe, expect, it } from "vitest"
import { z } from "zod"

import { canConnectProvider, socialProviderLabel } from "@/lib/social/catalog"
import {
  isSocialErrorCode,
  SOCIAL_ERROR_CODES,
  SocialProviderError,
  SocialRetryableError,
  SocialTokenError,
  socialErrorCode,
  socialErrorMessage,
} from "@/lib/social/errors"
import {
  defaultErrorKind,
  describeIssues,
  expiresIn,
  requestUrl,
  splitScopes,
} from "@/lib/social/http"
import {
  averageCount,
  cleanText,
  engagementRate,
  isoDurationSeconds,
  PG_INT_MAX,
  safeUrl,
  toCount,
  toShare,
} from "@/lib/social/metrics"
import { parseSnapshotRaw, recentContentTitles } from "@/lib/social/raw"
import { deriveTopics, MAX_SNAPSHOT_TOPICS } from "@/lib/social/topics"

describe("snapshot metrics", () => {
  it("clamps engagement to numeric(6,4) and needs views", () => {
    expect(engagementRate(523, 10_000)).toBe(0.0523)
    expect(engagementRate(1, 3)).toBe(0.3333)
    expect(engagementRate(5_000_000, 10)).toBe(99)
    expect(engagementRate(-5, 10)).toBe(0)
    expect(engagementRate(10, 0)).toBeNull()
    expect(engagementRate(Number.NaN, 10)).toBeNull()
  })

  it("rounds counts into an integer column and shares into 0–1", () => {
    expect(toCount(12.6)).toBe(13)
    expect(toCount(-3)).toBe(0)
    expect(toCount(1e12)).toBe(PG_INT_MAX)
    expect(toCount(undefined)).toBeNull()
    expect(toCount(Number.POSITIVE_INFINITY)).toBeNull()
    expect(toShare(1, 3)).toBe(0.3333)
    expect(toShare(5, 0)).toBe(0)
    expect(toShare(7, 5)).toBe(1)
    expect(averageCount([])).toBeNull()
    expect(averageCount([1, 2])).toBe(2)
  })

  it("parses ISO 8601 durations", () => {
    expect(isoDurationSeconds("PT14M2S")).toBe(842)
    expect(isoDurationSeconds("PT1H")).toBe(3600)
    expect(isoDurationSeconds("P1DT2H")).toBe(93_600)
    expect(isoDurationSeconds("P0D")).toBe(0)
    expect(isoDurationSeconds("PT")).toBeNull()
    expect(isoDurationSeconds("14:02")).toBeNull()
  })

  it("keeps only http(s) URLs and tidies text", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull()
    expect(safeUrl("not a url")).toBeNull()
    expect(safeUrl("https://x.example/a b")).toBe("https://x.example/a%20b")
    expect(cleanText("  a\u0000b \n\n c  ")).toBe("a b c")
    expect(cleanText("abcdef", 4)).toBe("abc…")
    expect(cleanText("   ")).toBeNull()
  })
})

describe("deriveTopics", () => {
  it("prefers hashtags and tags that recur across items", () => {
    const topics = deriveTopics([
      { text: "Sourdough basics #sourdough #baking" },
      { text: "Rye loaf, high hydration #sourdough #rye" },
      { text: "Cinnamon buns #baking", tags: ["Baking", "Sweet_Treats"] },
      { text: "Watch my new video! Subscribe for more https://example.com @friend" },
    ])
    expect(topics.slice(0, 2)).toEqual(["baking", "sourdough"])
    expect(topics).not.toContain("subscribe")
    expect(topics).not.toContain("video")
    expect(topics).not.toContain("friend")
  })

  it("caps the list and accepts single items when there are few", () => {
    expect(deriveTopics([{ text: "Notion templates for freelancers" }])).toEqual([
      "freelancers",
      "notion",
      "templates",
    ])
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `#topic${i} #topic${i}` }))
    expect(deriveTopics([...many, ...many]).length).toBe(MAX_SNAPSHOT_TOPICS)
    expect(deriveTopics([])).toEqual([])
  })
})

describe("errors", () => {
  it("maps every error to a short code and a plain-language message", () => {
    expect(socialErrorCode(new SocialTokenError("youtube", "x"))).toBe("token_expired")
    expect(socialErrorCode(new SocialRetryableError("tiktok", "rate_limited", "x"))).toBe(
      "rate_limited",
    )
    expect(socialErrorCode(new SocialRetryableError("tiktok", "unavailable", "x"))).toBe(
      "provider_unavailable",
    )
    expect(socialErrorCode(new SocialProviderError("youtube", "no_channel", "x"))).toBe(
      "no_channel",
    )
    expect(socialErrorCode(new Error("boom"))).toBe("provider_error")
    for (const code of SOCIAL_ERROR_CODES) {
      const message = socialErrorMessage(code, "YouTube")
      expect(message.length).toBeGreaterThan(20)
      expect(message).not.toMatch(/undefined|HTTP|\d{3}/)
    }
    expect(isSocialErrorCode("token_expired")).toBe(true)
    expect(isSocialErrorCode("<script>")).toBe(false)
  })

  it("lets creators connect audiences and builders connect GitHub", () => {
    expect(canConnectProvider(["creator"], "youtube")).toBe(true)
    expect(canConnectProvider(["builder"], "youtube")).toBe(false)
    expect(canConnectProvider(["builder"], "github")).toBe(true)
    expect(canConnectProvider(["creator"], "github")).toBe(true)
    expect(canConnectProvider(["admin"], "github")).toBe(false)
    expect(socialProviderLabel("tiktok")).toBe("TikTok")
  })
})

describe("http helpers", () => {
  it("classifies statuses", () => {
    expect(defaultErrorKind(401)).toBe("token")
    expect(defaultErrorKind(429)).toBe("rate_limited")
    expect(defaultErrorKind(500)).toBe("unavailable")
    expect(defaultErrorKind(503)).toBe("unavailable")
    expect(defaultErrorKind(400)).toBe("fatal")
    expect(defaultErrorKind(403)).toBe("fatal")
  })

  it("builds URLs, scope lists and expiries", () => {
    expect(
      requestUrl({ url: "https://api.example.com/x", query: { a: "1", b: undefined, c: 2 } }),
    ).toBe("https://api.example.com/x?a=1&c=2")
    expect(splitScopes("a b,c  d")).toEqual(["a", "b", "c", "d"])
    expect(splitScopes(["x", " y "])).toEqual(["x", "y"])
    expect(splitScopes(null)).toEqual([])
    const at = new Date("2026-10-05T00:00:00Z")
    expect(expiresIn(at, 60)).toEqual(new Date("2026-10-05T00:01:00Z"))
    expect(expiresIn(at, undefined)).toBeNull()
    expect(expiresIn(at, 0)).toBeNull()
  })

  it("describes Zod issues by path and code, never by value", () => {
    const result = z.object({ n: z.number() }).safeParse({ n: "secret-value" })
    if (result.success) throw new Error("unreachable")
    expect(describeIssues(result.error)).toBe("n: invalid_type")
  })
})

describe("raw payload readers", () => {
  it("return null for missing or foreign payloads, and titles for the summary", () => {
    expect(parseSnapshotRaw("youtube", { provider: "tiktok", v: 1 })).toBeNull()
    expect(recentContentTitles("instagram", null)).toEqual([])
    expect(
      recentContentTitles("tiktok", {
        provider: "tiktok",
        v: 1,
        user: {
          openId: "o",
          username: null,
          displayName: null,
          isVerified: null,
          followerCount: null,
          followingCount: null,
          likesCount: null,
          videoCount: null,
        },
        recentVideos: [
          {
            id: "1",
            title: "First",
            createdAt: null,
            durationSeconds: null,
            views: 1,
            likes: null,
            comments: null,
            shares: null,
          },
          {
            id: "2",
            title: null,
            createdAt: null,
            durationSeconds: null,
            views: null,
            likes: null,
            comments: null,
            shares: null,
          },
        ],
        missingScopes: [],
      }),
    ).toEqual(["First"])
  })
})
