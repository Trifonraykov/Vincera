"use client"

import type { ReactNode } from "react"

import { ThemeToggle } from "@/components/shared/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"

import { AppSidebar } from "./app-sidebar"
import { NotificationsBell } from "./notifications-bell"
import type { ShellProps } from "./types"

/**
 * Signed-in shell for `/app` and `/admin`: sidebar (collapsible on desktop, sheet on mobile),
 * a top bar with the sidebar toggle, notifications and theme switch, and the page content.
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
            {props.variant === "app" && props.user ? (
              <NotificationsBell unread={unreadNotifications} />
            ) : null}
            <ThemeToggle />
          </div>
        </header>
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
