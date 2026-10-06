import "server-only"

import { eq, sql } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { canPostMessage, type AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { touchCollabActivity } from "@/lib/collabs/activity"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { messages, threadReads, threads, type MessageAttachment } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { rateLimit } from "@/lib/ratelimit"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"
import { loadThreadAccess, type ThreadInfo } from "@/lib/threads/access"

import { deleteAttachmentObjects, promoteAttachments } from "./attachments"
import type { AttachmentRef } from "./fields"

/**
 * Post a message (CLAUDE.md §19.24 "Posting"): the `messages` rate limit (§14), the attachments
 * copied into the thread, then one transaction: the message, `threads.last_message_at` and the
 * author's own `last_read_at` (= the message's `created_at`), the collab's activity for collab
 * threads, and `message.sent { thread_kind, attachment_count }` (never the body, §11). No
 * notification per message: unread messages show in the Inbox badge and on `/app/messages`.
 */

export const MESSAGE_MESSAGES = {
  notFound: "We couldn't find that conversation.",
  closed: {
    proposal: "This proposal is closed, so its conversation is read-only.",
    collab: "This collab has ended, so its conversation is read-only.",
  },
  rateLimited: "You're sending messages very quickly. Wait a minute, then try again.",
} as const

/** Why a post is refused: the thread is unknown to the user, or its parent is closed. */
function refusal(user: AuthzUser, thread: ThreadInfo | null): ActionError {
  if (!thread || !thread.participantUserIds.includes(user.id)) {
    return new ActionError(MESSAGE_MESSAGES.notFound)
  }
  return new ActionError(MESSAGE_MESSAGES.closed[thread.kind])
}

export type PostMessageInput = {
  threadId: string
  body: string
  attachments: readonly AttachmentRef[]
}

export async function postMessage(
  database: DbOrTx,
  user: AuthzUser,
  input: PostMessageInput,
  storage: ObjectStorage = getStorage(),
): Promise<{ messageId: string; createdAt: Date }> {
  const thread = await loadThreadAccess(database, input.threadId)
  if (!thread || !canPostMessage(user, thread)) throw refusal(user, thread)
  const limit = await rateLimit("messages", user.id)
  if (!limit.success) throw new ActionError(MESSAGE_MESSAGES.rateLimited)

  const attachments: MessageAttachment[] = await promoteAttachments(
    user.id,
    thread.id,
    input.attachments,
    storage,
  )
  try {
    return await withTransaction(async (tx) => {
      // Serializes posts to one thread, so `last_message_at` follows the newest message.
      await tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, thread.id))
        .for("update")
      // The parent may have closed while the files were copied.
      const current = await loadThreadAccess(tx, thread.id)
      if (!current || !canPostMessage(user, current)) throw refusal(user, current)

      const createdAt = now()
      const [message] = await tx
        .insert(messages)
        .values({
          threadId: thread.id,
          authorUserId: user.id,
          body: input.body,
          attachments,
          createdAt,
        })
        .returning({ id: messages.id, createdAt: messages.createdAt })
      if (!message) throw new Error("postMessage: no message returned")
      await tx
        .update(threads)
        .set({
          // greatest() skips NULL: the first message sets it.
          lastMessageAt: sql`greatest(${threads.lastMessageAt}, ${message.createdAt.toISOString()}::timestamptz)`,
        })
        .where(eq(threads.id, thread.id))
      // The author has read their own message (and everything before it).
      await tx
        .insert(threadReads)
        .values({ threadId: thread.id, userId: user.id, lastReadAt: message.createdAt })
        .onConflictDoUpdate({
          target: [threadReads.threadId, threadReads.userId],
          set: {
            lastReadAt: sql`greatest(${threadReads.lastReadAt}, excluded.last_read_at)`,
          },
        })
      if (current.kind === "collab" && current.collabId) {
        await touchCollabActivity(tx, current.collabId, message.createdAt)
      }
      await track(
        "message.sent",
        {
          actorUserId: user.id,
          subjectType: "thread",
          subjectId: thread.id,
          properties: { thread_kind: current.kind, attachment_count: attachments.length },
        },
        tx,
      )
      return { messageId: message.id, createdAt: message.createdAt }
    }, database)
  } catch (error) {
    await deleteAttachmentObjects(attachments, storage)
    throw error
  }
}
