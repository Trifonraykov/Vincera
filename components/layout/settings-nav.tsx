"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { isActivePath, SETTINGS_NAV } from "@/lib/nav"
import { cn } from "@/lib/utils"

/**
 * Tabs across the top of every settings page (§12 Settings: profile, connections, payouts,
 * notifications, account). Scrolls sideways on narrow screens; the sidebar lists the same links.
 */
export function SettingsNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Settings" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b">
        {SETTINGS_NAV.map((link) => {
          const active = isActivePath(pathname, link.href)
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {link.title}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
