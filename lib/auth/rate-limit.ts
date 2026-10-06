import "server-only"

import { clientIp, rateLimit } from "@/lib/ratelimit"

import { normalizeEmail } from "./email"

/**
 * The §14 `auth` rate limit (10 per 10 minutes, lib/ratelimit.ts): one budget per client IP for
 * every sign-in attempt, plus one per email address for magic links. Every key is counted, so a
 * blocked request still uses up the other keys' budgets.
 */
export async function isAuthRateLimited(
  requestHeaders: Headers,
  email?: string | null,
): Promise<boolean> {
  const keys = [`ip:${clientIp(requestHeaders)}`]
  if (email) keys.push(`email:${normalizeEmail(email)}`)
  const results = await Promise.all(keys.map((key) => rateLimit("auth", key)))
  return results.some((result) => !result.success)
}
