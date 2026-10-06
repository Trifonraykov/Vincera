"use client"

import type { ReactNode } from "react"

import { InstallPrompt } from "@/components/pwa/install-prompt"
import { PwaRuntime } from "@/components/pwa/pwa-runtime"
import { ThemeToggle } from "@/components/shared/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { appTabs, isBuiltRoute } from "@/lib/nav"

import { AppBar } from "./app-bar"
import { AppBarProvider } from "./app-bar-slot"
import { AppSidebar } from "./app-sidebar"
import { MobileTabBar } from "./mobile-tab-bar"
import { NOTIFICATIONS_PATH, NotificationsBell } from "./notifications-bell"
import type { ShellProps } from "./types"

/**
 * Signed-in shell for `/app` and `/admin`. Purely presentational: layouts pass the user, roles,
 * counts and server actions in.
 *
 * - Desktop (`md` and up): the collapsible sidebar and a top bar with the sidebar toggle,
 *   notifications and theme switch.
 * - Phones: like a native app. A compact top app bar (title, back, one action; `AppBar`, filled by
 *   pages through `<AppBarSlot>`) and, in the app, a bottom tab bar (`MobileTabBar`: Home,
 *   Discover, Collabs, Inbox, Me). No sidebar: everything else is on the Me page (`/app/me`). The
 *   admin area keeps its menu in a sheet behind the app bar's menu button.
 *
 * Also mounts the PWA runtime (service worker, theme colour) and, on the app's home and Me pages,
 * the "Install the app" card.
 */
export function AppShell({
  children,
  defaultSidebarOpen = true,
  unreadNotifications = 0,
  unreadMessages = 0,
  ...props
}: ShellProps & { children: ReactNode }) {
  const isApp = props.variant === "app" && props.user !== null
  const tabs = isApp ? appTabs(props.activeRole) : []
  // The bell appears with its page (/app/notifications, Phase 3).
  const bell =
    isApp && isBuiltRoute(NOTIFICATIONS_PATH) ? (
      <NotificationsBell unread={unreadNotifications} />
    ) : null

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppBarProvider>
        <PwaRuntime />
        <AppSidebar {...props} />
        <SidebarInset>
          <header className="sticky top-0 z-30 hidden h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-safe-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:flex">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            {props.variant === "admin" ? (
              <Badge variant="destructive" aria-label="Admin area">
                Admin
              </Badge>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {bell}
              <ThemeToggle />
            </div>
          </header>
          <AppBar variant={props.variant} tabs={tabs} appName={props.appName} trailing={bell} />
          <div className="mx-auto w-full max-w-6xl flex-1 pt-6 px-safe-4 pb-[calc(1.5rem+var(--sticky-bottom,0px))] sm:px-safe-6 lg:pt-8 lg:pb-8">
            {children}
            {isApp ? <InstallPrompt /> : null}
          </div>
        </SidebarInset>
        {isApp ? <MobileTabBar tabs={tabs} unread={unreadNotifications + unreadMessages} /> : null}
      </AppBarProvider>
    </SidebarProvider>
  )
}
