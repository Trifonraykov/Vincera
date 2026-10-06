import { DrizzleQueryError } from "drizzle-orm"
import { z } from "zod"

/** SQLSTATE codes the app reacts to. */
export const PG_ERROR = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
  /** e.g. a value that is not one of an enum's labels. */
  invalidTextRepresentation: "22P02",
  /** Raised by the append-only triggers (drizzle/0002_append_only_guards.sql). */
  appendOnlyViolation: "AO001",
} as const
export type PgErrorCode = (typeof PG_ERROR)[keyof typeof PG_ERROR]

const pgErrorShape = z.object({
  code: z.string().regex(/^[0-9A-Z]{5}$/),
  message: z.string(),
  constraint: z.string().optional(),
  table: z.string().optional(),
})
export type PgErrorInfo = z.infer<typeof pgErrorShape>

/**
 * The Postgres error behind `error`, if any. Drizzle wraps driver errors in DrizzleQueryError
 * (`cause`), so this walks the cause chain.
 */
export function getPgError(error: unknown): PgErrorInfo | null {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const parsed = pgErrorShape.safeParse(current)
    if (parsed.success) return parsed.data
    current = current.cause
  }
  return null
}

/** True when `error` is a Postgres error with `code` (and, if given, on `constraint`). */
export function isPgError(error: unknown, code: PgErrorCode, constraint?: string): boolean {
  const pg = getPgError(error)
  return (
    pg !== null && pg.code === code && (constraint === undefined || pg.constraint === constraint)
  )
}

/**
 * Drizzle's `DrizzleQueryError` message is "Failed query: <sql>\nparams: <values>", and the values
 * can be emails, names, message bodies or encrypted tokens. Postgres errors carry row values in
 * `detail` (and some messages quote the offending input). None of that may reach Sentry or the
 * logs (§11, §14), so `reportError` passes errors through this first.
 */
const QUERY_PARAMS = /(Failed query: [\s\S]*?\nparams: )[\s\S]*$/
/** `invalid input syntax for type uuid: "…"`, `invalid input value for enum x: "…"`. */
const QUOTED_INPUT = /(: )"[\s\S]*"$/

/** `text` with the params of a failed-query message replaced by `[redacted]`. */
export function redactQueryParams(text: string): string {
  return text.replace(QUERY_PARAMS, "$1[redacted]")
}

/** A copy of `error` that keeps what helps debugging (SQL text, SQLSTATE, constraint, table). */
export function redactDbError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > 4) return error
  const pg = pgErrorShape.safeParse(error)
  const isQueryError = error instanceof DrizzleQueryError || QUERY_PARAMS.test(error.message)
  if (!isQueryError && !pg.success) {
    if (error.cause === undefined) return error
    const cause = redactDbError(error.cause, depth + 1)
    if (cause === error.cause) return error
    return copyError(error, error.message, cause)
  }
  const message = pg.success
    ? pg.data.message.replace(QUOTED_INPUT, "$1[redacted]")
    : redactQueryParams(error.message)
  const copy = copyError(error, message, redactDbError(error.cause, depth + 1))
  if (pg.success) {
    Object.assign(copy, {
      code: pg.data.code,
      ...(pg.data.constraint ? { constraint: pg.data.constraint } : {}),
      ...(pg.data.table ? { table: pg.data.table } : {}),
    })
  }
  return copy
}

function copyError(error: Error, message: string, cause: unknown): Error {
  const copy = new Error(message, cause === undefined ? undefined : { cause })
  copy.name = error.name
  // The stack starts with "<name>: <message>"; keep only the frames.
  const frames = error.stack?.split("\n").filter((line) => /^\s+at /.test(line)) ?? []
  copy.stack = [`${copy.name}: ${message}`, ...frames].join("\n")
  return copy
}
