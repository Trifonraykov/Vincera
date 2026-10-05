import { sql } from "drizzle-orm"
import {
  check,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"

import { now } from "../../clock"
import { createdAt, id, timestamps, timestamptz, withRLS } from "./columns"
import {
  agreementStatusEnum,
  collabRoleEnum,
  collabStageEnum,
  proposalStatusEnum,
  threadKindEnum,
} from "./enums"
import { users } from "./identity"
import { ideas, products } from "./supply"
import type { AgreementTerms, MessageAttachment } from "./types"

/**
 * Collaboration (§5): proposals → collabs → agreements, tasks, threads.
 * Rows that belong to a collab or thread cascade with it; users, ideas and products are never
 * cascaded into collaboration history.
 */

/** Pending proposals expire this many days after they are sent (§5). */
export const PROPOSAL_TTL_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

export const proposals = withRLS(
  pgTable(
    "proposals",
    {
      id: id(),
      fromUserId: uuid("from_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      toUserId: uuid("to_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      ideaId: uuid("idea_id").references(() => ideas.id, { onDelete: "restrict" }),
      productId: uuid("product_id").references(() => products.id, { onDelete: "restrict" }),
      status: proposalStatusEnum("status").notNull().default("pending"),
      currentRevisionId: uuid("current_revision_id").references(
        (): AnyPgColumn => proposalRevisions.id,
        { onDelete: "restrict" },
      ),
      expiresAt: timestamptz("expires_at")
        .notNull()
        .default(sql`now() + interval '${sql.raw(String(PROPOSAL_TTL_DAYS))} days'`)
        .$defaultFn(() => new Date(now().getTime() + PROPOSAL_TTL_DAYS * DAY_MS)),
      ...timestamps(),
    },
    (t) => [
      index("proposals_from_user_id_idx").on(t.fromUserId),
      index("proposals_to_user_id_idx").on(t.toUserId),
      index("proposals_idea_id_idx").on(t.ideaId),
      index("proposals_product_id_idx").on(t.productId),
      index("proposals_current_revision_id_idx").on(t.currentRevisionId),
      index("proposals_status_expires_at_idx").on(t.status, t.expiresAt),
      check("proposals_exactly_one_target", sql`num_nonnulls(${t.ideaId}, ${t.productId}) = 1`),
      check("proposals_not_to_self", sql`${t.fromUserId} <> ${t.toUserId}`),
    ],
  ),
)

/** Append-only (§5): every offer and counter-offer, never updated or deleted. */
export const proposalRevisions = withRLS(
  pgTable(
    "proposal_revisions",
    {
      id: id(),
      proposalId: uuid("proposal_id")
        .notNull()
        .references((): AnyPgColumn => proposals.id, { onDelete: "restrict" }),
      authorUserId: uuid("author_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      message: text("message"),
      scope: text("scope").notNull(),
      creatorSplitPct: integer("creator_split_pct").notNull(),
      builderSplitPct: integer("builder_split_pct").notNull(),
      timelineWeeks: integer("timeline_weeks").notNull(),
      createdAt: createdAt(),
    },
    (t) => [
      index("proposal_revisions_proposal_id_idx").on(t.proposalId, t.createdAt),
      index("proposal_revisions_author_user_id_idx").on(t.authorUserId),
      check(
        "proposal_revisions_split_valid",
        sql`${t.creatorSplitPct} BETWEEN 0 AND 100 AND ${t.builderSplitPct} BETWEEN 0 AND 100 AND ${t.creatorSplitPct} + ${t.builderSplitPct} = 100`,
      ),
      check("proposal_revisions_timeline_positive", sql`${t.timelineWeeks} > 0`),
    ],
  ),
)

export const collabs = withRLS(
  pgTable(
    "collabs",
    {
      id: id(),
      proposalId: uuid("proposal_id")
        .notNull()
        .unique()
        .references(() => proposals.id, { onDelete: "restrict" }),
      ideaId: uuid("idea_id").references(() => ideas.id, { onDelete: "restrict" }),
      productId: uuid("product_id").references(() => products.id, { onDelete: "restrict" }),
      stage: collabStageEnum("stage").notNull().default("agreement"),
      endedReason: text("ended_reason"),
      ...timestamps(),
    },
    (t) => [
      index("collabs_idea_id_idx").on(t.ideaId),
      index("collabs_product_id_idx").on(t.productId),
      index("collabs_stage_idx").on(t.stage),
      check("collabs_exactly_one_target", sql`num_nonnulls(${t.ideaId}, ${t.productId}) = 1`),
    ],
  ),
)

export const collabMembers = withRLS(
  pgTable(
    "collab_members",
    {
      id: id(),
      collabId: uuid("collab_id")
        .notNull()
        .references(() => collabs.id, { onDelete: "cascade" }),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      role: collabRoleEnum("role").notNull(),
      splitPct: integer("split_pct").notNull(),
      ...timestamps(),
    },
    (t) => [
      unique("collab_members_collab_user_key").on(t.collabId, t.userId),
      index("collab_members_user_id_idx").on(t.userId),
      check("collab_members_split_range", sql`${t.splitPct} BETWEEN 0 AND 100`),
    ],
  ),
)

export const agreements = withRLS(
  pgTable(
    "agreements",
    {
      id: id(),
      collabId: uuid("collab_id")
        .notNull()
        .references(() => collabs.id, { onDelete: "cascade" }),
      templateVersion: text("template_version").notNull(),
      terms: jsonb("terms").$type<AgreementTerms>().notNull(),
      /** sha256 (hex) of the rendered agreement text. */
      bodyHash: text("body_hash").notNull(),
      /** Set after both parties signed and the PDF was stored. */
      pdfStorageKey: text("pdf_storage_key"),
      status: agreementStatusEnum("status").notNull().default("awaiting_signatures"),
      ...timestamps(),
    },
    (t) => [
      index("agreements_collab_id_idx").on(t.collabId),
      // A collab has at most one agreement in force; terminated ones are kept as history.
      uniqueIndex("agreements_one_active_per_collab_idx")
        .on(t.collabId)
        .where(sql`${t.status} <> 'terminated'`),
      check("agreements_body_hash_sha256", sql`${t.bodyHash} ~ '^[0-9a-f]{64}$'`),
    ],
  ),
)

/** Append-only (§5): click-sign records, never updated or deleted. */
export const agreementSignatures = withRLS(
  pgTable(
    "agreement_signatures",
    {
      id: id(),
      agreementId: uuid("agreement_id")
        .notNull()
        .references(() => agreements.id, { onDelete: "restrict" }),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      signedAt: timestamptz("signed_at").notNull(),
      ip: inet("ip"),
      userAgent: text("user_agent"),
      typedName: text("typed_name").notNull(),
      createdAt: createdAt(),
    },
    (t) => [
      unique("agreement_signatures_agreement_user_key").on(t.agreementId, t.userId),
      index("agreement_signatures_user_id_idx").on(t.userId),
    ],
  ),
)

export const tasks = withRLS(
  pgTable(
    "tasks",
    {
      id: id(),
      collabId: uuid("collab_id")
        .notNull()
        .references(() => collabs.id, { onDelete: "cascade" }),
      title: text("title").notNull(),
      assigneeUserId: uuid("assignee_user_id").references(() => users.id, {
        onDelete: "set null",
      }),
      dueDate: date("due_date", { mode: "string" }),
      doneAt: timestamptz("done_at"),
      position: integer("position").notNull().default(0),
      ...timestamps(),
    },
    (t) => [
      index("tasks_collab_id_position_idx").on(t.collabId, t.position),
      index("tasks_assignee_user_id_idx").on(t.assigneeUserId),
    ],
  ),
)

/** One message thread per proposal and per collab. */
export const threads = withRLS(
  pgTable(
    "threads",
    {
      id: id(),
      kind: threadKindEnum("kind").notNull(),
      proposalId: uuid("proposal_id")
        .unique()
        .references(() => proposals.id, { onDelete: "cascade" }),
      collabId: uuid("collab_id")
        .unique()
        .references(() => collabs.id, { onDelete: "cascade" }),
      ...timestamps(),
    },
    (t) => [
      check(
        "threads_kind_matches_parent",
        sql`(${t.kind} = 'proposal' AND ${t.proposalId} IS NOT NULL AND ${t.collabId} IS NULL) OR (${t.kind} = 'collab' AND ${t.collabId} IS NOT NULL AND ${t.proposalId} IS NULL)`,
      ),
    ],
  ),
)

export const messages = withRLS(
  pgTable(
    "messages",
    {
      id: id(),
      threadId: uuid("thread_id")
        .notNull()
        .references(() => threads.id, { onDelete: "cascade" }),
      authorUserId: uuid("author_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      body: text("body").notNull(),
      attachments: jsonb("attachments")
        .$type<MessageAttachment[]>()
        .notNull()
        .default(sql`'[]'::jsonb`),
      ...timestamps(),
    },
    (t) => [
      index("messages_thread_id_created_at_idx").on(t.threadId, t.createdAt),
      index("messages_author_user_id_idx").on(t.authorUserId),
    ],
  ),
)

export const threadReads = withRLS(
  pgTable(
    "thread_reads",
    {
      id: id(),
      threadId: uuid("thread_id")
        .notNull()
        .references(() => threads.id, { onDelete: "cascade" }),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      lastReadAt: timestamptz("last_read_at").notNull(),
      ...timestamps(),
    },
    (t) => [
      unique("thread_reads_thread_user_key").on(t.threadId, t.userId),
      index("thread_reads_user_id_idx").on(t.userId),
    ],
  ),
)
