import { Bell, MessagesSquare } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { InboxList } from "@/components/messages/inbox-list"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { countUnreadNotifications } from "@/lib/notifications/center"
import { INBOX_LIMIT, listInbox } from "@/lib/threads/queries"

export const metadata: Metadata = { title: "Messages" }

/**
 * Inbox → Messages (§12 `/app/messages`): every proposal and collab thread the user takes part
 * in (their `thread_reads` rows), newest activity first, with unread counts. On phones it is the
 * Inbox tab, with a way to the notifications next to it.
 */
export default async function MessagesPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))
  const db = getDb()
  const [threads, unreadNotifications] = await Promise.all([
    listInbox(db, user.id),
    countUnreadNotifications(db, user.id),
  ])
  const unread = threads.reduce((sum, thread) => sum + thread.unread, 0)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Messages"
        description={
          unread > 0
            ? `${unread} unread ${unread === 1 ? "message" : "messages"}.`
            : "Conversations about your proposals and collabs."
        }
        actions={
          <Button asChild variant="outline" className="h-11 sm:h-9">
            <Link href="/app/notifications">
              <Bell aria-hidden="true" />
              Notifications
              {unreadNotifications > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
                  {unreadNotifications}
                </span>
              ) : null}
            </Link>
          </Button>
        }
      />
      {threads.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No conversations yet"
          description="Every proposal and collab gets its own conversation. Send or answer a proposal to start one."
          action={
            <Button asChild size="sm" className="h-11 sm:h-8">
              <Link href="/app/proposals">See your proposals</Link>
            </Button>
          }
        />
      ) : (
        <>
          <InboxList threads={threads} now={now()} />
          {threads.length >= INBOX_LIMIT ? (
            <p className="text-center text-sm text-muted-foreground">
              Showing the {INBOX_LIMIT} most recent conversations.
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
