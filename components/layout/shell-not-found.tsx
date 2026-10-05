"use client"

import { Hourglass, SearchX } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { plannedNavItem } from "@/lib/nav"

/**
 * The 404 page inside the app and admin shells (app/app/not-found.tsx, app/admin/not-found.tsx),
 * so the sidebar, header and phone tab bar stay on screen and there is always a way back. A page
 * that a later phase builds (`plannedNavItem`) says "coming soon"; anything else "not found".
 */
export function ShellNotFound({ homeHref }: { homeHref: "/app" | "/admin" }) {
  const pathname = usePathname()
  const planned = plannedNavItem(pathname)
  const home = (
    <Button asChild size="sm">
      <Link href={homeHref}>Go to home</Link>
    </Button>
  )

  if (planned) {
    return (
      <div className="space-y-8">
        <PageHeader title={planned.title} description="This part of the platform is coming soon." />
        <EmptyState
          icon={Hourglass}
          title="Coming soon"
          description={`${planned.title} arrives in a later update. Everything in the menu without a "Soon" label works today.`}
          action={home}
        />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Page not found" />
      <EmptyState
        icon={SearchX}
        title="There's nothing here"
        description="This page doesn't exist. The link may be mistyped or out of date."
        action={home}
      />
    </div>
  )
}
