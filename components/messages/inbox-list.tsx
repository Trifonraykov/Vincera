import { ChevronRight, Handshake, Send } from "lucide-react"
import Link from "next/link"

import { formatExact, formatRelative, PROPOSAL_STATUS_LABELS } from "@/lib/proposals/display"
import type { InboxThread } from "@/lib/threads/queries"
import { cn } from "@/lib/utils"

const STAGE_LABELS: Record<string, string> = {
  agreement: "Agreement",
  building: "Building",
  launch_review: "Launch review",
  live: "Live",
  ended: "Ended",
}

/**
 * The inbox (`/app/messages`): one row per proposal or collab thread, newest activity first, with
 * the newest message and an unread count. Rows are links at least 44 px tall.
 */
export function InboxList({ threads, now }: { threads: readonly InboxThread[]; now: Date }) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
      {threads.map((thread) => {
        const Icon = thread.kind === "proposal" ? Send : Handshake
        const unread = thread.unread > 0
        const context =
          thread.kind === "proposal"
            ? `Proposal · ${PROPOSAL_STATUS_LABELS[thread.parentStatus as keyof typeof PROPOSAL_STATUS_LABELS] ?? ""}`
            : `Collab · ${STAGE_LABELS[thread.parentStatus] ?? ""}`
        return (
          <li key={thread.id}>
            <Link
              href={thread.href}
              className="flex min-h-11 items-start gap-3 p-4 transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate", unread ? "font-semibold" : "font-medium")}>
                    {thread.with.length > 0 ? thread.with.join(", ") : thread.title}
                  </span>
                  {thread.lastMessageAt ? (
                    <time
                      dateTime={thread.lastMessageAt.toISOString()}
                      title={formatExact(thread.lastMessageAt)}
                      className="shrink-0 text-xs text-muted-foreground"
                    >
                      {formatRelative(thread.lastMessageAt, now)}
                    </time>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {thread.title} · {context}
                </span>
                <span
                  className={cn(
                    "block truncate text-sm",
                    unread ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {thread.preview
                    ? `${thread.previewByUser ? "You: " : ""}${thread.preview}`
                    : "No messages yet"}
                </span>
              </span>
              {unread ? (
                <span
                  className="mt-1 flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs leading-5 font-medium text-primary-foreground"
                  aria-label={`${thread.unread} unread`}
                >
                  {thread.unread > 99 ? "99+" : thread.unread}
                </span>
              ) : (
                <ChevronRight
                  className="mt-2 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
