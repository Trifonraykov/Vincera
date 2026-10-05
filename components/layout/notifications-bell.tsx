import { Bell } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"

export const NOTIFICATIONS_PATH = "/app/notifications"

/** Header link to `/app/notifications` with an unread badge. Counts arrive in Phase 3. */
export function NotificationsBell({ unread = 0 }: { unread?: number }) {
  const label = unread > 0 ? `Notifications (${unread} unread)` : "Notifications"

  return (
    <Button asChild variant="ghost" size="icon" className="relative">
      <Link href={NOTIFICATIONS_PATH} aria-label={label}>
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </Link>
    </Button>
  )
}
