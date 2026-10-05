import "server-only"

import { isSocialOAuthEnabled } from "@/lib/env"

import type { SocialProviderId } from "./types"

/**
 * Whether users can connect `provider` through OAuth right now (SOCIAL_OAUTH_DISABLED, §7.1
 * fallback; CLAUDE.md §19.14). Connect and Reconnect buttons, the OAuth routes, resync and the
 * syncs check it; a switched-off provider offers manual entry instead (creator providers).
 */
export function isSocialOAuthAvailable(provider: SocialProviderId): boolean {
  return isSocialOAuthEnabled(provider)
}
