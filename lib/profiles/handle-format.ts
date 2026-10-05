/**
 * Handle format (§4): lowercase, 3–30 of `[a-z0-9_]`. No imports, so client code (profile forms),
 * the database schema's CHECK constraints (lib/db/schema/columns.ts re-exports these) and server
 * code share one definition.
 */
export const HANDLE_PATTERN = "^[a-z0-9_]{3,30}$"
export const HANDLE_REGEX = new RegExp(HANDLE_PATTERN)
export const HANDLE_MIN_LENGTH = 3
export const HANDLE_MAX_LENGTH = 30
