import { Download, Lock, MessagesSquare } from "lucide-react"

import { canPostMessage, type AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import { formatExact, formatRelative } from "@/lib/proposals/display"
import { formatBytes } from "@/lib/storage/limits"
import type { ThreadInfo } from "@/lib/threads/access"
import { listThreadMessages, loadThreadParticipants } from "@/lib/threads/queries"
import { cn } from "@/lib/utils"

import { MarkdownBody } from "./markdown-body"
import { MarkThreadRead } from "./mark-thread-read"
import { MessageComposer } from "./message-composer"

/**
 * A thread's conversation (proposal or collab, CLAUDE.md §19.24): the messages, newest at the
 * bottom like a chat, Markdown rendered through the sanitizer, attachments as download links
 * (through the access-checked redirect route), and the composer while the viewer may post.
 *
 * The caller has already checked `canViewThread(user, thread)`. Reusable: the proposal page renders
 * it, and the collab builder renders it on `/app/collabs/[id]/messages`.
 */
export async function ThreadPanel({
  db,
  thread,
  viewer,
  closedNote,
  className,
}: {
  db: DbOrTx
  thread: ThreadInfo
  viewer: AuthzUser
  /** Shown instead of the composer when the parent is closed. */
  closedNote: string
  className?: string
}) {
  const [{ messages, olderCount }, participants] = await Promise.all([
    listThreadMessages(db, thread.id),
    loadThreadParticipants(db, thread),
  ])
  const at = now()
  const canPost = canPostMessage(viewer, thread)
  const isParticipant = thread.participantUserIds.includes(viewer.id)

  return (
    <div className={cn("space-y-4", className)}>
      {messages.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center">
          <MessagesSquare className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            No messages yet. {canPost ? "Ask a question or talk through the details here." : null}
          </p>
        </div>
      ) : (
        <ol className="space-y-3" aria-label="Messages, oldest first">
          {olderCount > 0 ? (
            <li className="text-center text-xs text-muted-foreground">
              {olderCount} earlier {olderCount === 1 ? "message" : "messages"} not shown
            </li>
          ) : null}
          {messages.map((message) => {
            const mine = message.authorUserId === viewer.id
            const author = participants.get(message.authorUserId)
            return (
              <li
                key={message.id}
                className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}
              >
                <div className="flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {mine ? "You" : (author?.name ?? "Former member")}
                  </span>
                  <time
                    dateTime={message.createdAt.toISOString()}
                    title={formatExact(message.createdAt)}
                  >
                    {formatRelative(message.createdAt, at)}
                  </time>
                </div>
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3.5 py-2.5 sm:max-w-[75%]",
                    mine
                      ? "rounded-br-md bg-primary text-primary-foreground"
                      : "rounded-bl-md bg-muted",
                  )}
                >
                  <MarkdownBody source={message.body} />
                  {message.attachments.length > 0 ? (
                    <ul className="mt-2 space-y-1" aria-label="Attachments">
                      {message.attachments.map((attachment, index) => (
                        <li key={attachment.storageKey}>
                          <a
                            href={`/api/messages/${message.id}/attachments/${index}`}
                            className={cn(
                              "flex min-h-11 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs underline-offset-2 hover:underline",
                              mine ? "border-primary-foreground/30" : "border-border bg-background",
                            )}
                          >
                            <Download className="size-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 truncate">{attachment.filename}</span>
                            <span className="shrink-0 opacity-70">
                              {formatBytes(attachment.sizeBytes)}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {canPost ? (
        <MessageComposer threadId={thread.id} />
      ) : (
        <p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" aria-hidden="true" />
          {isParticipant ? closedNote : "You're reading this conversation as an admin."}
        </p>
      )}
      {isParticipant ? (
        <MarkThreadRead threadId={thread.id} newestMessageId={messages.at(-1)?.id ?? null} />
      ) : null}
    </div>
  )
}
