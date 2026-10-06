import Link from "next/link"

import type { AppRole } from "@/lib/nav"
import { cn } from "@/lib/utils"

export type DiscoverTab = "for-you" | "builders" | "creators" | "briefs" | "saved"

const TABS: Record<AppRole, { id: DiscoverTab; label: string; href: string }[]> = {
  creator: [
    { id: "for-you", label: "For you", href: "/app/discover" },
    { id: "builders", label: "Builders", href: "/app/discover/builders" },
    { id: "saved", label: "Saved", href: "/app/discover/saved" },
  ],
  builder: [
    { id: "for-you", label: "For you", href: "/app/discover" },
    { id: "briefs", label: "Briefs", href: "/app/discover/briefs" },
    { id: "creators", label: "Creators", href: "/app/discover/creators" },
    { id: "saved", label: "Saved", href: "/app/discover/saved" },
  ],
}

/**
 * The Discover pages of a role, as link tabs (each its own URL, works without JavaScript). On
 * phones they are the way between the Discover pages (the tab bar has one Discover tab); the row
 * scrolls sideways inside itself and every tab is 44 px tall. Saved (a v1 route, §12) is reached
 * from here: the menus keep it hidden until v1.
 */
export function DiscoverTabs({ role, current }: { role: AppRole; current: DiscoverTab }) {
  return (
    <nav
      aria-label="Discover"
      className="-mx-4 [scrollbar-width:none] overflow-x-auto px-4 sm:mx-0 sm:px-0"
    >
      <ul className="flex min-w-max gap-1 border-b">
        {TABS[role].map((tab) => {
          const active = tab.id === current
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-11 items-center border-b-2 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
