import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core"

import {
  createdAt,
  embedding,
  embeddingModel,
  handleFormatCheck,
  id,
  textArray,
  timestamps,
  timestamptz,
} from "./columns"
import {
  availabilityEnum,
  dealPreferenceEnum,
  productFormatEnum,
  sizeTierEnum,
  userRoleEnum,
  userStatusEnum,
  type UserRole,
} from "./enums"
import type { OnboardingStepsRecord } from "./types"

/**
 * Identity & profiles (§5), plus the Auth.js Drizzle adapter tables.
 *
 * The adapter reads users/accounts/sessions/verification_tokens through the TS property names it
 * expects (`emailVerified`, `image`, `providerAccountId`, `sessionToken`, ...); the SQL columns are
 * snake_case. `users.image` is stored in `avatar_url` (§5).
 */

export const users = pgTable(
  "users",
  {
    id: id(),
    name: text("name"),
    email: text("email").unique(),
    emailVerified: timestamptz("email_verified"),
    image: text("avatar_url"),
    roles: textArray<UserRole>("roles"),
    activeRole: userRoleEnum("active_role"),
    status: userStatusEnum("status").notNull().default("active"),
    onboardingCompletedAt: timestamptz("onboarding_completed_at"),
    /**
     * Onboarding steps the user completed or skipped (step id → `{ status, at }`), Phase 1.
     * Profile steps are judged by whether the profile exists; see lib/onboarding/next-step.ts.
     */
    onboardingSteps: jsonb("onboarding_steps")
      .$type<OnboardingStepsRecord>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    check("users_roles_valid", sql`${t.roles} <@ ARRAY['creator', 'builder', 'admin']::text[]`),
    check("users_onboarding_steps_object", sql`jsonb_typeof(${t.onboardingSteps}) = 'object'`),
    check(
      "users_active_role_in_roles",
      sql`${t.activeRole} IS NULL OR ${t.activeRole}::text = ANY(${t.roles})`,
    ),
  ],
)

/** `type` values Auth.js writes to accounts. */
export type AuthAccountType = "oauth" | "oidc" | "email" | "webauthn"

/** Auth.js login accounts (Google/GitHub). Social *data* connections live in social_connections. */
export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AuthAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ name: "accounts_pkey", columns: [t.provider, t.providerAccountId] }),
    index("accounts_user_id_idx").on(t.userId),
  ],
)

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamptz("expires").notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
)

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamptz("expires").notNull(),
  },
  (t) => [primaryKey({ name: "verification_tokens_pkey", columns: [t.identifier, t.token] })],
)

/**
 * Handle registry: a handle belongs to exactly one user, which makes handles unique across creators
 * and builders (§4). Both of that user's profiles may use it. Profiles reference (handle, user_id),
 * so a profile can only use a handle its own user owns; renaming a handle cascades to profiles, and
 * a handle in use cannot be deleted (NO ACTION, checked at statement end so a user cascade works).
 */
export const handles = pgTable(
  "handles",
  {
    handle: text("handle").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("handles_handle_user_id_key").on(t.handle, t.userId),
    index("handles_user_id_idx").on(t.userId),
    check("handles_handle_format", handleFormatCheck(t.handle)),
  ],
)

export const creatorProfiles = pgTable(
  "creator_profiles",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    handle: text("handle").notNull().unique(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    niche: text("niche"),
    topics: textArray("topics"),
    languages: textArray("languages"),
    /** ISO 3166-1 alpha-2, uppercase. */
    country: text("country"),
    sizeTier: sizeTierEnum("size_tier"),
    audienceSummary: text("audience_summary"),
    /** Prompt version that produced audience_summary (§7.3). */
    audienceSummaryPromptVersion: text("audience_summary_prompt_version"),
    /** When the AI last wrote audience_summary (null: never generated). */
    audienceSummaryGeneratedAt: timestamptz("audience_summary_generated_at"),
    /**
     * When the creator last edited audience_summary themselves (§7.3 "user-editable"). While it is
     * set, syncs keep the creator's text instead of regenerating it (CLAUDE.md §19.11).
     */
    audienceSummaryEditedAt: timestamptz("audience_summary_edited_at"),
    embedding: embedding(),
    embeddingModel: embeddingModel(),
    verifiedAt: timestamptz("verified_at"),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: "creator_profiles_handle_owner_fk",
      columns: [t.handle, t.userId],
      foreignColumns: [handles.handle, handles.userId],
    })
      .onUpdate("cascade")
      .onDelete("no action"),
    check("creator_profiles_handle_format", handleFormatCheck(t.handle)),
    check("creator_profiles_country_format", sql`${t.country} ~ '^[A-Z]{2}$'`),
    index("creator_profiles_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
)

export const builderProfiles = pgTable(
  "builder_profiles",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    handle: text("handle").notNull().unique(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    skills: textArray("skills"),
    stack: textArray("stack"),
    availability: availabilityEnum("availability").notNull().default("open"),
    dealPreference: dealPreferenceEnum("deal_preference").notNull().default("either"),
    embedding: embedding(),
    embeddingModel: embeddingModel(),
    verifiedAt: timestamptz("verified_at"),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: "builder_profiles_handle_owner_fk",
      columns: [t.handle, t.userId],
      foreignColumns: [handles.handle, handles.userId],
    })
      .onUpdate("cascade")
      .onDelete("no action"),
    check("builder_profiles_handle_format", handleFormatCheck(t.handle)),
    index("builder_profiles_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
)

export const portfolioItems = pgTable(
  "portfolio_items",
  {
    id: id(),
    builderProfileId: uuid("builder_profile_id")
      .notNull()
      .references(() => builderProfiles.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url"),
    description: text("description"),
    imageUrl: text("image_url"),
    isShipped: boolean("is_shipped").notNull().default(false),
    /** Needed by the `format_fit` matching feature (§8). */
    format: productFormatEnum("format"),
    ...timestamps(),
  },
  (t) => [index("portfolio_items_builder_profile_id_idx").on(t.builderProfileId)],
)
