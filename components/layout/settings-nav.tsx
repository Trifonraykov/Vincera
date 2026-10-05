"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useRef } from "react"

import { isActivePath, SETTINGS_NAV } from "@/lib/nav"
import { cn } from "@/lib/utils"

/**
 * Tabs across the top of every settings page (§12 Settings: profile, connections, payouts,
 * notifications, account). Scrolls sideways on narrow screens, with the current tab brought into
 * view (Account sits past the edge of a phone); the sidebar and the Me page list the same links.
 */
export function SettingsNav() {
  const pathname = usePathname()
  const navRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const nav = navRef.current
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return
    // Centre it within the strip only; scrollIntoView could also scroll the page.
    nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2
  }, [pathname])

  return (
    <nav
      ref={navRef}
      aria-label="Settings"
      className="-mx-4 overflow-x-auto overscroll-x-contain px-4 sm:mx-0 sm:px-0"
    >
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
