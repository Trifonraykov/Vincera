"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { activeTab, type MobileTab } from "@/lib/nav"
import { cn } from "@/lib/utils"

/**
 * The bottom tab bar on phones (below `md`; desktop keeps the sidebar), like a native app: Home,
 * Discover, Collabs, Inbox and Me (`appTabs` in lib/nav.ts; built pages stand in for unbuilt
 * ones). Me holds every other page, so it lights up for any app page outside the other tabs.
 *
 * It sits above the home indicator (`env(safe-area-inset-bottom)`). While it is on screen,
 * app/globals.css sets `--sticky-bottom` to its height, so page content, sticky form actions
 * (FormActions) and toasts stay clear of it. The Inbox tab shows `unread` as a badge.
 */
export function MobileTabBar({
  tabs,
  unread = 0,
}: {
  tabs: readonly MobileTab[]
  unread?: number
}) {
  const pathname = usePathname()
  const current = activeTab(pathname, tabs)

  return (
    <nav
      aria-label="Main"
      data-mobile-tab-bar=""
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur select-none supports-[backdrop-filter]:bg-background/80 md:hidden"
    >
      <ul
        className="mx-auto grid h-[var(--app-tab-bar)] max-w-lg"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((tab) => {
          const active = current?.href === tab.href
          const Icon = tab.icon
          const badge =
            tab.showsUnread && unread > 0 ? (unread > 99 ? "99+" : String(unread)) : null
          return (
            <li key={tab.href} className="flex min-w-0">
              <Link
                href={tab.href}
                aria-current={active ? (pathname === tab.href ? "page" : "true") : undefined}
                aria-label={badge ? `${tab.title} (${unread} unread)` : undefined}
                className={cn(
                  "flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] leading-tight font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "relative flex h-7 w-12 items-center justify-center rounded-full transition-colors motion-reduce:transition-none",
                    active && "bg-accent",
                  )}
                >
                  <Icon className="size-5" aria-hidden="true" />
                  {badge ? (
                    <span
                      aria-hidden="true"
                      className="absolute -top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground"
                    >
                      {badge}
                    </span>
                  ) : null}
                </span>
                <span className="max-w-full truncate px-0.5">{tab.title}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
