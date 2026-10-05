import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { authUser } from "../../helpers/auth-users"
import {
  canConnectSocial,
  canManageSocialConnection,
  canVerifySocialConnection,
  canViewOwnAudience,
} from "@/lib/social/authz"
import {
  connectErrorMessage,
  isConnectErrorCode,
  withConnectResult,
} from "@/lib/social/connect-errors"
import { checkEvidenceFile, followerCountSchema, isProfileUrlFor } from "@/lib/social/manual-policy"
import { revokeTokens } from "@/lib/social/revoke"
import { computeSizeTier, sizeTierFor } from "@/lib/social/size-tier"
import { audienceSummaryFormSchema, parseTopicsInput } from "@/lib/social/summary-form"
import type { TokenSet } from "@/lib/social/types"
import { hasPendingSync, healthOf, type ConnectionView } from "@/lib/social/view"

import { resetSocialTest, setupSocialTest } from "./helpers"

/** Pure pieces of the connection flow (CLAUDE.md §19.14). */

describe("size tiers (§5)", () => {
  it.each([
    [0, "nano"],
    [9_999, "nano"],
    [10_000, "micro"],
    [99_999, "micro"],
    [100_000, "mid"],
    [500_000, "mid"],
    [500_001, "macro"],
  ] as const)("%d followers → %s", (followers, tier) => {
    expect(sizeTierFor(followers)).toBe(tier)
  })

  it("is null without a follower count", () => {
    expect(sizeTierFor(null)).toBeNull()
  })

  it("prefers verified connections and falls back to unverified ones", () => {
    expect(
      computeSizeTier([
        { status: "active", verified: true, followers: 48_200 },
        { status: "active", verified: false, followers: 900_000 },
      ]),
    ).toEqual({ tier: "micro", verified: true, followers: 48_200 })
    expect(
      computeSizeTier([
        { status: "active", verified: false, followers: 900_000 },
        { status: "expired", verified: true, followers: 20_000 },
        { status: "revoked", verified: true, followers: 2_000_000 },
      ]),
    ).toEqual({ tier: "macro", verified: false, followers: 900_000 })
    expect(computeSizeTier([])).toEqual({ tier: null, verified: false, followers: null })
  })
})

describe("social authz", () => {
  it("lets creators connect audience providers and builders GitHub", () => {
    const creator = authUser({ roles: ["creator"] })
    const builder = authUser({ roles: ["builder"] })
    expect(canConnectSocial(creator, "youtube")).toBe(true)
    expect(canConnectSocial(creator, "github")).toBe(true)
    expect(canConnectSocial(builder, "github")).toBe(true)
    expect(canConnectSocial(builder, "instagram")).toBe(false)
    expect(canConnectSocial({ ...creator, status: "suspended" }, "youtube")).toBe(false)
  })

  it("limits connection management to the owner and verification to admins", () => {
    const user = authUser()
    expect(canManageSocialConnection(user, { userId: user.id })).toBe(true)
    expect(canManageSocialConnection(user, { userId: crypto.randomUUID() })).toBe(false)
    expect(canVerifySocialConnection(user)).toBe(false)
    expect(canVerifySocialConnection(authUser({ roles: ["admin"] }))).toBe(true)
    expect(canViewOwnAudience(authUser({ roles: ["builder"] }))).toBe(false)
  })
})

describe("connect result parameters", () => {
  it("appends connected or error and drops earlier values", () => {
    expect(withConnectResult("/onboarding/creator/connect", { connected: "youtube" })).toBe(
      "/onboarding/creator/connect?connected=youtube",
    )
    expect(
      withConnectResult("/app/audience?error=x&provider=tiktok&tab=1", {
        error: "access_denied",
        provider: "youtube",
      }),
    ).toBe("/app/audience?tab=1&error=access_denied&provider=youtube")
  })

  it("has a plain-language message for every code, without leaking unknown input", () => {
    expect(connectErrorMessage("account_in_use", "youtube")).toContain("YouTube")
    expect(connectErrorMessage("token_expired", "instagram")).toContain("Reconnect Instagram")
    expect(connectErrorMessage("<script>", null)).toBe(
      "Something went wrong while connecting the provider. Please try again.",
    )
    expect(isConnectErrorCode("state_invalid")).toBe(true)
    expect(isConnectErrorCode("nope")).toBe(false)
  })
})

describe("manual entry policy", () => {
  it("accepts images up to 25 MB only", () => {
    expect(checkEvidenceFile({ contentType: "image/PNG", sizeBytes: 1000 })).toEqual({
      ok: true,
      contentType: "image/png",
    })
    expect(checkEvidenceFile({ contentType: "image/svg+xml", sizeBytes: 10 }).ok).toBe(false)
    expect(checkEvidenceFile({ contentType: "application/pdf", sizeBytes: 10 }).ok).toBe(false)
    expect(checkEvidenceFile({ contentType: "image/jpeg", sizeBytes: 0 }).ok).toBe(false)
    expect(checkEvidenceFile({ contentType: "image/jpeg", sizeBytes: 25 * 1024 * 1024 }).ok).toBe(
      true,
    )
    expect(
      checkEvidenceFile({ contentType: "image/jpeg", sizeBytes: 25 * 1024 * 1024 + 1 }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("25 MB") })
  })

  it("checks profile links per provider", () => {
    expect(isProfileUrlFor("youtube", "https://www.youtube.com/@ada")).toBe(true)
    expect(isProfileUrlFor("youtube", "https://m.youtube.com/@ada")).toBe(true)
    expect(isProfileUrlFor("youtube", "http://www.youtube.com/@ada")).toBe(false)
    expect(isProfileUrlFor("youtube", "https://youtube.com.evil.example/@ada")).toBe(false)
    expect(isProfileUrlFor("instagram", "https://user:pw@instagram.com/x")).toBe(false)
    expect(isProfileUrlFor("tiktok", "https://www.tiktok.com/@max")).toBe(true)
    expect(isProfileUrlFor("tiktok", "javascript:alert(1)")).toBe(false)
  })

  it("parses follower counts with separators", () => {
    expect(followerCountSchema.parse("12,500")).toBe(12_500)
    expect(followerCountSchema.parse("1 200 000")).toBe(1_200_000)
    expect(followerCountSchema.safeParse("12k").success).toBe(false)
    expect(followerCountSchema.safeParse("-5").success).toBe(false)
  })
})

describe("audience summary form", () => {
  it("normalises topics", () => {
    expect(parseTopicsInput("Fitness, Meal prep ,#budget,,fitness\nhome_cooking")).toEqual([
      "fitness",
      "meal prep",
      "budget",
      "home cooking",
    ])
  })

  it("limits the summary and the number of topics", () => {
    expect(
      audienceSummaryFormSchema.parse({ summary: "  Two   spaces. ", topics: "a, b" }),
    ).toEqual({ summary: "Two spaces.", topics: ["a", "b"] })
    expect(
      audienceSummaryFormSchema.safeParse({ summary: "x".repeat(1201), topics: "" }).success,
    ).toBe(false)
    expect(
      audienceSummaryFormSchema.safeParse({ summary: "", topics: "1,2,3,4,5,6,7,8,9" }).success,
    ).toBe(false)
  })
})

describe("connection views", () => {
  const view = (overrides: Partial<ConnectionView>): ConnectionView => ({
    id: crypto.randomUUID(),
    provider: "youtube",
    label: "YouTube",
    source: "oauth",
    status: "active",
    verified: true,
    username: null,
    displayName: null,
    avatarUrl: null,
    profileUrl: null,
    lastSyncedAt: null,
    lastSyncError: null,
    health: "syncing",
    updatedAt: new Date("2026-10-05T12:00:00Z"),
    latest: null,
    github: null,
    ...overrides,
  })

  it("derives health", () => {
    const base = { verified: true, lastSyncError: null, hasSnapshot: true } as const
    expect(healthOf({ ...base, source: "oauth", status: "active" })).toBe("ok")
    expect(healthOf({ ...base, source: "oauth", status: "expired" })).toBe("expired")
    expect(healthOf({ ...base, source: "oauth", status: "active", hasSnapshot: false })).toBe(
      "syncing",
    )
    expect(
      healthOf({ ...base, source: "oauth", status: "active", lastSyncError: "rate_limited" }),
    ).toBe("error")
    expect(healthOf({ ...base, source: "manual", status: "active", verified: false })).toBe(
      "unverified",
    )
  })

  it("waits for a first sync for two minutes at most", () => {
    const syncing = [view({ health: "syncing" })]
    expect(hasPendingSync(syncing, new Date("2026-10-05T12:01:00Z"))).toBe(true)
    expect(hasPendingSync(syncing, new Date("2026-10-05T12:03:00Z"))).toBe(false)
    expect(hasPendingSync([view({ health: "ok" })], new Date("2026-10-05T12:00:30Z"))).toBe(false)
  })
})

describe("best-effort revoke", () => {
  beforeEach(() => setupSocialTest())
  afterEach(() => resetSocialTest())

  const tokens: TokenSet = {
    accessToken: "access-123",
    refreshToken: "refresh-456",
    expiresAt: null,
    refreshExpiresAt: null,
    scopes: [],
    providerAccountId: null,
  }

  it("skips fake providers and Instagram (no revocation endpoint)", async () => {
    expect(await revokeTokens("youtube", tokens)).toBe("skipped_fake")
    expect(await revokeTokens("instagram", tokens)).toBe("unsupported")
  })

  it("revokes Google grants with the refresh token and never throws", async () => {
    const calls: { url: string; body: string }[] = []
    const outcome = await revokeTokens("youtube", tokens, {
      fetch: async (url, init) => {
        calls.push({ url, body: String(init.body) })
        return new Response(null, { status: 200 })
      },
    })
    expect(outcome).toBe("revoked")
    expect(calls).toEqual([
      { url: "https://oauth2.googleapis.com/revoke", body: "token=refresh-456" },
    ])
    expect(
      await revokeTokens("tiktok", tokens, {
        fetch: async () => {
          throw new Error("network down")
        },
      }),
    ).toBe("failed")
    expect(
      await revokeTokens("github", tokens, {
        fetch: async () => new Response(null, { status: 404 }),
      }),
    ).toBe("failed")
  })
})
