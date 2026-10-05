import { sql } from "drizzle-orm"
import { boolean, check, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core"

import { currency, embedding, embeddingModel, id, textArray, timestamps } from "./columns"
import { ideaStatusEnum, productFormatEnum, productStageEnum, productStatusEnum } from "./enums"
import { builderProfiles, creatorProfiles } from "./identity"

/** Supply & demand (§5). Ideas and products are referenced by proposals/collabs: never cascaded. */

/** Creator-posted ideas: what the audience wants. */
export const ideas = pgTable(
  "ideas",
  {
    id: id(),
    creatorProfileId: uuid("creator_profile_id")
      .notNull()
      .references(() => creatorProfiles.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    problem: text("problem"),
    audienceEvidence: text("audience_evidence"),
    format: productFormatEnum("format").notNull(),
    targetPriceCents: integer("target_price_cents"),
    currency: currency(),
    topics: textArray("topics"),
    status: ideaStatusEnum("status").notNull().default("draft"),
    embedding: embedding(),
    embeddingModel: embeddingModel(),
    ...timestamps(),
  },
  (t) => [
    index("ideas_creator_profile_id_idx").on(t.creatorProfileId),
    index("ideas_status_idx").on(t.status),
    index("ideas_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check("ideas_target_price_nonnegative", sql`${t.targetPriceCents} >= 0`),
  ],
)

/** Builder-listed products: things that need distribution. */
export const products = pgTable(
  "products",
  {
    id: id(),
    builderProfileId: uuid("builder_profile_id")
      .notNull()
      .references(() => builderProfiles.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    targetUser: text("target_user"),
    stage: productStageEnum("stage").notNull().default("idea"),
    demoUrl: text("demo_url"),
    format: productFormatEnum("format").notNull(),
    /** Planned price; needed by the `price_fit` matching feature (§8). */
    targetPriceCents: integer("target_price_cents"),
    currency: currency(),
    topics: textArray("topics"),
    preferredSplitBuilderPct: integer("preferred_split_builder_pct"),
    exclusivity: boolean("exclusivity").notNull().default(false),
    status: productStatusEnum("status").notNull().default("draft"),
    embedding: embedding(),
    embeddingModel: embeddingModel(),
    ...timestamps(),
  },
  (t) => [
    index("products_builder_profile_id_idx").on(t.builderProfileId),
    index("products_status_idx").on(t.status),
    index("products_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check("products_target_price_nonnegative", sql`${t.targetPriceCents} >= 0`),
    check("products_preferred_split_range", sql`${t.preferredSplitBuilderPct} BETWEEN 0 AND 100`),
  ],
)
