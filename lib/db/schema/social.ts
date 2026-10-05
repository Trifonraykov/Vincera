import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core"

import { createdAt, id, textArray, timestamps, timestamptz } from "./columns"
import {
  audienceBasisEnum,
  socialConnectionSourceEnum,
  socialConnectionStatusEnum,
  socialProviderEnum,
} from "./enums"
import { users } from "./identity"
import type { AgeGender, CountryShare, SnapshotRaw } from "./types"

/** Social data connections (§5, §7.1). Separate from login accounts. */
export const socialConnections = pgTable(
  "social_connections",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: socialProviderEnum("provider").notNull(),
    /** Null for manual entries (no provider account behind them). */
    providerAccountId: text("provider_account_id"),
    username: text("username"),
    /** Provider display data from `SocialProfile` (refreshed on connect and sync). */
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    /** Public profile/channel URL; for manual rows, the link an admin checks before verifying. */
    profileUrl: text("profile_url"),
    /** AES-GCM ciphertexts from lib/crypto.ts (§4). Never plaintext. */
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    /** Access token expiry (`TokenSet.expiresAt`); null when it does not expire. */
    expiresAt: timestamptz("expires_at"),
    /** Refresh token expiry (`TokenSet.refreshExpiresAt`, TikTok); null when unknown/none. */
    refreshExpiresAt: timestamptz("refresh_expires_at"),
    /** When the current access token was issued (Instagram refreshes only tokens ≥24h old). */
    tokenObtainedAt: timestamptz("token_obtained_at"),
    scopes: textArray("scopes"),
    status: socialConnectionStatusEnum("status").notNull().default("active"),
    /** Last successful sync. */
    lastSyncedAt: timestamptz("last_synced_at"),
    /**
     * Why the last sync failed, as a short code (e.g. `token_expired`, `rate_limited`,
     * `provider_error`); never a token or a provider response body. Cleared by a successful sync.
     */
    lastSyncError: text("last_sync_error"),
    lastSyncErrorAt: timestamptz("last_sync_error_at"),
    /** Manual fallback (§7.1): `manual` rows are unverified until an admin sets verified_at. */
    source: socialConnectionSourceEnum("source").notNull().default("oauth"),
    verifiedAt: timestamptz("verified_at"),
    /** Storage key of the screenshot uploaded as evidence for a manual entry. */
    evidenceStorageKey: text("evidence_storage_key"),
    ...timestamps(),
  },
  (t) => [
    // One connection per provider per user, and one platform user per provider account.
    unique("social_connections_user_id_provider_key").on(t.userId, t.provider),
    unique("social_connections_provider_account_key").on(t.provider, t.providerAccountId),
    check(
      "social_connections_oauth_has_account",
      sql`${t.source} <> 'oauth' OR ${t.providerAccountId} IS NOT NULL`,
    ),
    // Manual entries (§7.1 fallback) have no provider tokens.
    check(
      "social_connections_manual_has_no_tokens",
      sql`${t.source} <> 'manual' OR (${t.accessTokenEnc} IS NULL AND ${t.refreshTokenEnc} IS NULL)`,
    ),
    check(
      "social_connections_sync_error_has_time",
      sql`${t.lastSyncError} IS NULL OR ${t.lastSyncErrorAt} IS NOT NULL`,
    ),
  ],
)

/** Append-only (§5): one row per sync, never updated or deleted (DB triggers enforce it). */
export const audienceSnapshots = pgTable(
  "audience_snapshots",
  {
    id: id(),
    socialConnectionId: uuid("social_connection_id").notNull(),
    takenAt: timestamptz("taken_at").notNull(),
    followers: integer("followers"),
    avgViews: integer("avg_views"),
    engagementRate: numeric("engagement_rate", { precision: 6, scale: 4, mode: "number" }),
    topCountries: jsonb("top_countries").$type<CountryShare[]>(),
    /** What the top_countries shares are fractions of; null when there are no countries. */
    countriesBasis: audienceBasisEnum("countries_basis"),
    /** Null where the provider has no demographics (TikTok, small Instagram accounts). */
    ageGender: jsonb("age_gender").$type<AgeGender>(),
    topTopics: textArray("top_topics"),
    raw: jsonb("raw").$type<SnapshotRaw>(),
    createdAt: createdAt(),
  },
  (t) => [
    // Named explicitly: the generated name exceeds Postgres' 63-character limit.
    foreignKey({
      name: "audience_snapshots_social_connection_id_fk",
      columns: [t.socialConnectionId],
      foreignColumns: [socialConnections.id],
    }).onDelete("cascade"),
    index("audience_snapshots_connection_taken_at_idx").on(t.socialConnectionId, t.takenAt.desc()),
    check("audience_snapshots_followers_nonnegative", sql`${t.followers} >= 0`),
    check("audience_snapshots_avg_views_nonnegative", sql`${t.avgViews} >= 0`),
    // Country shares without their basis cannot be compared across providers.
    check(
      "audience_snapshots_countries_have_basis",
      sql`${t.countriesBasis} IS NOT NULL OR ${t.topCountries} IS NULL OR jsonb_array_length(${t.topCountries}) = 0`,
    ),
  ],
)
