"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canPostMessage, canViewThread, type AuthzUser } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { rateLimit } from "@/lib/ratelimit"
import { loadThreadAccess } from "@/lib/threads/access"
import { markThreadRead } from "@/lib/threads/queries"

import { createAttachmentUpload, discardMessageUploads } from "./attachments"
import { attachmentRefsSchema, messageBodySchema } from "./fields"
import { MESSAGE_MESSAGES, postMessage } from "./post"

/**
 * Message server actions (§4). Authorization comes from the thread's parent (`canPostMessage`,
 * `canViewThread`); the posting itself re-checks under the thread's lock (./post.ts).
 */

const threadId = z.uuid({ error: "That conversation link is not valid." })

async function authorizePost(user: AuthzUser, id: string): Promise<boolean> {
  const thread = await loadThreadAccess(getDb(), id)
  if (!thread || !thread.participantUserIds.includes(user.id)) {
    throw new ActionError(MESSAGE_MESSAGES.notFound)
  }
  if (!canPostMessage(user, thread)) throw new ActionError(MESSAGE_MESSAGES.closed[thread.kind])
  return true
}

/**
 * Send a message. The body and attachments are parsed in `run`, so a refused send (an empty
 * message, too many files) still deletes the files the composer uploaded for it.
 */
export const postMessageAction = defineAction({
  name: "messages.post",
  input: z.object({ threadId, body: z.unknown(), attachments: z.unknown() }),
  authorize: (user, input) => authorizePost(user, input.threadId),
  run: async ({ input, user, db }) => {
    const refs = attachmentRefsSchema.safeParse(input.attachments)
    try {
      const body = messageBodySchema.safeParse(input.body)
      if (!body.success || !refs.success) {
        throw new ActionError("Please check your message and try again.", {
          fieldErrors: {
            ...(body.success
              ? {}
              : { body: [body.error.issues[0]?.message ?? "Write a message."] }),
            ...(refs.success
              ? {}
              : { attachments: [refs.error.issues[0]?.message ?? "Attach your files again."] }),
          },
        })
      }
      const result = await postMessage(db, user, {
        threadId: input.threadId,
        body: body.data,
        attachments: refs.data,
      })
      revalidatePath("/app", "layout")
      return { messageId: result.messageId }
    } finally {
      await discardMessageUploads(user.id, refs.success ? refs.data : [])
    }
  },
})

/** A signed upload URL for one attachment (§14: 25 MB, allow-listed types; 20 per hour). */
export const requestAttachmentUploadAction = defineAction({
  name: "messages.request_attachment_upload",
  input: z.object({
    threadId,
    contentType: z.string().max(200),
    sizeBytes: z.number().int().nonnegative(),
  }),
  authorize: (user, input) => authorizePost(user, input.threadId),
  run: async ({ input, user }) => {
    const limit = await rateLimit("message-attachment-upload", user.id, {
      limit: 20,
      window: "1 h",
    })
    if (!limit.success) {
      throw new ActionError("You've attached a lot of files in the last hour. Try again later.")
    }
    return createAttachmentUpload({
      userId: user.id,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    })
  },
})

/**
 * Opening a thread marks it read up to the newest message the page showed (`messageId`; the page
 * calls this once it shows the messages, so a prefetch never marks anything read, and a message
 * that arrived after the render stays unread). Refreshes the shell's unread counts.
 */
export const markThreadReadAction = defineAction({
  name: "messages.mark_read",
  input: z.object({ threadId, messageId: z.uuid() }),
  authorize: async (user, input) => {
    const thread = await loadThreadAccess(getDb(), input.threadId)
    return thread !== null && canViewThread(user, thread)
  },
  run: async ({ input, user, db }) => {
    const changed = await markThreadRead(db, user.id, input.threadId, input.messageId)
    if (changed) revalidatePath("/app", "layout")
    return { changed }
  },
})
