import "server-only"

import { eq } from "drizzle-orm"

import { canViewThread, type AuthzUser } from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import { messages } from "@/lib/db/schema"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"
import { loadThreadAccess } from "@/lib/threads/access"

import { ATTACHMENT_URL_TTL_SECONDS, attachmentDownloadUrl } from "./attachments"
import { MESSAGE_ATTACHMENT_PREFIX } from "./fields"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } })
}

/**
 * `GET /api/messages/<messageId>/attachments/<index>`: a redirect (302) to a 5-minute signed URL
 * that downloads the file, for people who may read the thread (`canViewThread`: its participants
 * and admins). Everything else, signed out included, answers 404, so the route reveals nothing
 * about which messages exist.
 */
export async function attachmentResponse(
  input: { messageId: string; index: string },
  deps: { db: DbOrTx; user: AuthzUser | null; storage?: ObjectStorage },
): Promise<Response> {
  if (!deps.user || !UUID_PATTERN.test(input.messageId) || !/^\d{1,2}$/.test(input.index)) {
    return notFound()
  }
  const [message] = await deps.db
    .select({ threadId: messages.threadId, attachments: messages.attachments })
    .from(messages)
    .where(eq(messages.id, input.messageId))
  if (!message) return notFound()
  const thread = await loadThreadAccess(deps.db, message.threadId)
  if (!thread || !canViewThread(deps.user, thread)) return notFound()
  const attachment = message.attachments[Number(input.index)]
  // Stored keys always live under their thread; anything else is never served.
  if (
    !attachment ||
    !attachment.storageKey.startsWith(`${MESSAGE_ATTACHMENT_PREFIX}/${message.threadId}/`)
  ) {
    return notFound()
  }
  const url = await attachmentDownloadUrl(attachment, deps.storage ?? getStorage())
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": `private, max-age=${Math.floor(ATTACHMENT_URL_TTL_SECONDS / 2)}`,
      "Referrer-Policy": "no-referrer",
    },
  })
}
