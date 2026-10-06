import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"

import { id, timestamps, timestamptz, withRLS } from "./columns"
import { matchStatusEnum, targetTypeEnum } from "./enums"
import { users } from "./identity"
import { MATCH_FEATURES, type MatchFeatures, type MatchWeights } from "./types"

/**
 * CHECK body: `features` is an object with exactly the §8 feature names, each a number in 0–1.
 * CASE keeps the cast from running on a non-number (AND does not promise an order).
 */
function featureVectorCheck(features: AnyPgColumn) {
  const names = sql.raw(`ARRAY[${MATCH_FEATURES.map((name) => `'${name}'`).join(", ")}]`)
  const ranges = MATCH_FEATURES.map(
    (name) =>
      sql`CASE WHEN jsonb_typeof(${features} -> ${sql.raw(`'${name}'`)}) = 'number' THEN (${features} ->> ${sql.raw(`'${name}'`)})::numeric BETWEEN 0 AND 1 ELSE false END`,
  )
  return sql`jsonb_typeof(${features}) = 'object' AND ${features} ?& ${names} AND (${features} - ${names}) = '{}'::jsonb AND ${sql.join(ranges, sql` AND `)}`
}

/** Matching (§5, §8). */

/** Scoring weights per model version (§8). At most one row is active. */
export const matchingConfig = withRLS(
  pgTable(
    "matching_config",
    {
      id: id(),
      modelVersion: text("model_version").notNull().unique(),
      weights: jsonb("weights").$type<MatchWeights>().notNull(),
      active: boolean("active").notNull().default(false),
      notes: text("notes"),
      ...timestamps(),
    },
    (t) => [
      uniqueIndex("matching_config_single_active_idx")
        .on(t.active)
        .where(sql`${t.active}`),
    ],
  ),
)

/** Ranked match for `subject_user_id`; target_id points at a user, idea or product by target_type. */
export const matches = withRLS(
  pgTable(
    "matches",
    {
      id: id(),
      subjectUserId: uuid("subject_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      targetType: targetTypeEnum("target_type").notNull(),
      targetId: uuid("target_id").notNull(),
      score: numeric("score", { precision: 7, scale: 6, mode: "number" }).notNull(),
      /** Full feature vector: the training data for matching v1 (§8). */
      features: jsonb("features").$type<MatchFeatures>().notNull(),
      explanation: text("explanation"),
      /** Prompt version that produced `explanation` (§7.3). */
      explanationPromptVersion: text("explanation_prompt_version"),
      modelVersion: text("model_version")
        .notNull()
        .references(() => matchingConfig.modelVersion, { onDelete: "restrict" }),
      status: matchStatusEnum("status").notNull().default("shown"),
      computedAt: timestamptz("computed_at").notNull(),
      /**
       * Set when a recompute no longer ranks the target in the subject's list (or it stopped being
       * a candidate); cleared when it comes back. Rows are kept, never deleted: the stored feature
       * vectors are v1's training data (§8). Lists show `stale_at IS NULL` only (§19.24).
       */
      staleAt: timestamptz("stale_at"),
      /** First time the subject was shown this match (`match.shown` is emitted once, then). */
      shownAt: timestamptz("shown_at"),
      ...timestamps(),
    },
    (t) => [
      unique("matches_subject_target_model_key").on(
        t.subjectUserId,
        t.targetType,
        t.targetId,
        t.modelVersion,
      ),
      index("matches_subject_status_score_idx").on(t.subjectUserId, t.status, t.score.desc()),
      index("matches_subject_current_score_idx")
        .on(t.subjectUserId, t.score.desc())
        .where(sql`${t.staleAt} IS NULL`),
      index("matches_target_idx").on(t.targetType, t.targetId),
      index("matches_model_version_idx").on(t.modelVersion),
      check("matches_score_range", sql`${t.score} BETWEEN 0 AND 1`),
      check("matches_features_vector", featureVectorCheck(t.features)),
      // §8 "exclude yourself": a person never matches themselves (creator/builder targets are user ids).
      check(
        "matches_not_self",
        sql`${t.targetType} NOT IN ('creator', 'builder') OR ${t.targetId} <> ${t.subjectUserId}`,
      ),
    ],
  ),
)

export const savedItems = withRLS(
  pgTable(
    "saved_items",
    {
      id: id(),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      targetType: targetTypeEnum("target_type").notNull(),
      targetId: uuid("target_id").notNull(),
      ...timestamps(),
    },
    (t) => [
      unique("saved_items_user_target_key").on(t.userId, t.targetType, t.targetId),
      index("saved_items_target_idx").on(t.targetType, t.targetId),
    ],
  ),
)
