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
