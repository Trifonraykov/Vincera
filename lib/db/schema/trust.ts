import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { createdAt, id, nonBlankCheck, timestamps, timestamptz, withRLS } from "./columns"
import { disputeKindEnum, disputeOutcomeEnum, disputeStatusEnum } from "./enums"
import { collabs } from "./collab"
import { users } from "./identity"
import type { AuditSnapshot, NotificationPayload } from "./types"

/** Trust & ops (§5). The events table lives in events.ts. */

/**
 * A collab dispute raised by a member (§5, §16 Phase 6; CLAUDE.md §19.38): `open` → `in_review`
 * (an admin picked it up) → `resolved` (note, outcome, resolver). At most one unresolved dispute
 * per member and collab.
 */
export const disputes = withRLS(
  pgTable(
    "disputes",
    {
      id: id(),
      collabId: uuid("collab_id")
        .notNull()
        .references(() => collabs.id, { onDelete: "restrict" }),
      raisedByUserId: uuid("raised_by_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      kind: disputeKindEnum("kind").notNull(),
      description: text("description").notNull(),
      status: disputeStatusEnum("status").notNull().default("open"),
      /** Set when an admin moved it to `in_review` (kept once resolved). */
      inReviewAt: timestamptz("in_review_at"),
      inReviewByUserId: uuid("in_review_by_user_id").references(() => users.id, {
        onDelete: "restrict",
      }),
      resolutionNote: text("resolution_note"),
      resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "restrict" }),
      resolvedAt: timestamptz("resolved_at"),
      outcome: disputeOutcomeEnum("outcome"),
      ...timestamps(),
    },
    (t) => [
      index("disputes_collab_id_idx").on(t.collabId),
      index("disputes_raised_by_user_id_idx").on(t.raisedByUserId),
      index("disputes_resolved_by_idx").on(t.resolvedBy),
      index("disputes_in_review_by_user_id_idx").on(t.inReviewByUserId),
      index("disputes_status_idx").on(t.status),
      index("disputes_status_created_at_idx").on(t.status, t.createdAt),
      uniqueIndex("disputes_one_unresolved_per_member_idx")
        .on(t.collabId, t.raisedByUserId)
        .where(sql`${t.status} <> 'resolved'`),
      check(
        "disputes_description",
        sql`${nonBlankCheck(t.description)} AND char_length(${t.description}) <= 2000`,
      ),
      // in_review and resolved disputes went through review.
      check(
        "disputes_review_columns",
        sql`(${t.status} = 'open') = (${t.inReviewAt} IS NULL) AND (${t.inReviewAt} IS NULL) = (${t.inReviewByUserId} IS NULL)`,
      ),
      check(
        "disputes_resolution_columns",
        sql`CASE WHEN ${t.status} = 'resolved' THEN ${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL AND ${t.outcome} IS NOT NULL AND ${t.resolutionNote} IS NOT NULL AND ${nonBlankCheck(t.resolutionNote)} AND char_length(${t.resolutionNote}) <= 2000 ELSE ${t.resolvedAt} IS NULL AND ${t.resolvedBy} IS NULL AND ${t.outcome} IS NULL AND ${t.resolutionNote} IS NULL END`,
      ),
    ],
  ),
)

export const notifications = withRLS(
  pgTable(
    "notifications",
    {
      id: id(),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      /** Notification type, e.g. "proposal.received"; matches notification_prefs.type. */
      type: text("type").notNull(),
      payload: jsonb("payload")
        .$type<NotificationPayload>()
        .notNull()
        .default(sql`'{}'::jsonb`),
      readAt: timestamptz("read_at"),
      /**
       * Optional idempotency key from `notify({ dedupeKey })`: at most one notification per user and
       * key, so a retried job never notifies twice. Null for notifications without one.
       */
      dedupeKey: text("dedupe_key"),
      /**
       * False for a row that only records a delivery: the user switched in-app notifications off for
       * this type, but `notify` was given a `dedupeKey`, which must still be claimed so the email is
       * not sent again. In-app lists and unread counts show only `in_app = true` rows.
       */
      inApp: boolean("in_app").notNull().default(true),
      ...timestamps(),
    },
    (t) => [
      index("notifications_user_id_created_at_idx").on(t.userId, t.createdAt.desc()),
      // The bell's unread count (§19.24): in-app rows the user has not read.
      index("notifications_user_unread_idx")
        .on(t.userId)
        .where(sql`${t.readAt} IS NULL AND ${t.inApp}`),
      unique("notifications_user_dedupe_key").on(t.userId, t.dedupeKey),
      check("notifications_payload_object", sql`jsonb_typeof(${t.payload}) = 'object'`),
    ],
  ),
)

export const notificationPrefs = withRLS(
  pgTable(
    "notification_prefs",
    {
      id: id(),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      type: text("type").notNull(),
      email: boolean("email").notNull().default(true),
      inApp: boolean("in_app").notNull().default(true),
      ...timestamps(),
    },
    (t) => [unique("notification_prefs_user_type_key").on(t.userId, t.type)],
  ),
)

/** Append-only (§5, §14): every admin action, including read-only impersonation. */
export const adminAuditLog = withRLS(
  pgTable(
    "admin_audit_log",
    {
      id: id(),
      adminUserId: uuid("admin_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      action: text("action").notNull(),
      targetType: text("target_type").notNull(),
      targetId: uuid("target_id"),
      before: jsonb("before").$type<AuditSnapshot>(),
      after: jsonb("after").$type<AuditSnapshot>(),
      createdAt: createdAt(),
    },
    (t) => [
      index("admin_audit_log_admin_user_id_idx").on(t.adminUserId),
      index("admin_audit_log_target_idx").on(t.targetType, t.targetId),
      // The audit log page (Phase 6): newest first, optionally by action.
      index("admin_audit_log_created_at_idx").on(t.createdAt.desc()),
      index("admin_audit_log_action_created_at_idx").on(t.action, t.createdAt.desc()),
    ],
  ),
)

/**
 * Read-only "view as" sessions (§6; CLAUDE.md §19.38): an admin sees the app as `target_user_id`
 * while every mutation is refused. The signed `admin_view_as` cookie names the row; it counts only
 * while `ended_at` is null and `expires_at` is in the future. Start and stop are also written to
 * `admin_audit_log`. At most one open session per admin.
 */
export const impersonationSessions = withRLS(
  pgTable(
    "impersonation_sessions",
    {
      id: id(),
      adminUserId: uuid("admin_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      targetUserId: uuid("target_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      /** Why the admin looks (≤ 500 characters), required: it is part of the audit trail. */
      reason: text("reason").notNull(),
      startedAt: timestamptz("started_at").notNull(),
      expiresAt: timestamptz("expires_at").notNull(),
      endedAt: timestamptz("ended_at"),
      /** `stopped` (the admin), `replaced` (a new view-as started), `expired` (seen after expiry). */
      endReason: text("end_reason"),
      ...timestamps(),
    },
    (t) => [
      index("impersonation_sessions_admin_user_id_idx").on(t.adminUserId, t.startedAt.desc()),
      index("impersonation_sessions_target_user_id_idx").on(t.targetUserId),
      uniqueIndex("impersonation_sessions_one_open_per_admin_idx")
        .on(t.adminUserId)
        .where(sql`${t.endedAt} IS NULL`),
      check("impersonation_sessions_not_self", sql`${t.adminUserId} <> ${t.targetUserId}`),
      check(
        "impersonation_sessions_reason",
        sql`${nonBlankCheck(t.reason)} AND char_length(${t.reason}) <= 500`,
      ),
      check("impersonation_sessions_expiry", sql`${t.expiresAt} > ${t.startedAt}`),
      check(
        "impersonation_sessions_end",
        sql`(${t.endedAt} IS NULL) = (${t.endReason} IS NULL) AND (${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}) AND (${t.endReason} IS NULL OR ${t.endReason} IN ('stopped', 'replaced', 'expired'))`,
      ),
    ],
  ),
)
