import { sql } from "drizzle-orm"
import { boolean, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core"

import { createdAt, id, timestamps, timestamptz } from "./columns"
import { disputeKindEnum, disputeStatusEnum } from "./enums"
import { collabs } from "./collab"
import { users } from "./identity"
import type { AuditSnapshot, NotificationPayload } from "./types"

/** Trust & ops (§5). The events table lives in events.ts. */

export const disputes = pgTable(
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
    resolutionNote: text("resolution_note"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    index("disputes_collab_id_idx").on(t.collabId),
    index("disputes_raised_by_user_id_idx").on(t.raisedByUserId),
    index("disputes_resolved_by_idx").on(t.resolvedBy),
    index("disputes_status_idx").on(t.status),
  ],
)

export const notifications = pgTable(
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
    ...timestamps(),
  },
  (t) => [
    index("notifications_user_id_created_at_idx").on(t.userId, t.createdAt.desc()),
    unique("notifications_user_dedupe_key").on(t.userId, t.dedupeKey),
  ],
)

export const notificationPrefs = pgTable(
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
)

/** Append-only (§5, §14): every admin action, including read-only impersonation. */
export const adminAuditLog = pgTable(
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
  ],
)
