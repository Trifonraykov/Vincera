import "server-only"

import { z } from "zod"

export { publicEnv, type PublicEnv } from "@/lib/public-env"

/**
 * Server environment (§17, §19.3).
 *
 * - Every variable is parsed and validated with Zod, once, on first access (`env.X` or `getEnv()`),
 *   and again eagerly at server start from `instrumentation.ts`.
 * - Outside production, external credentials are optional: a service whose credentials are
 *   missing runs its fake implementation. `FAKE_SERVICES=all` (or a comma list) forces fakes.
 * - In production every §17 variable is required, and fakes, test routes, Inngest dev mode and
 *   the example secrets committed to this repository are forbidden.
 *
 * "Production" means `APP_ENV=production`. `APP_ENV` defaults from `NODE_ENV`, so a normal
 * deployment needs nothing extra. It exists because `next build && next start` always runs with
 * `NODE_ENV=production`, including in e2e/CI, which set `APP_ENV=test` to keep fakes allowed.
 * During `next build` (NEXT_PHASE=phase-production-build) the production-only checks are skipped;
 * they run when the server starts.
 */

export const APP_ENVS = ["development", "test", "production"] as const
export type AppEnv = (typeof APP_ENVS)[number]

export const FAKEABLE_SERVICES = [
  "email",
  "storage",
  "stripe",
  "social",
  "ai",
  "embeddings",
  "jobs",
  "ratelimit",
] as const
export type FakeableService = (typeof FAKEABLE_SERVICES)[number]

export const SOCIAL_PROVIDERS = ["youtube", "instagram", "tiktok", "github"] as const
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number]

/** Used when ANTHROPIC_MODEL is unset outside production. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5"

const BUILD_PHASE = "phase-production-build"

function isFakeableService(value: string): value is FakeableService {
  return (FAKEABLE_SERVICES as readonly string[]).includes(value)
}

function isBase64Key32(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32
}

const nonEmpty = z.string().min(1)
const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgres:// connection string")
const flag = z.stringbool().default(false)

const fakeServices = z
  .string()
  .default("")
  .transform((value, ctx): ReadonlySet<FakeableService> => {
    const services = new Set<FakeableService>()
    for (const token of value.split(",").map((t) => t.trim().toLowerCase())) {
      if (token === "") continue
      if (token === "all") FAKEABLE_SERVICES.forEach((s) => services.add(s))
      else if (isFakeableService(token)) services.add(token)
      else
        ctx.addIssue({
          code: "custom",
          message: `unknown service "${token}"; expected "all" or a comma list of: ${FAKEABLE_SERVICES.join(", ")}`,
        })
    }
    return services
  })

const emailList = z
  .string()
  .default("")
  .transform((value, ctx): readonly string[] => {
    const emails = value
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
    for (const email of emails) {
      if (!z.email().safeParse(email).success) {
        ctx.addIssue({ code: "custom", message: "must be a comma-separated list of emails" })
      }
    }
    return emails
  })

const envSchema = z.object({
  NODE_ENV: z.enum(APP_ENVS).default("development"),
  APP_ENV: z.enum(APP_ENVS).optional(),
  NEXT_PHASE: z.string().optional(),

  // Core: required in every environment.
  DATABASE_URL: postgresUrl,
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters (generate: npx auth secret)"),
  ENCRYPTION_KEY: z
    .string()
    .refine(isBase64Key32, "must be 32 random bytes, base64-encoded (openssl rand -base64 32)"),
  // Fake Stripe signs its webhooks with this secret too, so it is always needed.
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_", "must start with whsec_"),

  // App
  APP_NAME: nonEmpty.default("Vincera"),
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
  AUTH_URL: z.url().optional(),
  ADMIN_EMAILS: emailList,

  // Login providers (Auth.js)
  AUTH_GOOGLE_ID: nonEmpty.optional(),
  AUTH_GOOGLE_SECRET: nonEmpty.optional(),
  AUTH_GITHUB_ID: nonEmpty.optional(),
  AUTH_GITHUB_SECRET: nonEmpty.optional(),

  // Email (Resend)
  RESEND_API_KEY: nonEmpty.optional(),
  EMAIL_FROM: nonEmpty.optional(),

  // Stripe
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^(sk|rk)_(test|live)_/, "must be a Stripe secret (sk_) or restricted (rk_) key")
    .optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z
    .string()
    .startsWith("pk_", "must start with pk_")
    .optional(),

  // Social data connections (§7.1)
  GOOGLE_YT_CLIENT_ID: nonEmpty.optional(),
  GOOGLE_YT_CLIENT_SECRET: nonEmpty.optional(),
  META_APP_ID: nonEmpty.optional(),
  META_APP_SECRET: nonEmpty.optional(),
  TIKTOK_CLIENT_KEY: nonEmpty.optional(),
  TIKTOK_CLIENT_SECRET: nonEmpty.optional(),
  GITHUB_DATA_CLIENT_ID: nonEmpty.optional(),
  GITHUB_DATA_CLIENT_SECRET: nonEmpty.optional(),

  // AI
  ANTHROPIC_API_KEY: nonEmpty.optional(),
  ANTHROPIC_MODEL: nonEmpty.default(DEFAULT_ANTHROPIC_MODEL),
  EMBEDDINGS_PROVIDER: z.enum(["voyage"]).default("voyage"),
  VOYAGE_API_KEY: nonEmpty.optional(),
  // Must produce 1024-dim vectors (output_dimension=1024), matching the vector(1024) columns.
  VOYAGE_MODEL: nonEmpty.default("voyage-3.5"),

  // Storage (Cloudflare R2)
  R2_ACCOUNT_ID: nonEmpty.optional(),
  R2_ACCESS_KEY_ID: nonEmpty.optional(),
  R2_SECRET_ACCESS_KEY: nonEmpty.optional(),
  R2_BUCKET: nonEmpty.optional(),

  // Jobs (Inngest)
  INNGEST_EVENT_KEY: nonEmpty.optional(),
  INNGEST_SIGNING_KEY: nonEmpty.optional(),
  // Read by the Inngest SDK itself (local dev server). Only validated here: never in production.
  INNGEST_DEV: z.string().optional(),

  // Rate limiting (Upstash)
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: nonEmpty.optional(),

  // Observability
  SENTRY_DSN: z.url().optional(),
  SENTRY_AUTH_TOKEN: nonEmpty.optional(),
  NEXT_PUBLIC_POSTHOG_KEY: nonEmpty.optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.url().default("https://eu.i.posthog.com"),

  // Business rules (§9, §12)
  PLATFORM_TAKE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  HOLD_DAYS: z.coerce.number().int().min(0).default(14),
  MIN_PAYOUT_CENTS: z.coerce.number().int().min(0).default(1000),
  AUTO_APPROVE_LAUNCHES: flag,

  // Development & tests (§19.3, §19.4)
  FAKE_SERVICES: fakeServices,
  E2E_TEST_ROUTES: flag,
  TEST_DATABASE_URL: postgresUrl.optional(),
  E2E_DATABASE_URL: postgresUrl.optional(),
})

type EnvKey = keyof typeof envSchema.shape
type ParsedEnv = z.output<typeof envSchema>

export type Env = Omit<ParsedEnv, "APP_ENV" | "EMAIL_FROM"> & {
  APP_ENV: AppEnv
  EMAIL_FROM: string
}

const CORE_REQUIRED = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "ENCRYPTION_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const satisfies readonly EnvKey[]

/** §17 variables without a default, plus Upstash (fakes are forbidden in production). */
const PRODUCTION_REQUIRED = [
  ...CORE_REQUIRED,
  "AUTH_URL",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "GOOGLE_YT_CLIENT_ID",
  "GOOGLE_YT_CLIENT_SECRET",
  "META_APP_ID",
  "META_APP_SECRET",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "GITHUB_DATA_CLIENT_ID",
  "GITHUB_DATA_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "EMBEDDINGS_PROVIDER",
  "VOYAGE_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "SENTRY_DSN",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "APP_NAME",
  "NEXT_PUBLIC_APP_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const satisfies readonly EnvKey[]

/**
 * Secret values committed to this repository (`.env.example`, `.github/workflows/ci.yml`).
 * Anyone can read them, so production refuses them (tests/unit/env.test.ts keeps this list in
 * sync with those files).
 */
export const PUBLISHED_SECRET_VALUES = {
  AUTH_SECRET: ["ci-only-auth-secret-not-used-anywhere-else"],
  ENCRYPTION_KEY: ["Y2ktb25seS1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcyE="],
  STRIPE_WEBHOOK_SECRET: ["whsec_dev_fake_secret_change_me", "whsec_ci_only_test_secret"],
} as const satisfies Partial<Record<EnvKey, readonly string[]>>

/** A service runs live only when all of its credentials are present. */
const SERVICE_CREDENTIALS = {
  email: ["RESEND_API_KEY"],
  storage: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
  stripe: ["STRIPE_SECRET_KEY"],
  ai: ["ANTHROPIC_API_KEY"],
  embeddings: ["VOYAGE_API_KEY"],
  jobs: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
  ratelimit: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
} as const satisfies Record<Exclude<FakeableService, "social">, readonly EnvKey[]>

const SOCIAL_CREDENTIALS = {
  youtube: ["GOOGLE_YT_CLIENT_ID", "GOOGLE_YT_CLIENT_SECRET"],
  instagram: ["META_APP_ID", "META_APP_SECRET"],
  tiktok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  github: ["GITHUB_DATA_CLIENT_ID", "GITHUB_DATA_CLIENT_SECRET"],
} as const satisfies Record<SocialProvider, readonly EnvKey[]>

export class EnvValidationError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    // Messages name variables only; values (secrets) are never included.
    super(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        "See .env.example and CLAUDE.md §17 / §19.3.",
    )
    this.name = "EnvValidationError"
    this.problems = problems
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>

/** Pick the schema's keys from `source`, trimming values and treating "" as unset. */
function normalize(source: EnvSource): Partial<Record<EnvKey, string>> {
  const input: Partial<Record<EnvKey, string>> = {}
  for (const key of Object.keys(envSchema.shape) as EnvKey[]) {
    const value = source[key]?.trim()
    if (value) input[key] = value
  }
  return input
}

function resolveAppEnv(input: Partial<Record<EnvKey, string>>): AppEnv {
  const explicit = APP_ENVS.find((value) => value === input.APP_ENV)
  if (explicit) return explicit
  if (input.NODE_ENV === "production") return "production"
  if (input.NODE_ENV === "test") return "test"
  return "development"
}

/**
 * Parse and validate an environment. Pure: pass any record (tests do); defaults to `process.env`.
 * Throws `EnvValidationError` listing every problem at once.
 */
export function parseEnv(source: EnvSource = process.env): Env {
  const input = normalize(source)
  const appEnv = resolveAppEnv(input)
  const strict = appEnv === "production" && input.NEXT_PHASE !== BUILD_PHASE

  // First message per variable wins, so a missing value is not also reported as malformed.
  const problems = new Map<string, string>()
  const report = (key: string, message: string) => {
    if (!problems.has(key)) problems.set(key, `${key}: ${message}`)
  }

  const required: readonly EnvKey[] = strict ? PRODUCTION_REQUIRED : CORE_REQUIRED
  for (const key of required) {
    if (input[key] === undefined) report(key, strict ? "is required in production" : "is required")
  }
  if (strict && input.FAKE_SERVICES !== undefined) {
    report("FAKE_SERVICES", "fake services are not allowed in production")
  }
  if (strict && input.INNGEST_DEV !== undefined) {
    // Inngest's dev mode accepts unsigned requests on /api/inngest.
    report("INNGEST_DEV", "Inngest dev mode is not allowed in production (it skips signatures)")
  }
  if (strict) {
    for (const [key, values] of Object.entries(PUBLISHED_SECRET_VALUES)) {
      const value = input[key as keyof typeof PUBLISHED_SECRET_VALUES]
      if (value !== undefined && (values as readonly string[]).includes(value)) {
        report(key, "uses a value published in this repository; generate a real secret")
      }
    }
  }

  const result = envSchema.safeParse(input)
  if (!result.success) {
    for (const issue of result.error.issues) {
      report(issue.path.map(String).join(".") || "(env)", issue.message)
    }
  } else {
    const data = result.data
    if (strict && data.E2E_TEST_ROUTES) {
      report("E2E_TEST_ROUTES", "test routes are not allowed in production")
    }
    if (
      appEnv !== "production" &&
      data.STRIPE_SECRET_KEY &&
      /_live_/.test(data.STRIPE_SECRET_KEY)
    ) {
      report("STRIPE_SECRET_KEY", "live keys are only allowed in production; use test mode (§7.2)")
    }
  }

  if (problems.size > 0 || !result.success) {
    throw new EnvValidationError([...problems.values()])
  }

  const data = result.data
  return {
    ...data,
    APP_ENV: appEnv,
    // Resend's shared test sender works for local development without a verified domain.
    EMAIL_FROM: data.EMAIL_FROM ?? `${data.APP_NAME} <onboarding@resend.dev>`,
  }
}

let cachedEnv: Env | undefined

/** The process environment, parsed once on first use. */
export function getEnv(): Env {
  cachedEnv ??= parseEnv(process.env)
  return cachedEnv
}

/** Forget the parsed environment so the next access re-reads `process.env`. Tests only. */
export function resetEnvCache(): void {
  cachedEnv = undefined
}

/**
 * Lazily parsed environment: `env.DATABASE_URL` parses `process.env` on first property access.
 * The proxy target is a placeholder; every trap forwards to the parsed object.
 */
export const env: Env = new Proxy({} as Env, {
  get: (_target, key) => Reflect.get(getEnv(), key),
  has: (_target, key) => Reflect.has(getEnv(), key),
  ownKeys: () => Reflect.ownKeys(getEnv()),
  getOwnPropertyDescriptor: (_target, key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(getEnv(), key)
    return descriptor && { ...descriptor, configurable: true }
  },
})

/** True for real deployments, where every credential is required and fakes are forbidden. */
export function isProduction(e: Env = getEnv()): boolean {
  return e.APP_ENV === "production"
}

function isStrict(e: Env): boolean {
  return e.APP_ENV === "production" && e.NEXT_PHASE !== BUILD_PHASE
}

function hasAll(e: Env, keys: readonly EnvKey[]): boolean {
  return keys.every((key) => Boolean(e[key]))
}

/** Whether a social provider uses its fake: social fakes are forced or its credentials are missing. */
export function isSocialProviderFake(provider: SocialProvider, e: Env = getEnv()): boolean {
  const fake = e.FAKE_SERVICES.has("social") || !hasAll(e, SOCIAL_CREDENTIALS[provider])
  if (fake && isStrict(e)) {
    throw new EnvValidationError([`social/${provider}: fake implementation used in production`])
  }
  return fake
}

/**
 * Whether `service` should use its fake implementation (§19.3):
 * forced by `FAKE_SERVICES` (`all` or a list naming it), otherwise fake iff its credentials are
 * missing. In production a fake is a configuration error and this throws.
 *
 * For `social`, this is true when fakes are forced or no provider is configured at all; use
 * `isSocialProviderFake(provider)` to decide per provider.
 */
export function isFake(service: FakeableService, e: Env = getEnv()): boolean {
  const forced = e.FAKE_SERVICES.has(service)
  const configured =
    service === "social"
      ? SOCIAL_PROVIDERS.some((provider) => hasAll(e, SOCIAL_CREDENTIALS[provider]))
      : hasAll(e, SERVICE_CREDENTIALS[service])
  const fake = forced || !configured
  if (fake && isStrict(e)) {
    throw new EnvValidationError([`${service}: fake implementation used in production`])
  }
  return fake
}

/** `/api/test/*` routes exist only when explicitly enabled and never in production (§19.4). */
export function testRoutesEnabled(e: Env = getEnv()): boolean {
  return e.E2E_TEST_ROUTES && e.APP_ENV !== "production"
}

/** Emails listed in ADMIN_EMAILS get the admin role when they sign up. */
export function isAdminEmail(email: string, e: Env = getEnv()): boolean {
  return e.ADMIN_EMAILS.includes(email.trim().toLowerCase())
}

/**
 * Validate the environment when the server starts (called from `instrumentation.ts`).
 * Skipped during `next build`. On failure the problems are logged once; a production server
 * (`next start`, NODE_ENV=production) then exits instead of serving errors, while `next dev`
 * rethrows so the error shows and the dev server stays up for a fix.
 */
export function validateEnvAtBoot(log: (message: string) => void = console.info): void {
  if (process.env.NEXT_PHASE === BUILD_PHASE) return
  let e: Env
  try {
    e = getEnv()
  } catch (error) {
    if (error instanceof EnvValidationError && process.env.NODE_ENV === "production") {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
  const fakes = FAKEABLE_SERVICES.filter((service) => isFake(service, e))
  log(
    `[env] APP_ENV=${e.APP_ENV}; ` +
      (fakes.length > 0 ? `fake services: ${fakes.join(", ")}` : "all services live"),
  )
}
