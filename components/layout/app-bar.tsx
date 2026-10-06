"use client"

import { ChevronLeft } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

import { LogoMark } from "@/components/shared/logo"
import { ThemeToggle } from "@/components/shared/theme-toggle"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { shellBackHref, shellTitle, type MobileTab } from "@/lib/nav"
import { cn } from "@/lib/utils"

import { useAppBarOptions } from "./app-bar-slot"

/**
 * The compact top app bar on phones (below `md`; desktop keeps the sidebar and its header):
 * back button on nested pages, the page title, and one action slot. Pages fill the slots with
 * `<AppBarSlot>` (app-bar-slot.tsx); without one, the title and back target come from the menus
 * (lib/nav.ts `shellTitle`, `shellBackHref`).
 *
 * On a tab's own page the title fades in as the page's large heading scrolls away (iOS-style, where
 * scroll-driven animations exist and motion is welcome; app/globals.css), with the logo mark in
 * the back button's place. The admin bar has the admin menu button there instead. The bar pads by
 * the top safe area, so nothing hides under a notch or status bar.
 */
export function AppBar({
  variant,
  tabs,
  appName,
  trailing,
}: {
  variant: "app" | "admin"
  /** The phone tabs (app only): their pages have no back button. */
  tabs: readonly MobileTab[]
  appName: string
  /** Shell controls after the page action (the notifications bell). */
  trailing?: ReactNode
}) {
  const pathname = usePathname()
  const options = useAppBarOptions()
  const title = options?.title ?? shellTitle(pathname) ?? appName
  const back = options?.back !== undefined ? options.back : shellBackHref(pathname, tabs)
  const topLevel = back === null

  return (
    <header
      data-app-bar=""
      className="sticky top-0 z-30 border-b bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur select-none supports-[backdrop-filter]:bg-background/75 md:hidden"
    >
      <div className="flex h-14 items-center gap-1 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))]">
        {back ? (
          <Button asChild variant="ghost" size="icon" className="size-11 shrink-0">
            <Link href={back} aria-label="Back">
              <ChevronLeft className="size-6" aria-hidden="true" />
            </Link>
          </Button>
        ) : variant === "admin" ? (
          <SidebarTrigger className="size-11 shrink-0" aria-label="Open the admin menu" />
        ) : (
          <Link
            href="/app"
            aria-label={`${appName} home`}
            className="flex size-11 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <LogoMark />
          </Link>
        )}
        <p
          data-app-bar-title=""
          data-collapse-on-scroll={topLevel && variant === "app" ? "" : undefined}
          className={cn("min-w-0 flex-1 truncate text-base font-semibold", !back && "pl-1")}
        >
          {title}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {options?.action}
          {trailing}
          {variant === "admin" ? <ThemeToggle /> : null}
        </div>
      </div>
    </header>
  )
}
