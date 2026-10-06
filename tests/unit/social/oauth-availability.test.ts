import { describe, expect, it } from "vitest"

import { EnvValidationError, isSocialOAuthEnabled, parseEnv } from "@/lib/env"
import { connectErrorMessage, isConnectErrorCode } from "@/lib/social/connect-errors"

/**
 * SOCIAL_OAUTH_DISABLED (§7.1 "if a provider's API is not approved yet, allow manual entry";
 * CLAUDE.md §19.14): a provider whose OAuth app cannot be used yet is switched off, and its
 * credentials are then not required in production.
 */

const KEY_32 = Buffer.alloc(32, 7).toString("base64")

const base = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/creator_dev",
  AUTH_SECRET: "a".repeat(32),
  ENCRYPTION_KEY: KEY_32,
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
} as const

/** A complete production environment without any Meta or TikTok credentials. */
const productionWithoutMetaOrTikTok = {
  ...base,
  NODE_ENV: "production",
  AUTH_URL: "https://app.example.com",
  AUTH_GOOGLE_ID: "google-id",
  AUTH_GOOGLE_SECRET: "google-secret",
  AUTH_GITHUB_ID: "github-id",
  AUTH_GITHUB_SECRET: "github-secret",
  RESEND_API_KEY: "re_123",
  EMAIL_FROM: "Vincera <hello@example.com>",
  STRIPE_SECRET_KEY: "sk_live_123",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_123",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_123",
  GOOGLE_YT_CLIENT_ID: "yt-id",
  GOOGLE_YT_CLIENT_SECRET: "yt-secret",
  GITHUB_DATA_CLIENT_ID: "gh-data-id",
  GITHUB_DATA_CLIENT_SECRET: "gh-data-secret",
  ANTHROPIC_API_KEY: "sk-ant-123",
  ANTHROPIC_MODEL: "claude-opus-5-5",
  EMBEDDINGS_PROVIDER: "voyage",
  VOYAGE_API_KEY: "pa-123",
  R2_ACCOUNT_ID: "r2-account",
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  R2_BUCKET: "r2-bucket",
  INNGEST_EVENT_KEY: "inngest-event",
  INNGEST_SIGNING_KEY: "inngest-signing",
  SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
  NEXT_PUBLIC_POSTHOG_KEY: "phc_123",
  APP_NAME: "Vincera",
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  UPSTASH_REDIS_REST_URL: "https://redis.example.com",
  UPSTASH_REDIS_REST_TOKEN: "upstash-token",
} as const

function problemsOf(source: Record<string, string | undefined>): readonly string[] {
  try {
    parseEnv(source)
  } catch (error) {
    if (error instanceof EnvValidationError) return error.problems
    throw error
  }
  return []
}

describe("SOCIAL_OAUTH_DISABLED", () => {
  it("enables every provider by default", () => {
    const env = parseEnv(base)
    for (const provider of ["youtube", "instagram", "tiktok", "github"] as const) {
      expect(isSocialOAuthEnabled(provider, env)).toBe(true)
    }
  })

  it("switches providers off, ignoring case and spaces", () => {
    const env = parseEnv({ ...base, SOCIAL_OAUTH_DISABLED: " Instagram , tiktok " })
    expect(isSocialOAuthEnabled("instagram", env)).toBe(false)
    expect(isSocialOAuthEnabled("tiktok", env)).toBe(false)
    expect(isSocialOAuthEnabled("youtube", env)).toBe(true)
  })

  it("rejects unknown providers", () => {
    expect(problemsOf({ ...base, SOCIAL_OAUTH_DISABLED: "instagram,facebook" })).toEqual([
      expect.stringMatching(/^SOCIAL_OAUTH_DISABLED: unknown provider "facebook"/),
    ])
  })

  it("lets production run without the credentials of switched-off providers", () => {
    expect(problemsOf(productionWithoutMetaOrTikTok)).toEqual([
      "META_APP_ID: is required in production",
      "META_APP_SECRET: is required in production",
      "TIKTOK_CLIENT_KEY: is required in production",
      "TIKTOK_CLIENT_SECRET: is required in production",
    ])
    const env = parseEnv({
      ...productionWithoutMetaOrTikTok,
      SOCIAL_OAUTH_DISABLED: "instagram,tiktok",
    })
    expect(isSocialOAuthEnabled("instagram", env)).toBe(false)
    expect(isSocialOAuthEnabled("youtube", env)).toBe(true)
  })

  it("has a plain-language connect error for a switched-off provider", () => {
    expect(isConnectErrorCode("oauth_disabled")).toBe(true)
    expect(connectErrorMessage("oauth_disabled", "instagram")).toBe(
      "Connecting Instagram isn't available yet. Enter your numbers by hand for now; you can connect later.",
    )
    expect(connectErrorMessage("oauth_disabled", "github")).toBe(
      "Connecting GitHub isn't available right now. Please try again later.",
    )
  })
})
