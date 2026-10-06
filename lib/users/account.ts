import "server-only"

import { count, eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { sessions, users } from "@/lib/db/schema"

/**
 * Settings → Account (§12): the account fields a user changes themselves. Data export and
 * deletion (§14) arrive in Phase 6.
 */

/** Rename the account (the name on emails and in the app; profiles keep their display names). */
export async function updateAccountName(
  database: DbOrTx,
  input: { userId: string; name: string },
): Promise<boolean> {
  const updated = await database
    .update(users)
    .set({ name: input.name })
    .where(eq(users.id, input.userId))
    .returning({ id: users.id })
  return updated.length > 0
}

/** How many devices/browsers are signed in (live database sessions). */
export async function countSessions(database: DbOrTx, userId: string): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(sessions)
    .where(eq(sessions.userId, userId))
  return row?.total ?? 0
}

/**
 * "Sign out everywhere": delete every database session of the user (§19.9: sessions are database
 * rows, so this takes effect on the next request of every device, this one included).
 */
export async function deleteAllSessions(database: DbOrTx, userId: string): Promise<number> {
  const deleted = await database
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ token: sessions.sessionToken })
  return deleted.length
}
