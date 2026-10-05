import { z } from "zod"

import { formatBytes, normalizeMimeType, UPLOAD_LIMITS } from "@/lib/storage/limits"

import { CREATOR_SOCIAL_PROVIDERS, type CreatorSocialProviderId } from "./types"

/**
 * Manual entry fallback (§7.1): while a provider's API is not approved (Meta and TikTok reviews
 * take weeks), a creator can enter their follower count, a link to the account and a screenshot
 * of the count. The entry is shown as "Unverified" until an admin checks the screenshot.
 * Client-safe, so the form validates before uploading; the server checks everything again.
 */

export const MANUAL_PROVIDERS = CREATOR_SOCIAL_PROVIDERS

/**
 * Screenshot policy: the image MIME allow-list (no SVG, §19.7) with the 25 MB attachment limit
 * (§14). Phone screenshots can exceed the 10 MB `image` purpose limit, so the size comes from the
 * attachment policy (CLAUDE.md §19.14).
 */
export const EVIDENCE_POLICY = {
  mimeTypes: UPLOAD_LIMITS.image.mimeTypes,
  maxBytes: UPLOAD_LIMITS.attachment.maxBytes,
} as const

export const EVIDENCE_EXTENSIONS: Record<(typeof EVIDENCE_POLICY.mimeTypes)[number], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

export type EvidenceCheck = { ok: true; contentType: string } | { ok: false; message: string }

export function checkEvidenceFile(file: { contentType: string; sizeBytes: number }): EvidenceCheck {
  const contentType = normalizeMimeType(file.contentType)
  if (!(EVIDENCE_POLICY.mimeTypes as readonly string[]).includes(contentType)) {
    return { ok: false, message: "Upload a PNG, JPEG, WebP or GIF screenshot." }
  }
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    return { ok: false, message: "This file is empty." }
  }
  if (file.sizeBytes > EVIDENCE_POLICY.maxBytes) {
    return {
      ok: false,
      message: `This screenshot is too large. The limit is ${formatBytes(EVIDENCE_POLICY.maxBytes)}.`,
    }
  }
  return { ok: true, contentType }
}

/** Hosts a profile link may point at, per provider (subdomains such as `m.` are fine). */
const PROFILE_HOSTS: Record<CreatorSocialProviderId, readonly string[]> = {
  youtube: ["youtube.com", "youtu.be"],
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
}

export function isProfileUrlFor(provider: CreatorSocialProviderId, value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "https:" || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return PROFILE_HOSTS[provider].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

export const PROFILE_URL_EXAMPLES: Record<CreatorSocialProviderId, string> = {
  youtube: "https://www.youtube.com/@yourchannel",
  instagram: "https://www.instagram.com/yourname",
  tiktok: "https://www.tiktok.com/@yourname",
}

/** Followers people can type: whole numbers, with thousands separators allowed. */
export const followerCountSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/[\s,.'’_]/g, "") : value),
  z.coerce
    .number({ error: "Enter your follower count as a whole number." })
    .int("Enter your follower count as a whole number.")
    .min(0, "Followers can't be negative.")
    .max(2_000_000_000, "That number is too large."),
)

export const manualProviderSchema = z.enum(MANUAL_PROVIDERS, {
  error: "Manual entry is available for YouTube, Instagram and TikTok.",
})
