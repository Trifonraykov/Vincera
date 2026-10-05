import * as Sentry from "@sentry/nextjs"

import { redactDbError } from "@/lib/db/errors"

/**
 * Report an unexpected error without interrupting the caller (§4: details go to Sentry, users see
 * plain language). A no-op apart from the console when SENTRY_DSN is unset.
 *
 * Database errors are redacted first (`redactDbError`): a failed query's parameters and Postgres's
 * row details never reach Sentry or the logs (§11, §14).
 *
 * `context` values must never contain tokens, emails or message bodies (§11, §14).
 */
export function reportError(
  error: unknown,
  context: { tags?: Record<string, string>; extra?: Record<string, unknown> } = {},
): void {
  const safe = redactDbError(error)
  Sentry.captureException(safe, { tags: context.tags, extra: context.extra })
  if (process.env.NODE_ENV !== "test") {
    const where = context.tags
      ? ` [${Object.entries(context.tags)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}]`
      : ""
    console.error(`[error]${where}`, safe)
  }
}
