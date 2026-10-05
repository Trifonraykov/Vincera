import type { SizeTier } from "@/lib/db/schema/enums"

/**
 * Creator size tiers (§5): nano < 10k, micro 10k–100k, mid 100k–500k, macro > 500k followers.
 * Pure and client-safe. The boundaries are half-open from below: exactly 10,000 is micro, exactly
 * 100,000 is mid, exactly 500,000 is still mid (macro is "> 500k").
 *
 * Which followers count (CLAUDE.md §19.14): the largest single platform, not the sum (audiences
 * overlap across platforms). Verified connections (`status = active` and `verified_at` set,
 * §19.11) are preferred; when there are none, self-reported manual entries (and connections whose
 * token expired) are used and the tier is shown as unverified.
 */

export const SIZE_TIER_LABELS = {
  nano: "Nano",
  micro: "Micro",
  mid: "Mid-size",
  macro: "Macro",
} as const satisfies Record<SizeTier, string>

export const SIZE_TIER_RANGES = {
  nano: "under 10K followers",
  micro: "10K–100K followers",
  mid: "100K–500K followers",
  macro: "over 500K followers",
} as const satisfies Record<SizeTier, string>

export function sizeTierFor(followers: number | null | undefined): SizeTier | null {
  if (followers === null || followers === undefined || !Number.isFinite(followers)) return null
  if (followers < 10_000) return "nano"
  if (followers < 100_000) return "micro"
  if (followers <= 500_000) return "mid"
  return "macro"
}

/** One creator connection as the tier needs it: its state and its latest snapshot's followers. */
export type TierSource = {
  status: "active" | "expired" | "revoked"
  /** `verified_at` is set (OAuth, or a manual entry an admin checked). */
  verified: boolean
  followers: number | null
}

export type SizeTierResult = {
  tier: SizeTier | null
  /** True when the tier comes from a verified connection. */
  verified: boolean
  /** The follower count the tier was computed from. */
  followers: number | null
}

/** A verified connection (§19.11): active and verified (OAuth, or a manual row an admin checked). */
export function isVerifiedSource(source: {
  status: TierSource["status"]
  verifiedAt: Date | null
}): boolean {
  return source.status === "active" && source.verifiedAt !== null
}

function maxFollowers(sources: readonly TierSource[]): number | null {
  let best: number | null = null
  for (const source of sources) {
    if (source.followers === null) continue
    if (best === null || source.followers > best) best = source.followers
  }
  return best
}

/** The size tier from a creator's connections (revoked ones are ignored). */
export function computeSizeTier(sources: readonly TierSource[]): SizeTierResult {
  const usable = sources.filter((source) => source.status !== "revoked")
  const verified = maxFollowers(
    usable.filter((source) => source.status === "active" && source.verified),
  )
  if (verified !== null) return { tier: sizeTierFor(verified), verified: true, followers: verified }
  const fallback = maxFollowers(usable)
  return { tier: sizeTierFor(fallback), verified: false, followers: fallback }
}
