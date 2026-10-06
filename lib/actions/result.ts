/**
 * What every server action returns (§4), shared by server and client code (no server imports).
 * Expected failures come back as `{ ok: false }` with a plain-language message; forms show
 * `fieldErrors` next to their inputs.
 */

export type FieldErrors = Partial<Record<string, string[]>>

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; error: string; fieldErrors?: FieldErrors }

export const ACTION_MESSAGES = {
  invalidInput: "Please check the highlighted fields and try again.",
  forbidden: "You don't have permission to do that.",
  unexpected: "Something went wrong on our side. Please try again.",
} as const
