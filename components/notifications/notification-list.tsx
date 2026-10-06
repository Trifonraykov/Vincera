import { Banknote, Bell, Handshake, ListChecks, Rocket, Send, type LucideIcon } from "lucide-react"

import { openNotificationFormAction } from "@/lib/notifications/actions"
import type { NotificationItem } from "@/lib/notifications/center"
import { describeNotification, type NotificationTone } from "@/lib/notifications/describe"
import { formatExact, formatRelative } from "@/lib/proposals/display"
import { cn } from "@/lib/utils"

const ICONS: Record<NotificationTone, LucideIcon> = {
  account: Bell,
  proposal: Send,
  collab: Handshake,
  task: ListChecks,
  launch: Rocket,
  money: Banknote,
}

/**
 * The notifications center's list (`/app/notifications`): each row opens the notification, which
 * marks it read and goes where it leads (a server action, so opening works without JavaScript and
 * a prefetch never marks anything read). Unread rows are bold with a dot and say so to screen
 * readers.
 */
export function NotificationList({
  items,
  now,
}: {
  items: readonly NotificationItem[]
  now: Date
}) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
      {items.map((item) => {
        const text = describeNotification(item)
        const Icon = ICONS[text.tone]
        const unread = item.readAt === null
        return (
          <li key={item.id}>
            <form action={openNotificationFormAction}>
              <input type="hidden" name="id" value={item.id} />
              <button
                type="submit"
                className={cn(
                  "flex min-h-11 w-full items-start gap-3 p-4 text-left transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
                  unread && "bg-primary/[0.03]",
                )}
              >
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className={cn("block", unread ? "font-semibold" : "font-medium")}>
                    {unread ? <span className="sr-only">Unread: </span> : null}
                    {text.title}
                  </span>
                  {text.detail ? (
                    <span className="block text-sm text-muted-foreground">{text.detail}</span>
                  ) : null}
                  <time
                    dateTime={item.createdAt.toISOString()}
                    title={formatExact(item.createdAt)}
                    className="block text-xs text-muted-foreground"
                  >
                    {formatRelative(item.createdAt, now)}
                  </time>
                </span>
                {unread ? (
                  <span
                    className="mt-2 size-2.5 shrink-0 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            </form>
          </li>
        )
      })}
    </ul>
  )
}
