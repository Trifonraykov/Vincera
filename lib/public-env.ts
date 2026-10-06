import { z } from "zod"

/**
 * Client-safe environment: only `NEXT_PUBLIC_*` values, which Next.js inlines into the browser
 * bundle at build time. Each variable must be referenced as a literal `process.env.NAME` for
 * inlining to work, so they are listed one by one below.
 *
 * Server code should keep using `env` from `@/lib/env`; it re-exports this object too.
 */
const emptyToUndefined = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? undefined : value.trim()

const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.url().default("https://eu.i.posthog.com"),
  /** Mirrors the server's SENTRY_DSN (DSNs are not secret); exposed via next.config.ts `env`. */
  NEXT_PUBLIC_SENTRY_DSN: z.url().optional(),
})

export type PublicEnv = z.output<typeof publicEnvSchema>

export const publicEnv: PublicEnv = publicEnvSchema.parse({
  NEXT_PUBLIC_APP_URL: emptyToUndefined(process.env.NEXT_PUBLIC_APP_URL),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: emptyToUndefined(
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  ),
  NEXT_PUBLIC_POSTHOG_KEY: emptyToUndefined(process.env.NEXT_PUBLIC_POSTHOG_KEY),
  NEXT_PUBLIC_POSTHOG_HOST: emptyToUndefined(process.env.NEXT_PUBLIC_POSTHOG_HOST),
  NEXT_PUBLIC_SENTRY_DSN: emptyToUndefined(process.env.NEXT_PUBLIC_SENTRY_DSN),
})
