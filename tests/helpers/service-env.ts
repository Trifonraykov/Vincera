import { vi } from "vitest"

import { resetEnvCache } from "@/lib/env"

/**
 * Stub a minimal, valid non-production environment for unit tests of the service adapters.
 * Every external credential is blanked (so services are fake unless a test passes credentials),
 * and lib/env's cache is reset so the stubs take effect. Vitest's `unstubEnvs` restores the real
 * environment after each test.
 */

const CREDENTIALS = [
  "RESEND_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "STRIPE_SECRET_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "VOYAGE_API_KEY",
  "VOYAGE_MODEL",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SENTRY_DSN",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "APP_ENV",
  "E2E_TEST_ROUTES",
] as const

export const TEST_AUTH_SECRET = "test-auth-secret-0123456789abcdefghijklmnop"
export const TEST_APP_URL = "http://localhost:3000"

export function stubServiceEnv(overrides: Record<string, string> = {}): void {
  for (const key of CREDENTIALS) vi.stubEnv(key, "")
  const base: Record<string, string> = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/creator_test",
    AUTH_SECRET: TEST_AUTH_SECRET,
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    STRIPE_WEBHOOK_SECRET: "whsec_unit_test",
    NEXT_PUBLIC_APP_URL: TEST_APP_URL,
    APP_NAME: "Vincera",
    EMAIL_FROM: "Vincera <hello@example.com>",
    FAKE_SERVICES: "",
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) vi.stubEnv(key, value)
  resetEnvCache()
}
