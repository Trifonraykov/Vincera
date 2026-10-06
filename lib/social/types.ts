import { z } from "zod"

import type { audienceSnapshots } from "@/lib/db/schema"
import type { SocialProvider as EnvSocialProviderId } from "@/lib/env"

/**
 * Social data connections (§7.1): the provider interface and the shapes every provider returns.
 * These are connections for audience *data*, separate from login (Auth.js).
 *
 * Provider specifics (token lifetimes, rounding, demographics basis) are in
 * `docs/integrations/social-providers.md`. Client-safe: no server-only imports.
 */

export const SOCIAL_PROVIDER_IDS = ["youtube", "instagram", "tiktok", "github"] as const
export const socialProviderIdSchema = z.enum(SOCIAL_PROVIDER_IDS)
export type SocialProviderId = z.infer<typeof socialProviderIdSchema>

/**
 * Audience providers: what creators connect (§7.1); creator onboarding's "connect" step counts
 * these. GitHub is the builders' provider (creators may connect it too).
 */
export const CREATOR_SOCIAL_PROVIDERS = [
  "youtube",
  "instagram",
  "tiktok",
] as const satisfies readonly SocialProviderId[]
export type CreatorSocialProviderId = (typeof CREATOR_SOCIAL_PROVIDERS)[number]

// Compile-time check that this list matches the one lib/env.ts uses for credentials.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
type _ProviderIdsMatchEnv = Assert<Same<SocialProviderId, EnvSocialProviderId>>

/**
 * OAuth tokens as stored (encrypted) on `social_connections`. Lifetimes differ per provider:
 * Google issues refresh tokens; TikTok rotates them (always store the new one); Instagram has
 * none (the access token itself is refreshed); GitHub OAuth App tokens do not expire.
 */
export const tokenSetSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  /** When the access token expires; null when it does not. */
  expiresAt: z.date().nullable(),
  /** When the refresh token expires (TikTok); null when unknown or non-expiring. */
  refreshExpiresAt: z.date().nullable(),
  /** Scopes actually granted, which can be fewer than requested. */
  scopes: z.array(z.string()),
  /** Provider account id when the token response includes it (TikTok `open_id`, IG `user_id`). */
  providerAccountId: z.string().min(1).nullable(),
  /**
   * When the access token was issued (`social_connections.token_obtained_at`). Providers set it on
   * exchange and refresh; Instagram refreshes only tokens at least 24h old (§19.10). Optional so
   * hand-built token sets stay valid; unknown means "estimate from expiresAt".
   */
  obtainedAt: z.date().nullable().optional(),
})
export type TokenSet = z.infer<typeof tokenSetSchema>

export const socialProfileSchema = z.object({
  providerAccountId: z.string().min(1),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  profileUrl: z.url().nullable(),
  /** Followers / subscribers as reported; YouTube rounds to 3 significant figures. */
  followers: z.number().int().nonnegative().nullable(),
  bio: z.string().nullable(),
})
export type SocialProfile = z.infer<typeof socialProfileSchema>

/** What the demographic shares are fractions of. YouTube reports viewers, Instagram followers. */
export const audienceBasisSchema = z.enum(["viewers", "followers"])
export type AudienceBasis = z.infer<typeof audienceBasisSchema>

const share = z.number().min(0).max(1)

/**
 * Input for an `audience_snapshots` row (§5). Fields are null where the API does not provide them.
 * The fields are stored as they are (the column types match; checked at compile time below).
 */
export const audienceSnapshotInputSchema = z
  .object({
    followers: z.number().int().nonnegative().nullable(),
    /** Average views per recent post/video. */
    avgViews: z.number().int().nonnegative().nullable(),
    /** Interactions ÷ views (or reach) as a fraction, e.g. 0.0523; stored as numeric(6,4). */
    engagementRate: z.number().min(0).max(99).nullable(),
    /** ISO 3166-1 alpha-2 countries with their share; empty when unknown. */
    topCountries: z.array(z.object({ country: z.string().regex(/^[A-Z]{2}$/), share })),
    /** Null where unavailable (TikTok, small Instagram accounts). */
    ageGender: z
      .object({
        basis: audienceBasisSchema,
        buckets: z.array(
          z.object({
            /** Provider label normalised to e.g. `18-24`, `65+`. */
            ageGroup: z.string().min(1),
            /** `other`: YouTube's "user_specified"; `unknown`: Instagram's "U". */
            gender: z.enum(["female", "male", "other", "unknown"]),
            share,
          }),
        ),
      })
      .nullable(),
    /** Basis of `topCountries`; null when there are none. */
    countriesBasis: audienceBasisSchema.nullable(),
    topTopics: z.array(z.string().min(1)),
    /** Provider payload subset worth keeping for re-processing (never tokens). JSON only. */
    raw: z.record(z.string(), z.json()),
  })
  .refine((input) => input.topCountries.length === 0 || input.countriesBasis !== null, {
    message: "countriesBasis is required when topCountries is not empty",
    path: ["countriesBasis"],
  })
export type AudienceSnapshotInput = z.infer<typeof audienceSnapshotInputSchema>

// Compile-time check that every field fits its `audience_snapshots` column exactly (ignoring the
// column's nullability), so the Phase 1 sync can insert a provider's output without mapping.
type SnapshotInsert = typeof audienceSnapshots.$inferInsert
type ColumnShape<K extends keyof SnapshotInsert> = NonNullable<SnapshotInsert[K]>
type SnapshotFieldsMatchColumns = {
  [K in keyof AudienceSnapshotInput]: K extends keyof SnapshotInsert
    ? Same<NonNullable<AudienceSnapshotInput[K]>, ColumnShape<K>>
    : false
}
type _SnapshotInputMatchesTable = Assert<
  SnapshotFieldsMatchColumns[keyof AudienceSnapshotInput] extends true ? true : false
>

export type PkceChallenge = { codeChallenge: string; codeChallengeMethod: "S256" }

/**
 * One provider. §7.1 defines the five methods; PKCE parameters are optional extras because
 * Google and GitHub support PKCE while Instagram and TikTok (web) do not (§14 asks for PKCE
 * wherever possible). Implementations parse every response with Zod.
 */
export interface SocialProvider {
  readonly id: SocialProviderId
  readonly supportsPkce: boolean
  /** Scopes requested at authorization. */
  readonly scopes: readonly string[]
  authUrl(state: string, pkce?: PkceChallenge): string
  exchangeCode(code: string, pkce?: { codeVerifier: string }): Promise<TokenSet>
  refresh(token: TokenSet): Promise<TokenSet>
  fetchProfile(token: TokenSet): Promise<SocialProfile>
  fetchAudience(token: TokenSet): Promise<AudienceSnapshotInput>
}

/** Thrown when a token is expired or revoked; the sync marks the connection `expired` (§7.1). */
export class SocialTokenError extends Error {
  constructor(
    readonly provider: SocialProviderId,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "SocialTokenError"
  }
}
