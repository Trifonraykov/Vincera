import "server-only"

import { ActionError } from "@/lib/actions/errors"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"

/** Per-user limits on listing imports (CLAUDE.md §19.45), shared by the web and the mobile API. */
export const LISTING_RATE_LIMITS = {
  "app-store-connect": { limit: 10, window: "1 h" },
  "app-store-refresh": { limit: 6, window: "1 h" },
  "app-store-verify": { limit: 20, window: "1 h" },
  "web-listing-import": { limit: 15, window: "1 h" },
} as const satisfies Record<string, RateLimitRule>

export const LISTING_LIMITED_MESSAGE =
  "You've done that a lot just now. Try again in a little while."

/** Throws an ActionError with a plain message once the user is over the bucket's limit. */
export async function limitListingImport(
  bucket: keyof typeof LISTING_RATE_LIMITS,
  userId: string,
): Promise<void> {
  const result = await rateLimit(bucket, userId, LISTING_RATE_LIMITS[bucket])
  if (!result.success) throw new ActionError(LISTING_LIMITED_MESSAGE)
}
