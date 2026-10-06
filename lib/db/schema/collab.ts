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
import { createdAt, id, nonBlankCheck, timestamps, timestamptz, withRLS } from "./columns"
import {
  agreementStatusEnum,
  collabEndReasonEnum,
  collabRoleEnum,
  collabStageEnum,
  proposalStatusEnum,
  threadKindEnum,
} from "./enums"
import { users } from "./identity"
import { matches } from "./matching"
import { ideas, products } from "./supply"
import type { AgreementTerms, MatchSnapshot, MessageAttachment } from "./types"

/**
 * Collaboration (§5): proposals → collabs → agreements, tasks, threads.
 * Rows that belong to a collab or thread cascade with it; users, ideas and products are never
 * cascaded into collaboration history.
 */

/** Pending proposals expire this many days after they are sent (§5). */
export const PROPOSAL_TTL_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

/** `timestamptz NOT NULL`, defaulting to the app clock (SQL `now()` for raw inserts). */
const clockTimestamp = (name: string) => timestamptz(name).notNull().defaultNow().$defaultFn(now)

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
      /**
       * Sent time + 14 days; every counter resets it to the counter's time + 14 days (§19.24).
       * `created_at` is when the proposal was sent (there are no draft proposals).
       */
      expiresAt: timestamptz("expires_at")
        .notNull()
        .default(sql`now() + interval '${sql.raw(String(PROPOSAL_TTL_DAYS))} days'`)
        .$defaultFn(() => new Date(now().getTime() + PROPOSAL_TTL_DAYS * DAY_MS)),
      /** The match the sender proposed from, if any (links matching to outcomes, §8 v1). */
      matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),
      /**
       * The match as it was when the proposal was sent (model version, score, features), so v1's
       * training rows use pre-outcome features: `matches` rows are rewritten by every recompute
       * (Phase 7; CLAUDE.md §19.38). Null without a match.
       */
      matchSnapshot: jsonb("match_snapshot").$type<MatchSnapshot>(),
      /** First answer by the recipient (counter, accept or decline); null until then. */
      respondedAt: timestamptz("responded_at"),
      /** When the proposal reached a final status; set exactly for closed statuses. */
      closedAt: timestamptz("closed_at"),
      ...timestamps(),
    },
    (t) => [
      index("proposals_from_user_id_idx").on(t.fromUserId),
      index("proposals_to_user_id_idx").on(t.toUserId),
      index("proposals_idea_id_idx").on(t.ideaId),
      index("proposals_product_id_idx").on(t.productId),
      index("proposals_current_revision_id_idx").on(t.currentRevisionId),
      index("proposals_match_id_idx").on(t.matchId),
      index("proposals_status_expires_at_idx").on(t.status, t.expiresAt),
      // At most one open proposal between two people about one idea or product, whoever sent it.
      uniqueIndex("proposals_one_open_per_pair_target_idx")
        .on(
          sql`least(${t.fromUserId}, ${t.toUserId})`,
          sql`greatest(${t.fromUserId}, ${t.toUserId})`,
          sql`coalesce(${t.ideaId}, ${t.productId})`,
        )
        .where(sql`${t.status} IN ('pending', 'countered')`),
      check("proposals_exactly_one_target", sql`num_nonnulls(${t.ideaId}, ${t.productId}) = 1`),
      check("proposals_not_to_self", sql`${t.fromUserId} <> ${t.toUserId}`),
      check(
        "proposals_match_snapshot_object",
        sql`${t.matchSnapshot} IS NULL OR jsonb_typeof(${t.matchSnapshot}) = 'object'`,
      ),
      check(
        "proposals_closed_iff_final",
        sql`(${t.status} IN ('accepted', 'declined', 'expired', 'withdrawn')) = (${t.closedAt} IS NOT NULL)`,
      ),
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
      /** 1 for the first offer, +1 per counter (the `revision_number` of proposal events). */
      revisionNumber: integer("revision_number").notNull(),
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
      unique("proposal_revisions_proposal_number_key").on(t.proposalId, t.revisionNumber),
      check("proposal_revisions_number_positive", sql`${t.revisionNumber} >= 1`),
      check("proposal_revisions_scope_not_blank", nonBlankCheck(t.scope)),
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
      /** When `stage` last changed (creation counts). */
      stageChangedAt: clockTimestamp("stage_changed_at"),
      /**
       * Last member activity: a message, a task change, a signature, a stage change. Drives the
       * "no activity for 7 days" reminder (§13); bump it with `touchCollabActivity()`.
       */
      lastActivityAt: clockTimestamp("last_activity_at"),
      /** Set exactly when stage = ended, together with `ended_reason`. */
      endedAt: timestamptz("ended_at"),
      endedReason: collabEndReasonEnum("ended_reason"),
      ...timestamps(),
    },
    (t) => [
      index("collabs_idea_id_idx").on(t.ideaId),
      index("collabs_product_id_idx").on(t.productId),
      index("collabs_stage_idx").on(t.stage),
      index("collabs_stage_last_activity_at_idx").on(t.stage, t.lastActivityAt),
      check("collabs_exactly_one_target", sql`num_nonnulls(${t.ideaId}, ${t.productId}) = 1`),
      check("collabs_ended_iff_ended_at", sql`(${t.stage} = 'ended') = (${t.endedAt} IS NOT NULL)`),
      check(
        "collabs_ended_has_reason",
        sql`(${t.stage} = 'ended') = (${t.endedReason} IS NOT NULL)`,
      ),
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
      /** e.g. `v1` (lib/agreements/template-v1.tsx). */
      templateVersion: text("template_version").notNull(),
      terms: jsonb("terms").$type<AgreementTerms>().notNull(),
      /**
       * The exact agreement text the parties sign (rendered from the template and `terms` when
       * the agreement is generated, i.e. at `created_at`). Never re-rendered: the PDF and the
       * signatures refer to this text.
       */
      renderedBody: text("rendered_body").notNull(),
      /** sha256 (hex) of `rendered_body` (UTF-8); the database checks it. */
      bodyHash: text("body_hash").notNull(),
      /** Set after both parties signed and the PDF was stored. */
      pdfStorageKey: text("pdf_storage_key"),
      status: agreementStatusEnum("status").notNull().default("awaiting_signatures"),
      /** When the last party signed (status → signed). */
      completedAt: timestamptz("completed_at"),
      /** Set exactly when status = terminated. */
      terminatedAt: timestamptz("terminated_at"),
      ...timestamps(),
    },
    (t) => [
      index("agreements_collab_id_idx").on(t.collabId),
      // A collab has at most one agreement in force; terminated ones are kept as history.
      uniqueIndex("agreements_one_active_per_collab_idx")
        .on(t.collabId)
        .where(sql`${t.status} <> 'terminated'`),
      index("agreements_status_created_at_idx").on(t.status, t.createdAt),
      check("agreements_body_hash_sha256", sql`${t.bodyHash} ~ '^[0-9a-f]{64}$'`),
      check(
        "agreements_body_hash_matches_body",
        sql`${t.bodyHash} = encode(sha256(convert_to(${t.renderedBody}, 'UTF8')), 'hex')`,
      ),
      check("agreements_template_version_format", sql`${t.templateVersion} ~ '^v[1-9][0-9]*$'`),
      check(
        "agreements_completed_at_matches_status",
        sql`(${t.status} <> 'signed' OR ${t.completedAt} IS NOT NULL) AND (${t.status} <> 'awaiting_signatures' OR ${t.completedAt} IS NULL)`,
      ),
      check(
        "agreements_terminated_iff_terminated_at",
        sql`(${t.status} = 'terminated') = (${t.terminatedAt} IS NOT NULL)`,
      ),
      check(
        "agreements_pdf_after_completion",
        sql`${t.pdfStorageKey} IS NULL OR ${t.completedAt} IS NOT NULL`,
      ),
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
      /** `agreements.body_hash` of the text the party signed (the app checks they are equal). */
      bodyHash: text("body_hash").notNull(),
      createdAt: createdAt(),
    },
    (t) => [
      unique("agreement_signatures_agreement_user_key").on(t.agreementId, t.userId),
      index("agreement_signatures_user_id_idx").on(t.userId),
      check("agreement_signatures_typed_name_not_blank", nonBlankCheck(t.typedName)),
      check("agreement_signatures_body_hash_sha256", sql`${t.bodyHash} ~ '^[0-9a-f]{64}$'`),
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
      description: text("description"),
      assigneeUserId: uuid("assignee_user_id").references(() => users.id, {
        onDelete: "set null",
      }),
      /** ISO date (YYYY-MM-DD), no time zone: "due on this day". */
      dueDate: date("due_date", { mode: "string" }),
      doneAt: timestamptz("done_at"),
      createdByUserId: uuid("created_by_user_id").references(() => users.id, {
        onDelete: "set null",
      }),
      /** Who ticked the task off; null while open. */
      completedByUserId: uuid("completed_by_user_id").references(() => users.id, {
        onDelete: "set null",
      }),
      position: integer("position").notNull().default(0),
      ...timestamps(),
    },
    (t) => [
      index("tasks_collab_id_position_idx").on(t.collabId, t.position),
      index("tasks_assignee_user_id_idx").on(t.assigneeUserId),
      index("tasks_created_by_user_id_idx").on(t.createdByUserId),
      index("tasks_completed_by_user_id_idx").on(t.completedByUserId),
      check("tasks_title_not_blank", nonBlankCheck(t.title)),
      check("tasks_position_nonnegative", sql`${t.position} >= 0`),
      check(
        "tasks_completed_by_only_when_done",
        sql`${t.doneAt} IS NOT NULL OR ${t.completedByUserId} IS NULL`,
      ),
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
      /** `created_at` of the newest message; null until the first one (inbox order). */
      lastMessageAt: timestamptz("last_message_at"),
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
      check("messages_body_not_blank", nonBlankCheck(t.body)),
      check("messages_attachments_array", sql`jsonb_typeof(${t.attachments}) = 'array'`),
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
      /**
       * Newest message the participant has seen (null: never opened). A row exists for every
       * participant from the thread's creation (`createThread`), so it doubles as the inbox's
       * membership list (§19.24).
       */
      lastReadAt: timestamptz("last_read_at"),
      ...timestamps(),
    },
    (t) => [
      unique("thread_reads_thread_user_key").on(t.threadId, t.userId),
      index("thread_reads_user_id_idx").on(t.userId),
    ],
  ),
)
