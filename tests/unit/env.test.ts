import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  EnvValidationError,
  FAKEABLE_SERVICES,
  isAdminEmail,
  isFake,
  isProduction,
  isSocialProviderFake,
  parseEnv,
  PUBLISHED_SECRET_VALUES,
  testRoutesEnabled,
} from "@/lib/env"

const KEY_32 = Buffer.alloc(32, 7).toString("base64")

/** The minimum a non-production environment needs. */
const base = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/creator_dev",
  AUTH_SECRET: "a".repeat(32),
  ENCRYPTION_KEY: KEY_32,
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
} as const

/** Every §17 credential, as a production deployment would set them. */
const production = {
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
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_123",
  GOOGLE_YT_CLIENT_ID: "yt-id",
  GOOGLE_YT_CLIENT_SECRET: "yt-secret",
  META_APP_ID: "meta-id",
  META_APP_SECRET: "meta-secret",
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "tt-secret",
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

describe("parseEnv: development", () => {
  it("accepts the core variables and applies defaults", () => {
    const env = parseEnv(base)
    expect(env.APP_ENV).toBe("development")
    expect(env.APP_NAME).toBe("Vincera")
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000")
    expect(env.PLATFORM_TAKE_RATE).toBe(0.1)
    expect(env.HOLD_DAYS).toBe(14)
    expect(env.MIN_PAYOUT_CENTS).toBe(1000)
    expect(env.AUTO_APPROVE_LAUNCHES).toBe(false)
    expect(env.E2E_TEST_ROUTES).toBe(false)
    expect(env.EMAIL_FROM).toBe("Vincera <onboarding@resend.dev>")
    expect(env.ADMIN_EMAILS).toEqual([])
    expect(env.FAKE_SERVICES.size).toBe(0)
  })

  it("reports every missing core variable at once", () => {
    const problems = problemsOf({ NODE_ENV: "development" })
    expect(problems).toEqual([
      "DATABASE_URL: is required",
      "AUTH_SECRET: is required",
      "ENCRYPTION_KEY: is required",
      "STRIPE_WEBHOOK_SECRET: is required",
    ])
  })

  it("treats empty strings as unset", () => {
    const env = parseEnv({ ...base, APP_NAME: "", RESEND_API_KEY: "  " })
    expect(env.APP_NAME).toBe("Vincera")
    expect(env.RESEND_API_KEY).toBeUndefined()
  })

  it("rejects an encryption key that is not 32 bytes", () => {
    const short = Buffer.alloc(16).toString("base64")
    expect(problemsOf({ ...base, ENCRYPTION_KEY: short })).toEqual([
      expect.stringMatching(/^ENCRYPTION_KEY: must be 32 random bytes/),
    ])
  })

  it("parses typed numbers and booleans", () => {
    const env = parseEnv({
      ...base,
      PLATFORM_TAKE_RATE: "0.15",
      HOLD_DAYS: "7",
      MIN_PAYOUT_CENTS: "2500",
      AUTO_APPROVE_LAUNCHES: "true",
    })
    expect(env.PLATFORM_TAKE_RATE).toBe(0.15)
    expect(env.HOLD_DAYS).toBe(7)
    expect(env.MIN_PAYOUT_CENTS).toBe(2500)
    expect(env.AUTO_APPROVE_LAUNCHES).toBe(true)
  })

  it.each([
    ["PLATFORM_TAKE_RATE", "1.5"],
    ["PLATFORM_TAKE_RATE", "ten percent"],
    ["HOLD_DAYS", "1.5"],
    ["HOLD_DAYS", "-1"],
    ["MIN_PAYOUT_CENTS", "10.50"],
    ["AUTO_APPROVE_LAUNCHES", "maybe"],
  ])("rejects %s=%s", (key, value) => {
    const problems = problemsOf({ ...base, [key]: value })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(new RegExp(`^${key}: `))
  })

  it("normalizes ADMIN_EMAILS and rejects invalid entries", () => {
    const env = parseEnv({ ...base, ADMIN_EMAILS: " Admin@Example.com, ops@example.com ," })
    expect(env.ADMIN_EMAILS).toEqual(["admin@example.com", "ops@example.com"])
    expect(isAdminEmail("ADMIN@example.com ", env)).toBe(true)
    expect(isAdminEmail("someone@example.com", env)).toBe(false)
    expect(problemsOf({ ...base, ADMIN_EMAILS: "not-an-email" })).toHaveLength(1)
  })

  it("forbids live Stripe keys outside production (§7.2)", () => {
    expect(problemsOf({ ...base, STRIPE_SECRET_KEY: "sk_live_abc" })).toEqual([
      expect.stringMatching(/^STRIPE_SECRET_KEY: live keys are only allowed in production/),
    ])
    expect(parseEnv({ ...base, STRIPE_SECRET_KEY: "sk_test_abc" }).STRIPE_SECRET_KEY).toBe(
      "sk_test_abc",
    )
  })

  it("never echoes secret values in errors", () => {
    const secret = "sk_live_super_secret_value"
    const message = (() => {
      try {
        parseEnv({ ...base, STRIPE_SECRET_KEY: secret, AUTH_SECRET: "short-secret" })
      } catch (error) {
        return String(error)
      }
      return ""
    })()
    expect(message).not.toContain(secret)
    expect(message).not.toContain("short-secret")
    expect(message).toContain("AUTH_SECRET")
  })
})

describe("parseEnv: production", () => {
  it("accepts a complete production environment", () => {
    const env = parseEnv(production)
    expect(env.APP_ENV).toBe("production")
    expect(isProduction(env)).toBe(true)
    for (const service of FAKEABLE_SERVICES) expect(isFake(service, env)).toBe(false)
  })

  it("requires every §17 credential", () => {
    const { VOYAGE_API_KEY: _voyage, R2_BUCKET: _bucket, ...incomplete } = production
    expect(problemsOf(incomplete)).toEqual([
      "VOYAGE_API_KEY: is required in production",
      "R2_BUCKET: is required in production",
    ])
  })

  it("requires APP_NAME, which brands every page and email", () => {
    const { APP_NAME: _name, ...unbranded } = production
    expect(problemsOf(unbranded)).toEqual(["APP_NAME: is required in production"])
    // Outside production it keeps its default.
    expect(parseEnv(base).APP_NAME).toBe("Vincera")
  })

  it("forbids FAKE_SERVICES and E2E_TEST_ROUTES", () => {
    expect(problemsOf({ ...production, FAKE_SERVICES: "email", E2E_TEST_ROUTES: "1" })).toEqual([
      "FAKE_SERVICES: fake services are not allowed in production",
      "E2E_TEST_ROUTES: test routes are not allowed in production",
    ])
  })

  it("forbids Inngest dev mode, which accepts unsigned requests", () => {
    for (const value of ["1", "true", "http://localhost:8288", "0"]) {
      expect(problemsOf({ ...production, INNGEST_DEV: value })).toEqual([
        "INNGEST_DEV: Inngest dev mode is not allowed in production (it skips signatures)",
      ])
    }
    expect(problemsOf({ ...base, INNGEST_DEV: "1" })).toEqual([])
  })

  it("refuses the secrets published in .env.example and CI", () => {
    expect(
      problemsOf({
        ...production,
        AUTH_SECRET: "ci-only-auth-secret-not-used-anywhere-else",
        ENCRYPTION_KEY: "Y2ktb25seS1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcyE=",
        STRIPE_WEBHOOK_SECRET: "whsec_dev_fake_secret_change_me",
      }),
    ).toEqual([
      "AUTH_SECRET: uses a value published in this repository; generate a real secret",
      "ENCRYPTION_KEY: uses a value published in this repository; generate a real secret",
      "STRIPE_WEBHOOK_SECRET: uses a value published in this repository; generate a real secret",
    ])
    expect(
      problemsOf({ ...production, STRIPE_WEBHOOK_SECRET: "whsec_ci_only_test_secret" }),
    ).toEqual([
      "STRIPE_WEBHOOK_SECRET: uses a value published in this repository; generate a real secret",
    ])
    // Development and CI keep working with them.
    expect(
      problemsOf({ ...base, STRIPE_WEBHOOK_SECRET: "whsec_dev_fake_secret_change_me" }),
    ).toEqual([])
  })

  it("lists every secret value committed to .env.example and the CI workflow", () => {
    const root = path.resolve(import.meta.dirname, "../..")
    const files = [".env.example", ".github/workflows/ci.yml"].map((file) =>
      readFileSync(path.join(root, file), "utf8"),
    )
    for (const [key, published] of Object.entries(PUBLISHED_SECRET_VALUES)) {
      // `KEY=value` (dotenv) or `KEY: value` (YAML), ignoring empty values and comments.
      const pattern = new RegExp(`^\\s*${key}\\s*[=:][ \\t]*["']?([^"'\\s#]+)`, "gm")
      const committed = files.flatMap((text) => [...text.matchAll(pattern)].map((m) => m[1]))
      expect(committed.length, `${key} values`).toBeGreaterThan(0)
      for (const value of committed) expect(published, key).toContain(value)
    }
  })

  it("skips production-only checks during next build", () => {
    const env = parseEnv({ ...base, NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })
    expect(env.APP_ENV).toBe("production")
    expect(isFake("email", env)).toBe(true)
  })

  it("still requires core variables during next build", () => {
    expect(
      problemsOf({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }),
    ).toHaveLength(4)
  })

  it("lets e2e run a production build with APP_ENV=test", () => {
    const env = parseEnv({ ...base, NODE_ENV: "production", APP_ENV: "test", FAKE_SERVICES: "all" })
    expect(env.APP_ENV).toBe("test")
    expect(isProduction(env)).toBe(false)
    expect(isFake("stripe", env)).toBe(true)
  })
})

describe("isFake", () => {
  it("uses fakes for every service without credentials", () => {
    const env = parseEnv(base)
    for (const service of FAKEABLE_SERVICES) expect(isFake(service, env)).toBe(true)
  })

  it("goes live when a service's credentials are all present", () => {
    const env = parseEnv({
      ...base,
      RESEND_API_KEY: "re_123",
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "b",
      R2_SECRET_ACCESS_KEY: "c",
    })
    expect(isFake("email", env)).toBe(false)
    // R2_BUCKET is missing, so storage stays fake.
    expect(isFake("storage", env)).toBe(true)
  })

  it("FAKE_SERVICES=all forces every fake even with credentials", () => {
    const env = parseEnv({ ...base, RESEND_API_KEY: "re_123", FAKE_SERVICES: "all" })
    for (const service of FAKEABLE_SERVICES) expect(isFake(service, env)).toBe(true)
  })

  it("FAKE_SERVICES accepts a comma list", () => {
    const env = parseEnv({
      ...base,
      RESEND_API_KEY: "re_123",
      STRIPE_SECRET_KEY: "sk_test_123",
      FAKE_SERVICES: " Stripe , social",
    })
    expect(isFake("email", env)).toBe(false)
    expect(isFake("stripe", env)).toBe(true)
    expect(isFake("social", env)).toBe(true)
  })

  it("rejects unknown services in FAKE_SERVICES", () => {
    expect(problemsOf({ ...base, FAKE_SERVICES: "email,payments" })).toEqual([
      expect.stringMatching(/^FAKE_SERVICES: unknown service "payments"/),
    ])
  })

  it("decides social providers individually", () => {
    const env = parseEnv({
      ...base,
      GOOGLE_YT_CLIENT_ID: "yt",
      GOOGLE_YT_CLIENT_SECRET: "yt-secret",
    })
    expect(isSocialProviderFake("youtube", env)).toBe(false)
    expect(isSocialProviderFake("tiktok", env)).toBe(true)
    expect(isFake("social", env)).toBe(false)

    const forced = parseEnv({
      ...base,
      FAKE_SERVICES: "social",
      GOOGLE_YT_CLIENT_ID: "yt",
      GOOGLE_YT_CLIENT_SECRET: "s",
    })
    expect(isSocialProviderFake("youtube", forced)).toBe(true)
  })
})

describe("testRoutesEnabled", () => {
  it("requires E2E_TEST_ROUTES and a non-production APP_ENV", () => {
    expect(testRoutesEnabled(parseEnv(base))).toBe(false)
    expect(testRoutesEnabled(parseEnv({ ...base, E2E_TEST_ROUTES: "1" }))).toBe(true)
    expect(
      testRoutesEnabled(
        parseEnv({
          ...base,
          NODE_ENV: "production",
          NEXT_PHASE: "phase-production-build",
          E2E_TEST_ROUTES: "1",
        }),
      ),
    ).toBe(false)
  })
})
