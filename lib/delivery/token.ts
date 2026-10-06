import { randomBytes } from "node:crypto"

/**
 * Buyer access tokens (§5 `access_grants.token`, §12 `/access/[token]`; CLAUDE.md §19.31): 32
 * random bytes, base64url without padding, so 43 characters (the database checks the format).
 * The token is the buyer's only key: it is never logged, never put in events, and only appears in
 * the buyer's emails and the URL. Owner: the checkout builder.
 */

export const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function newAccessToken(): string {
  return randomBytes(32).toString("base64url")
}

export function isAccessToken(value: string): boolean {
  return ACCESS_TOKEN_PATTERN.test(value)
}

/** The buyer's access page path (`absoluteUrl()` it for emails). */
export function accessPath(token: string): string {
  return `/access/${token}`
}
