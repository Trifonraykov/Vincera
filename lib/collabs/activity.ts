import "server-only"

import { eq, sql } from "drizzle-orm"

import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import { collabs } from "@/lib/db/schema"

/**
 * Record member activity on a collab (CLAUDE.md §19.24 "Collabs"): a message in its thread, a task
 * created, completed or reopened, a signature, a stage change. `reminders/stalled` nudges collabs
 * whose `last_activity_at` is 7+ days old. Call it in the transaction of the activity. Never moves
 * the time backwards.
 */
export async function touchCollabActivity(
  database: DbOrTx,
  collabId: string,
  at: Date = now(),
): Promise<void> {
  await database
    .update(collabs)
    .set({
      lastActivityAt: sql`greatest(${collabs.lastActivityAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(eq(collabs.id, collabId))
}
