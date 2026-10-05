"use client"

import type { ReactNode } from "react"

import { ThemeToggle } from "@/components/shared/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { isBuiltRoute } from "@/lib/nav"

import { AppSidebar } from "./app-sidebar"
import { MobileTabBar } from "./mobile-tab-bar"
import { NOTIFICATIONS_PATH, NotificationsBell } from "./notifications-bell"
import type { ShellProps } from "./types"

/**
 * Signed-in shell for `/app` and `/admin`: sidebar (collapsible on desktop, sheet on mobile),
 * a top bar with the sidebar toggle, notifications and theme switch, and the page content. On
 * phones the app also gets a bottom tab bar (`MobileTabBar`), like a native app.
 * Purely presentational: layouts pass the user, roles and server actions in.
 */
export function AppShell({
  children,
  defaultSidebarOpen = true,
  unreadNotifications,
  ...props
}: ShellProps & { children: ReactNode }) {
  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppSidebar {...props} />
      <SidebarInset>
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          {props.variant === "admin" ? (
            <Badge variant="destructive" aria-label="Admin area">
              Admin
            </Badge>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {/* The bell appears with its page (/app/notifications, Phase 3). */}
            {props.variant === "app" && props.user && isBuiltRoute(NOTIFICATIONS_PATH) ? (
              <NotificationsBell unread={unreadNotifications} />
            ) : null}
            <ThemeToggle />
          </div>
        </header>
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-[calc(1.5rem+var(--sticky-bottom,0px))] sm:px-6 lg:pt-8 lg:pb-8">
          {children}
        </div>
      </SidebarInset>
      {props.variant === "app" && props.user ? (
        <MobileTabBar activeRole={props.activeRole} />
      ) : null}
    </SidebarProvider>
  )
}
