import "server-only"

import { eq } from "drizzle-orm"
import { z } from "zod"

import { canManageOwnAccount, canPostMessage, canViewThread } from "@/lib/auth/authz"
import { loadCollabTitle } from "@/lib/collabs/queries"
import { proposals } from "@/lib/db/schema"
import { messageBodySchema } from "@/lib/messages/fields"
import { MESSAGE_MESSAGES, postMessage } from "@/lib/messages/post"
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications/center"
import { describeNotification } from "@/lib/notifications/describe"
import { loadProposalTarget, targetRefOf } from "@/lib/proposals/queries"
import { loadThreadAccess } from "@/lib/threads/access"
import {
  listInbox,
  listThreadMessages,
  loadThreadParticipants,
  markThreadRead,
} from "@/lib/threads/queries"

import { revalidateApp } from "../context"
import { forbidden, MobileApiError } from "../errors"
import { endpoint, parseForm, uuidParam, type Endpoint } from "../router"
import {
  inboxOutput,
  markAllReadOutput,
  markReadInput,
  markReadOutput,
  notificationListOutput,
  okSchema,
  postMessageInput,
  postMessageOutput,
  threadOutput,
} from "../schemas"

/**
 * Inbox: threads, messages and notifications (§12 `/app/messages`, `/app/notifications`;
 * CLAUDE.md §19.26). Authorization always comes from the thread's parent (`canViewThread`,
 * `canPostMessage`); posting goes through lib/messages/post.ts (lock, re-check, `message.sent`
 * without the body, the collab's activity). The app posts text only; attachments stay on the web.
 */

const threadNotFound = () => new MobileApiError(404, "not_found", MESSAGE_MESSAGES.notFound)

/** `?before=<iso>_<id>`, the web notifications page's keyset cursor. */
const notificationCursor = z
  .string()
  .regex(/^[^_]+_[0-9a-f-]{36}$/)
  .transform((value) => {
    const [time = "", id = ""] = value.split("_")
    return { createdAt: new Date(time), id }
  })
  .refine((cursor) => !Number.isNaN(cursor.createdAt.getTime()))

/** The parent's id from an inbox row's page link (`/app/proposals/<id>…`, `/app/collabs/<id>…`). */
function parentIdOf(href: string): string | null {
  return href.match(/^\/app\/(?:proposals|collabs)\/([0-9a-f-]{36})/)?.[1] ?? null
}

export const inboxEndpoints: Endpoint[] = [
  endpoint({
    method: "GET",
    path: "/inbox",
    auth: "onboarded",
    output: inboxOutput,
    run: async ({ db, user }) => {
      if (!canManageOwnAccount(user)) throw forbidden()
      const [threads, unreadNotifications] = await Promise.all([
        listInbox(db, user.id),
        countUnreadNotifications(db, user.id),
      ])
      return {
        threads: threads.map((thread) => ({ ...thread, parentId: parentIdOf(thread.href) })),
        unreadNotifications,
      }
    },
  }),
  endpoint({
    method: "GET",
    path: "/threads/:id",
    auth: "onboarded",
    output: threadOutput,
    run: async ({ db, user, params }) => {
      const thread = await loadThreadAccess(db, uuidParam(params))
      if (!thread || !canViewThread(user, thread)) throw threadNotFound()
      const [{ messages, olderCount }, participants] = await Promise.all([
        listThreadMessages(db, thread.id),
        loadThreadParticipants(db, thread),
      ])
      let title = "Conversation"
      if (thread.collabId) title = await loadCollabTitle(db, thread.collabId)
      else if (thread.proposalId) {
        const [proposal] = await db
          .select({ ideaId: proposals.ideaId, productId: proposals.productId })
          .from(proposals)
          .where(eq(proposals.id, thread.proposalId))
        const target = proposal ? await loadProposalTarget(db, targetRefOf(proposal)) : null
        if (target) title = target.title
      }
      return {
        id: thread.id,
        kind: thread.kind,
        parentId: thread.collabId ?? thread.proposalId,
        title,
        participants: [...participants.values()],
        messages: messages.map((message) => ({
          ...message,
          // File names and sizes only; downloads stay on the web (signed URLs, §14).
          attachments: message.attachments.map((file) => ({
            filename: file.filename,
            sizeBytes: file.sizeBytes,
          })),
        })),
        olderCount,
        canPost: canPostMessage(user, thread),
      }
    },
  }),
  endpoint({
    method: "POST",
    path: "/threads/:id/messages",
    auth: "onboarded",
    input: postMessageInput,
    output: postMessageOutput,
    run: async ({ db, user, params, input }) => {
      const threadId = uuidParam(params)
      // The web's `authorizePost` (lib/messages/actions.ts).
      const thread = await loadThreadAccess(db, threadId)
      if (!thread || !thread.participantUserIds.includes(user.id)) throw threadNotFound()
      if (!canPostMessage(user, thread)) {
        throw new MobileApiError(422, "refused", MESSAGE_MESSAGES.closed[thread.kind])
      }
      const body = parseForm(messageBodySchema, input.body)
      const result = await postMessage(db, user, { threadId, body, attachments: [] })
      revalidateApp()
      return { messageId: result.messageId }
    },
  }),
  endpoint({
    method: "POST",
    path: "/threads/:id/read",
    auth: "onboarded",
    input: markReadInput,
    output: markReadOutput,
    run: async ({ db, user, params, input }) => {
      const thread = await loadThreadAccess(db, uuidParam(params))
      if (!thread || !canViewThread(user, thread)) throw threadNotFound()
      const changed = await markThreadRead(db, user.id, thread.id, input.messageId)
      if (changed) revalidateApp()
      return { changed }
    },
  }),
  endpoint({
    method: "GET",
    path: "/notifications",
    auth: "onboarded",
    query: z.object({ before: notificationCursor.optional() }),
    output: notificationListOutput,
    run: async ({ db, user, query }) => {
      if (!canManageOwnAccount(user)) throw forbidden()
      const [page, unread] = await Promise.all([
        listNotifications(db, user.id, { before: query.before }),
        countUnreadNotifications(db, user.id),
      ])
      const last = page.items.at(-1)
      return {
        items: page.items.map((item) => {
          const text = describeNotification(item)
          return {
            id: item.id,
            type: item.type,
            title: text.title,
            body: text.detail,
            href: item.href,
            readAt: item.readAt,
            createdAt: item.createdAt,
          }
        }),
        nextCursor: page.hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
        unread,
      }
    },
  }),
  endpoint({
    method: "POST",
    path: "/notifications/:id/read",
    auth: "onboarded",
    output: okSchema,
    run: async ({ db, user, params }) => {
      if (!canManageOwnAccount(user)) throw forbidden()
      // Scoped to the user's own rows, like the web's `openNotificationAction`.
      await markNotificationRead(db, user.id, uuidParam(params))
      revalidateApp()
      return { ok: true as const }
    },
  }),
  endpoint({
    method: "POST",
    path: "/notifications/read-all",
    auth: "onboarded",
    output: markAllReadOutput,
    run: async ({ db, user }) => {
      if (!canManageOwnAccount(user)) throw forbidden()
      const marked = await markAllNotificationsRead(db, user.id)
      revalidateApp()
      return { marked }
    },
  }),
]
