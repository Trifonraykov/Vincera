import type { CollabRole } from "@/lib/db/schema/enums"

import type { SocialProviderId } from "./types"

/**
 * Display and permission metadata per social provider (§7.1, CLAUDE.md §19.13). Client-safe.
 * Who may connect what: YouTube, Instagram and TikTok are creator audiences; GitHub is for
 * builders, and creators who also build may connect it.
 */
export const SOCIAL_PROVIDER_META = {
  youtube: {
    label: "YouTube",
    roles: ["creator"],
    supportsPkce: true,
    hasDemographics: true,
    blurb: "Subscribers, recent video views, engagement, and viewer countries, ages and genders.",
  },
  instagram: {
    label: "Instagram",
    roles: ["creator"],
    supportsPkce: false,
    hasDemographics: true,
    blurb:
      "Followers, recent post views and engagement, and follower demographics (Business or Creator accounts with 100+ followers).",
  },
  tiktok: {
    label: "TikTok",
    roles: ["creator"],
    supportsPkce: false,
    hasDemographics: false,
    blurb: "Followers, likes and recent video stats. TikTok doesn't share audience demographics.",
  },
  github: {
    label: "GitHub",
    roles: ["builder", "creator"],
    supportsPkce: true,
    hasDemographics: false,
    blurb: "Public repositories, stars, languages and contribution activity. Read-only.",
  },
} as const satisfies Record<
  SocialProviderId,
  {
    label: string
    roles: readonly CollabRole[]
    supportsPkce: boolean
    hasDemographics: boolean
    blurb: string
  }
>

export function socialProviderLabel(provider: SocialProviderId): string {
  return SOCIAL_PROVIDER_META[provider].label
}

/** Whether a user with these roles may connect `provider`. */
export function canConnectProvider(roles: readonly string[], provider: SocialProviderId): boolean {
  const allowed: readonly string[] = SOCIAL_PROVIDER_META[provider].roles
  return roles.some((role) => allowed.includes(role))
}
