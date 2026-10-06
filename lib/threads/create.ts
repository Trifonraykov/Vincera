import "server-only"

import { sql } from "drizzle-orm"

import type { Tx } from "@/lib/db/client"
import { threadReads, threads } from "@/lib/db/schema"

/**
 * Message threads (§5): one per proposal and one per collab (CLAUDE.md §19.24 "Threads").
 * Owned by "proposals" (lib/threads/**); `createCollabFromProposal` calls it for the collab
 * thread.
 *
 * Every participant gets a `thread_reads` row at creation (`last_read_at` null = never opened), so
 * the inbox lists a user's threads from `thread_reads` alone and unread counts are one join:
 * messages by others newer than `coalesce(last_read_at, '-infinity')`. Posting a message sets the
 * author's own `last_read_at` and `threads.last_message_at` to the message's `created_at`.
 */

export type CreateThreadInput =
  | { kind: "proposal"; proposalId: string; participantUserIds: readonly string[] }
  | { kind: "collab"; collabId: string; participantUserIds: readonly string[] }

/**
 * Create the thread for a proposal or collab with a read row per participant, in the caller's
 * transaction. Idempotent: an existing thread is returned (and missing read rows are added).
 */
export async function createThread(
  tx: Tx,
  input: CreateThreadInput,
): Promise<{ threadId: string }> {
  const parent =
    input.kind === "proposal"
      ? { kind: "proposal" as const, proposalId: input.proposalId }
      : { kind: "collab" as const, collabId: input.collabId }
  const target = input.kind === "proposal" ? threads.proposalId : threads.collabId

  const [inserted] = await tx
    .insert(threads)
    .values(parent)
    .onConflictDoNothing({ target })
    .returning({ id: threads.id })
  const threadId =
    inserted?.id ??
    (
      await tx
        .select({ id: threads.id })
        .from(threads)
        .where(
          input.kind === "proposal"
            ? sql`${threads.proposalId} = ${input.proposalId}`
            : sql`${threads.collabId} = ${input.collabId}`,
        )
    )[0]?.id
  if (!threadId) throw new Error(`createThread: no thread for ${input.kind}`)

  const participants = [...new Set(input.participantUserIds)]
  if (participants.length > 0) {
    await tx
      .insert(threadReads)
      .values(participants.map((userId) => ({ threadId, userId, lastReadAt: null })))
      .onConflictDoNothing({ target: [threadReads.threadId, threadReads.userId] })
  }
  return { threadId }
}
