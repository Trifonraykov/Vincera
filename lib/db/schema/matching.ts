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
} from "drizzle-orm/pg-core"

import { id, timestamps, timestamptz, withRLS } from "./columns"
import { matchStatusEnum, targetTypeEnum } from "./enums"
import { users } from "./identity"
import type { MatchFeatures, MatchWeights } from "./types"

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
      index("matches_model_version_idx").on(t.modelVersion),
      check("matches_score_range", sql`${t.score} BETWEEN 0 AND 1`),
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
    (t) => [unique("saved_items_user_target_key").on(t.userId, t.targetType, t.targetId)],
  ),
)
