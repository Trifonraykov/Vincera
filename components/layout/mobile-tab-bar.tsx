"use client"

import { Menu } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { useSidebar } from "@/components/ui/sidebar"
import { appTabs, isActiveItem, type AppRole } from "@/lib/nav"
import { cn } from "@/lib/utils"

/**
 * Bottom tab bar on phones (below `md`, where the sidebar becomes a sheet), like a native app:
 * the role's main places one thumb-tap away, plus "More", which opens the full menu. It sits above
 * the home indicator (`env(safe-area-inset-bottom)`). While it is on screen, app/globals.css sets
 * `--sticky-bottom` to its height, so page content, sticky form actions and toasts stay clear of it.
 */
export function MobileTabBar({ activeRole }: { activeRole: AppRole }) {
  const pathname = usePathname()
  const { openMobile, setOpenMobile } = useSidebar()
  const tabs = appTabs(activeRole)

  return (
    <nav
      aria-label="Main"
      data-mobile-tab-bar=""
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden"
    >
      <ul className="mx-auto grid h-[var(--app-tab-bar)] max-w-lg grid-cols-5">
        {tabs.map((tab) => {
          const active = isActiveItem(pathname, tab)
          const Icon = tab.icon
          return (
            <li key={tab.href} className="flex">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                    active && "bg-accent",
                  )}
                >
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                {tab.title}
              </Link>
            </li>
          )
        })}
        <li className="flex">
          <button
            type="button"
            onClick={() => setOpenMobile(!openMobile)}
            aria-expanded={openMobile}
            aria-label="More: open the full menu"
            className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          >
            <span className="flex h-7 w-12 items-center justify-center rounded-full">
              <Menu className="size-5" aria-hidden="true" />
            </span>
            More
          </button>
        </li>
      </ul>
    </nav>
  )
}
