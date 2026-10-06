import { BellOff, MessagesSquare, Settings2 } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { z } from "zod"

import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button"
import { NotificationList } from "@/components/notifications/notification-list"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import { countUnreadNotifications, listNotifications } from "@/lib/notifications/center"

export const metadata: Metadata = { title: "Notifications" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** `?before=<iso>_<id>`: the page after the given notification (keyset paging). */
const cursorSchema = z
  .string()
  .regex(/^[^_]+_[0-9a-f-]{36}$/)
  .transform((value) => {
    const [time = "", id = ""] = value.split("_")
    return { createdAt: new Date(time), id }
  })
  .refine((cursor) => !Number.isNaN(cursor.createdAt.getTime()))

/**
 * Inbox → Notifications (§12 `/app/notifications`): the user's in-app notifications, newest first,
 * 50 per page. Opening one marks it read and follows its link; "Mark all as read" clears the bell.
 * Which types arrive here and by email is set in Settings → Notifications.
 */
export default async function NotificationsPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))
  const rawBefore = (await searchParams).before
  const before = cursorSchema.safeParse(Array.isArray(rawBefore) ? rawBefore[0] : rawBefore)
  const db = getDb()
  const [{ items, hasMore }, unread] = await Promise.all([
    listNotifications(db, user.id, { before: before.success ? before.data : undefined }),
    countUnreadNotifications(db, user.id),
  ])
  const last = items.at(-1)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Notifications"
        description={
          unread > 0
            ? `${unread} unread.`
            : "Proposals, agreements and collab updates that need your attention."
        }
        actions={
          <>
            <MarkAllReadButton disabled={unread === 0} />
            <Button asChild variant="ghost" className="h-11 sm:h-9">
              <Link href="/app/settings/notifications">
                <Settings2 aria-hidden="true" />
                Settings
              </Link>
            </Button>
          </>
        }
      />
      <nav aria-label="Inbox" className="flex gap-2 sm:hidden">
        <Button asChild variant="outline" size="sm" className="h-11">
          <Link href="/app/messages">
            <MessagesSquare aria-hidden="true" />
            Messages
          </Link>
        </Button>
      </nav>
      {items.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title={before.success ? "No older notifications" : "You're all caught up"}
          description="When someone sends you a proposal, answers yours, or a collab needs you, it shows up here."
          action={
            before.success ? (
              <Button asChild size="sm" variant="outline" className="h-11 sm:h-8">
                <Link href="/app/notifications">Back to the newest</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <NotificationList items={items} now={now()} />
          {hasMore && last ? (
            <div className="flex justify-center">
              <Button asChild variant="outline" className="h-11 sm:h-9">
                <Link
                  href={`/app/notifications?before=${encodeURIComponent(
                    `${last.createdAt.toISOString()}_${last.id}`,
                  )}`}
                >
                  Older notifications
                </Link>
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
