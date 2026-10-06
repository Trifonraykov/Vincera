import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import {
  devMailboxEnabled,
  EnvValidationError,
  FAKEABLE_SERVICES,
  KEYLESS_SERVICES,
  isAdminEmail,
  isFake,
  isProduction,
  isSocialProviderFake,
  parseEnv,
  PUBLISHED_SECRET_VALUES,
  stripeWebhookSecrets,
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
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_123",
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
    expect(env.YOUTUBE_LONG_RETENTION).toBe(false)
    expect(env.STRIPE_CONNECT_WEBHOOK_SECRET).toBeUndefined()
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
      YOUTUBE_LONG_RETENTION: "true",
    })
    expect(env.PLATFORM_TAKE_RATE).toBe(0.15)
    expect(env.YOUTUBE_LONG_RETENTION).toBe(true)
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
    ["YOUTUBE_LONG_RETENTION", "sometimes"],
    ["STRIPE_CONNECT_WEBHOOK_SECRET", "not-a-signing-secret"],
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

  it("requires the Stripe Connect webhook secret (§19.10)", () => {
    const { STRIPE_CONNECT_WEBHOOK_SECRET: _connect, ...incomplete } = production
    expect(problemsOf(incomplete)).toEqual([
      "STRIPE_CONNECT_WEBHOOK_SECRET: is required in production",
    ])
    // YOUTUBE_LONG_RETENTION has a default (§17), so production does not require it.
    expect(parseEnv(production).YOUTUBE_LONG_RETENTION).toBe(false)
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

  it("forbids the dev mailbox, which shows every user's magic links", () => {
    expect(problemsOf({ ...production, DEV_MAILBOX: "1" })).toEqual([
      "DEV_MAILBOX: the dev mailbox is not allowed in production",
    ])
    expect(problemsOf({ ...production, DEV_MAILBOX: "false" })).toEqual([])
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
    const keyless: readonly string[] = KEYLESS_SERVICES
    for (const service of FAKEABLE_SERVICES) {
      expect(isFake(service, env)).toBe(!keyless.includes(service))
    }
  })

  it("runs the keyless services (App Store lookup, web imports) live unless forced", () => {
    expect(isFake("appstore", parseEnv(base))).toBe(false)
    expect(isFake("web", parseEnv(base))).toBe(false)
    const forced = parseEnv({ ...base, FAKE_SERVICES: "appstore,web" })
    expect(isFake("appstore", forced)).toBe(true)
    expect(isFake("web", forced)).toBe(true)
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

describe("stripeWebhookSecrets", () => {
  it("verifies against both endpoint secrets", () => {
    expect(stripeWebhookSecrets(parseEnv(production))).toEqual({
      platform: "whsec_test_secret",
      connect: "whsec_connect_123",
    })
  })

  it("falls back to STRIPE_WEBHOOK_SECRET for Connect events outside production", () => {
    expect(stripeWebhookSecrets(parseEnv(base))).toEqual({
      platform: "whsec_test_secret",
      connect: "whsec_test_secret",
    })
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

describe("database connection settings", () => {
  const supabase =
    "postgresql://postgres.abcdefghijklmnop:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
  const pem =
    "-----BEGIN CERTIFICATE-----\\nMIIDxTCCAq2gAwIBAgIBADANBgkqhkiG9w0BAQsFADA=\\n-----END CERTIFICATE-----"
  const fix =
    "set DATABASE_CA_CERT to the CA certificate from the Supabase dashboard (Database settings → SSL configuration → Download certificate)"

  it("defaults DATABASE_SSL to unset and the pool to 10 connections", () => {
    const env = parseEnv(base)
    expect(env.DATABASE_SSL).toBeUndefined()
    expect(env.DATABASE_CA_CERT).toBeUndefined()
    expect(env.DATABASE_POOL_MAX).toBe(10)
    expect(parseEnv({ ...base, DATABASE_POOL_MAX: "4", DATABASE_SSL: "Require" })).toMatchObject({
      DATABASE_POOL_MAX: 4,
      DATABASE_SSL: "require",
    })
  })

  it.each([
    ["DATABASE_SSL", "prefer"],
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "101"],
    ["DATABASE_POOL_MAX", "many"],
  ])("rejects %s=%s", (key, value) => {
    const problems = problemsOf({ ...base, [key]: value })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(new RegExp(`^${key}: `))
  })

  it("requires a Supabase server verified against Supabase's CA in production", () => {
    // Supabase hosts default to require: encrypted, but the server is not verified.
    expect(problemsOf({ ...production, DATABASE_URL: supabase })).toEqual([
      `DATABASE_URL: in production the Supabase server must be verified, not just encrypted: ${fix}`,
    ])
    for (const query of ["sslmode=require", "sslmode=no-verify", "sslmode=prefer"]) {
      expect(problemsOf({ ...production, DATABASE_URL: `${supabase}?${query}` })).toEqual([
        `DATABASE_URL: in production the Supabase server must be verified, not just encrypted: ${fix}`,
      ])
    }
    expect(problemsOf({ ...production, DATABASE_URL: supabase, DATABASE_SSL: "disable" })).toEqual([
      `DATABASE_URL: Supabase connections must use TLS: ${fix}`,
    ])
    // With the CA the server is always verified, whatever the URL asked for.
    expect(problemsOf({ ...production, DATABASE_URL: supabase, DATABASE_CA_CERT: pem })).toEqual([])
    expect(
      problemsOf({
        ...production,
        DATABASE_URL: `${supabase}?sslmode=require`,
        DATABASE_SSL: "require",
        DATABASE_CA_CERT: pem,
      }),
    ).toEqual([])
    // A root certificate file in the URL is a CA of our own too.
    const dir = mkdtempSync(path.join(tmpdir(), "env-ca-"))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const rootCert = path.join(dir, "supabase.crt")
    writeFileSync(rootCert, pem.replaceAll("\\n", "\n"))
    expect(
      problemsOf({
        ...production,
        DATABASE_URL: `${supabase}?sslmode=verify-full&sslrootcert=${rootCert}`,
      }),
    ).toEqual([])
    // DATABASE_CA_CERT may also name the file.
    expect(
      problemsOf({ ...production, DATABASE_URL: supabase, DATABASE_CA_CERT: rootCert }),
    ).toEqual([])
    // Outside production an unverified (or plain) connection is allowed (e.g. a quick local test).
    expect(problemsOf({ ...base, DATABASE_URL: supabase })).toEqual([])
    expect(problemsOf({ ...base, DATABASE_URL: `${supabase}?sslmode=disable` })).toEqual([])
  })

  it("requires any other database off this machine to be encrypted and verified in production", () => {
    const neon = "postgresql://u:pw@ep-cool-123.us-east-2.aws.neon.tech/neondb"
    // Neon's default string: node-postgres (and we) verify the server on sslmode=require.
    expect(
      problemsOf({
        ...production,
        DATABASE_URL: `${neon}?sslmode=require&channel_binding=require`,
      }),
    ).toEqual([])
    expect(problemsOf({ ...production, DATABASE_URL: neon })).toEqual([
      expect.stringMatching(
        /^DATABASE_URL: in production a database that is not on this machine must use TLS: add sslmode=verify-full/,
      ),
    ])
    expect(problemsOf({ ...production, DATABASE_URL: neon, DATABASE_SSL: "disable" })).toEqual([
      expect.stringMatching(/^DATABASE_URL: .*must use TLS/),
    ])
    expect(problemsOf({ ...production, DATABASE_URL: `${neon}?sslmode=no-verify` })).toEqual([
      expect.stringMatching(
        /^DATABASE_URL: in production the database server must be verified, not just encrypted: .*DATABASE_SSL=require/,
      ),
    ])
    // An unverified server accepted on purpose.
    expect(
      problemsOf({
        ...production,
        DATABASE_URL: `${neon}?sslmode=no-verify`,
        DATABASE_SSL: "require",
      }),
    ).toEqual([])
    // On this machine, and outside production, plain text is fine.
    expect(
      problemsOf({ ...production, DATABASE_URL: "postgres://u:pw@127.0.0.1:5432/app" }),
    ).toEqual([])
    expect(problemsOf({ ...base, DATABASE_URL: neon })).toEqual([])
    expect(problemsOf({ ...production, DATABASE_URL: neon }).join("\n")).not.toContain(":pw@")
  })

  it("refuses unknown TLS values in DATABASE_URL in every environment", () => {
    for (const query of ["ssl=require", "sslmode=strict", "sslnegotiation=fast"]) {
      expect(
        problemsOf({ ...base, DATABASE_URL: `postgres://u:pw@db.example.com/app?${query}` }),
      ).toEqual([expect.stringMatching(/^DATABASE_URL: has an unknown /)])
    }
  })

  it("checks DATABASE_SSL and DATABASE_CA_CERT together in every environment", () => {
    expect(problemsOf({ ...base, DATABASE_SSL: "disable", DATABASE_CA_CERT: pem })).toEqual([
      "DATABASE_SSL: DATABASE_SSL=disable turns TLS off, but DATABASE_CA_CERT is set: remove one of them",
    ])
    expect(problemsOf({ ...base, DATABASE_URL: supabase, DATABASE_SSL: "verify-full" })).toEqual([
      expect.stringMatching(/^DATABASE_CA_CERT: verifying a Supabase server needs its CA/),
    ])
  })

  it("checks that DATABASE_CA_CERT is a PEM certificate or a readable PEM file", () => {
    expect(problemsOf({ ...base, DATABASE_CA_CERT: "abc" })).toEqual([
      'DATABASE_CA_CERT: must be a PEM certificate or the path of a file holding one; cannot read the file "abc"',
    ])
    expect(problemsOf({ ...base, DATABASE_CA_CERT: "-----BEGIN CERTIFICATE----- x" })).toEqual([
      "DATABASE_CA_CERT: does not contain a PEM certificate",
    ])
  })

  it("never echoes the database password", () => {
    const problems = problemsOf({ ...production, DATABASE_URL: supabase }).join("\n")
    expect(problems).not.toContain(":pw@")
  })
})

describe("devMailboxEnabled", () => {
  it("is opt-in, needs the fake email service and never runs in production", () => {
    expect(devMailboxEnabled(parseEnv(base))).toBe(false)
    expect(devMailboxEnabled(parseEnv({ ...base, DEV_MAILBOX: "1" }))).toBe(true)
    expect(
      devMailboxEnabled(parseEnv({ ...base, DEV_MAILBOX: "1", RESEND_API_KEY: "re_123" })),
    ).toBe(false)
    expect(
      devMailboxEnabled(
        parseEnv({
          ...base,
          NODE_ENV: "production",
          NEXT_PHASE: "phase-production-build",
          DEV_MAILBOX: "1",
        }),
      ),
    ).toBe(false)
  })
})

describe("matching v1 flags (CLAUDE.md §19.38)", () => {
  it("accepts v0 or a dated v1 version, and refuses anything else", () => {
    expect(
      parseEnv({ ...base, MATCHING_MODEL_VERSION: "v1-2026-11-02" }).MATCHING_MODEL_VERSION,
    ).toBe("v1-2026-11-02")
    expect(parseEnv({ ...base, MATCHING_MODEL_VERSION: "" }).MATCHING_MODEL_VERSION).toBeUndefined()
    expect(problemsOf({ ...base, MATCHING_MODEL_VERSION: "latest" })).toEqual([
      expect.stringMatching(/^MATCHING_MODEL_VERSION: /),
    ])
  })

  it("allows forcing v1 outside production only", () => {
    expect(parseEnv({ ...base, MATCHING_V1_FORCE: "true" }).MATCHING_V1_FORCE).toBe(true)
    expect(problemsOf({ ...production, MATCHING_V1_FORCE: "true" })).toContainEqual(
      expect.stringMatching(/^MATCHING_V1_FORCE: /),
    )
  })
})
