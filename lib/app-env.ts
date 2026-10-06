/**
 * What "production" means (CLAUDE.md §19.3), shared by `lib/env.ts` and the code that cannot
 * import it: the scripts, drizzle.config.ts and the database connection resolver. Pure; reads no
 * environment itself.
 *
 * `APP_ENV` wins; unset, it follows `NODE_ENV`. `next build && next start` always runs with
 * `NODE_ENV=production`, so e2e and CI set `APP_ENV=test` to keep fakes allowed. During
 * `next build` (`NEXT_PHASE=phase-production-build`) the production-only checks are skipped.
 */

export const APP_ENVS = ["development", "test", "production"] as const
export type AppEnv = (typeof APP_ENVS)[number]

export const BUILD_PHASE = "phase-production-build"

type EnvRecord = Readonly<Record<string, string | undefined>>

export function resolveAppEnv(source: EnvRecord): AppEnv {
  const appEnv = source.APP_ENV?.trim()
  const explicit = APP_ENVS.find((value) => value === appEnv)
  if (explicit) return explicit
  const nodeEnv = source.NODE_ENV?.trim()
  if (nodeEnv === "production") return "production"
  if (nodeEnv === "test") return "test"
  return "development"
}

/** Whether production's strict checks apply: APP_ENV is production and this is not `next build`. */
export function isStrictProductionEnv(source: EnvRecord): boolean {
  return resolveAppEnv(source) === "production" && source.NEXT_PHASE?.trim() !== BUILD_PHASE
}
