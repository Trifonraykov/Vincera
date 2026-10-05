import { describe, expect, it } from "vitest"

import {
  audienceSnapshotInputSchema,
  SOCIAL_PROVIDER_IDS,
  socialProfileSchema,
  tokenSetSchema,
} from "@/lib/social/types"

describe("social provider schemas", () => {
  it("lists the four §7.1 providers", () => {
    expect(SOCIAL_PROVIDER_IDS).toEqual(["youtube", "instagram", "tiktok", "github"])
  })

  it("accepts tokens without refresh token or expiry (GitHub, Instagram)", () => {
    const token = tokenSetSchema.parse({
      accessToken: "gho_x",
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      scopes: [],
      providerAccountId: null,
    })
    expect(token.refreshToken).toBeNull()
  })

  it("parses a profile and an audience snapshot with unknown demographics", () => {
    expect(
      socialProfileSchema.parse({
        providerAccountId: "UC123",
        username: "@ada",
        displayName: "Ada",
        avatarUrl: "https://yt3.example.com/a.jpg",
        profileUrl: "https://youtube.com/@ada",
        followers: 12_300,
        bio: null,
      }).followers,
    ).toBe(12_300)

    const snapshot = audienceSnapshotInputSchema.parse({
      followers: 12_300,
      avgViews: 4_100,
      engagementRate: 0.0523,
      topCountries: [{ country: "ES", share: 0.41 }],
      countriesBasis: "viewers",
      ageGender: null,
      topTopics: ["productivity"],
      raw: { engagedViews: 3900 },
    })
    expect(snapshot.ageGender).toBeNull()
  })

  it("rejects malformed country codes and shares", () => {
    const base = {
      followers: null,
      avgViews: null,
      engagementRate: null,
      countriesBasis: null,
      ageGender: null,
      topTopics: [],
      raw: {},
    }
    expect(
      audienceSnapshotInputSchema.safeParse({
        ...base,
        topCountries: [{ country: "es", share: 0.5 }],
      }).success,
    ).toBe(false)
    expect(
      audienceSnapshotInputSchema.safeParse({
        ...base,
        topCountries: [{ country: "ES", share: 1.5 }],
      }).success,
    ).toBe(false)
  })

  it("keeps the basis of demographics and requires it for country shares", () => {
    const base = {
      followers: null,
      avgViews: null,
      engagementRate: null,
      topTopics: [],
      raw: {},
    }
    const parsed = audienceSnapshotInputSchema.parse({
      ...base,
      topCountries: [{ country: "ES", share: 0.5 }],
      countriesBasis: "followers",
      ageGender: {
        basis: "followers",
        buckets: [{ ageGroup: "18-24", gender: "unknown", share: 1 }],
      },
    })
    expect(parsed.ageGender?.basis).toBe("followers")

    const withoutBasis = audienceSnapshotInputSchema.safeParse({
      ...base,
      topCountries: [{ country: "ES", share: 0.5 }],
      countriesBasis: null,
      ageGender: null,
    })
    expect(withoutBasis.error?.issues.map((issue) => issue.path)).toEqual([["countriesBasis"]])
  })

  it("accepts only JSON in raw", () => {
    const base = {
      followers: null,
      avgViews: null,
      engagementRate: null,
      topCountries: [],
      countriesBasis: null,
      ageGender: null,
      topTopics: [],
    }
    expect(
      audienceSnapshotInputSchema.safeParse({ ...base, raw: { a: [1, "x", null] } }).success,
    ).toBe(true)
    expect(
      audienceSnapshotInputSchema.safeParse({ ...base, raw: { at: new Date() } }).success,
    ).toBe(false)
  })
})
