import { sql } from "drizzle-orm"
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core"

import { now } from "../../clock"
import { id, timestamptz, withRLS } from "./columns"
import { users } from "./identity"
import type { EventContext, JsonObject } from "./types"

/**
 * Business event log (§11): append-only, the product's long-term dataset. Written only through
 * `track()` in lib/events/track.ts; DB triggers block UPDATE, DELETE and TRUNCATE.
 * `type` and `subject_type` are plain text, validated by the typed union in lib/events/types.ts,
 * so adding an event type never needs a migration.
 */
export const events = withRLS(
  pgTable(
    "events",
    {
      id: id(),
      type: text("type").notNull(),
      occurredAt: timestamptz("occurred_at").notNull().defaultNow().$defaultFn(now),
      actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
      subjectType: text("subject_type"),
      subjectId: uuid("subject_id"),
      properties: jsonb("properties")
        .$type<JsonObject>()
        .notNull()
        .default(sql`'{}'::jsonb`),
      context: jsonb("context")
        .$type<EventContext>()
        .notNull()
        .default(sql`'{}'::jsonb`),
    },
    (t) => [
      index("events_type_occurred_at_idx").on(t.type, t.occurredAt),
      index("events_subject_id_idx").on(t.subjectId),
      index("events_actor_user_id_idx").on(t.actorUserId),
      // /admin/events (Phase 7): newest first across every type, keyset (occurred_at, id).
      index("events_occurred_at_id_idx").on(t.occurredAt.desc(), t.id.desc()),
      // Collab analytics funnel (§10): one launch's events of a type over time.
      index("events_subject_type_occurred_at_idx").on(t.subjectId, t.type, t.occurredAt),
      check("events_subject_complete", sql`(${t.subjectType} IS NULL) = (${t.subjectId} IS NULL)`),
    ],
  ),
)
