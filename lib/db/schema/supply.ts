import { sql } from "drizzle-orm"
import { boolean, check, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core"

import {
  currency,
  currencyFormatCheck,
  embedding,
  embeddingModel,
  embeddingTracking,
  id,
  nonBlankCheck,
  sha256HexCheck,
  textArray,
  timestamps,
  timestamptz,
  withRLS,
} from "./columns"
import { ideaStatusEnum, productFormatEnum, productStageEnum, productStatusEnum } from "./enums"
import { builderProfiles, creatorProfiles } from "./identity"

/**
 * Supply & demand (§5). Ideas and products are referenced by proposals/collabs: never cascaded.
 * Status transitions are the W2 contract (CLAUDE.md §19.24): `published_at` is set whenever the row
 * becomes visible to others (open / seeking) and kept afterwards; `archived_at` exactly while the
 * row is archived. Who may see which status: `PUBLIC_IDEA_STATUSES` / `PUBLIC_PRODUCT_STATUSES` in
 * lib/auth/authz.ts.
 */

/** Creator-posted ideas: what the audience wants. */
export const ideas = withRLS(
  pgTable(
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
      /** Last time the idea was published (draft → open); kept while in_collab / launched. */
      publishedAt: timestamptz("published_at"),
      /** Set exactly while status = archived. */
      archivedAt: timestamptz("archived_at"),
      embedding: embedding(),
      embeddingModel: embeddingModel(),
      ...embeddingTracking(),
      ...timestamps(),
    },
    (t) => [
      index("ideas_creator_profile_id_idx").on(t.creatorProfileId),
      index("ideas_status_idx").on(t.status),
      index("ideas_status_published_at_idx").on(t.status, t.publishedAt.desc()),
      index("ideas_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
      check("ideas_target_price_nonnegative", sql`${t.targetPriceCents} >= 0`),
      check("ideas_title_not_blank", nonBlankCheck(t.title)),
      check("ideas_currency_format", currencyFormatCheck(t.currency)),
      check(
        "ideas_published_has_time",
        sql`${t.status} NOT IN ('open', 'in_collab', 'launched') OR ${t.publishedAt} IS NOT NULL`,
      ),
      check(
        "ideas_archived_iff_archived_at",
        sql`(${t.status} = 'archived') = (${t.archivedAt} IS NOT NULL)`,
      ),
      check("ideas_embedding_text_hash_format", sha256HexCheck(t.embeddingTextHash)),
    ],
  ),
)

/** Builder-listed products: things that need distribution. */
export const products = withRLS(
  pgTable(
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
      /**
       * True: one creator at a time (an accepted proposal moves the product to `in_collab`).
       * False: the product stays `seeking` and may collab with several creators (§19.24).
       */
      exclusivity: boolean("exclusivity").notNull().default(false),
      status: productStatusEnum("status").notNull().default("draft"),
      /** Last time the product was published (draft → seeking); kept while in_collab / launched. */
      publishedAt: timestamptz("published_at"),
      /** Set exactly while status = archived. */
      archivedAt: timestamptz("archived_at"),
      embedding: embedding(),
      embeddingModel: embeddingModel(),
      ...embeddingTracking(),
      ...timestamps(),
    },
    (t) => [
      index("products_builder_profile_id_idx").on(t.builderProfileId),
      index("products_status_idx").on(t.status),
      index("products_status_published_at_idx").on(t.status, t.publishedAt.desc()),
      index("products_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
      check("products_target_price_nonnegative", sql`${t.targetPriceCents} >= 0`),
      check("products_preferred_split_range", sql`${t.preferredSplitBuilderPct} BETWEEN 0 AND 100`),
      check("products_title_not_blank", nonBlankCheck(t.title)),
      check("products_currency_format", currencyFormatCheck(t.currency)),
      check(
        "products_demo_url_http",
        sql`${t.demoUrl} IS NULL OR ${t.demoUrl} ~* '^https?://[^[:space:]]+$'`,
      ),
      check(
        "products_published_has_time",
        sql`${t.status} NOT IN ('seeking', 'in_collab', 'launched') OR ${t.publishedAt} IS NOT NULL`,
      ),
      check(
        "products_archived_iff_archived_at",
        sql`(${t.status} = 'archived') = (${t.archivedAt} IS NOT NULL)`,
      ),
      check("products_embedding_text_hash_format", sha256HexCheck(t.embeddingTextHash)),
    ],
  ),
)
