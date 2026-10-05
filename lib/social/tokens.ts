import { DAY_MS } from "./metrics"
import type { SocialProviderId, TokenSet } from "./types"

/**
 * When the sync should call `provider.refresh(token)` before reading data (§7.1). Pure and
 * client-safe; `syncConnection` uses it so every caller refreshes by the same rule.
 *
 * - Google (YouTube) and TikTok access tokens are short-lived (1h / 24h): refresh when they
 *   expire within 5 minutes (or already have). TikTok's refresh rotates the refresh token.
 * - Instagram long-lived tokens last 60 days and can be refreshed once they are 24h old: refresh
 *   on every sync after that, which keeps a daily-synced token alive indefinitely. An expired one
 *   is "refreshed" too, so `refresh()` reports it (SocialTokenError).
 * - GitHub OAuth App tokens do not expire: never, unless expiring tokens were enabled.
 */

export const REFRESH_MARGIN_MS = 5 * 60 * 1000
const INSTAGRAM_REFRESH_AGE_MS = DAY_MS
const INSTAGRAM_LIFETIME_MS = 60 * DAY_MS

export function tokenNeedsRefresh(
  provider: SocialProviderId,
  token: Pick<TokenSet, "expiresAt" | "obtainedAt">,
  at: Date,
): boolean {
  if (!token.expiresAt) return false
  const remaining = token.expiresAt.getTime() - at.getTime()
  if (remaining <= REFRESH_MARGIN_MS) return true
  if (provider !== "instagram") return false
  const obtainedAt =
    token.obtainedAt?.getTime() ?? token.expiresAt.getTime() - INSTAGRAM_LIFETIME_MS
  return at.getTime() - obtainedAt >= INSTAGRAM_REFRESH_AGE_MS
}
