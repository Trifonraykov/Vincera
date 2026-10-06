import { SearchX } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { SiteFooter } from "@/components/layout/site-footer"
import { SiteHeader } from "@/components/layout/site-header"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { env } from "@/lib/env"

export const metadata: Metadata = { title: "Page not found" }

/**
 * 404 for every URL outside the app and admin shells (and `notFound()` in public profiles), with
 * the site's header and footer and links back, so an installed app (no browser chrome) is never
 * stranded. `/app/*` and `/admin/*` have their own, inside their shells.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader appName={env.APP_NAME} />
      <main
        id="main"
        className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4 py-16"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <EmptyState
          icon={SearchX}
          title="There's nothing here"
          description="This page doesn't exist. The link may be mistyped, or the page may have moved."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild size="sm">
                <Link href="/">Go to the home page</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/app">Open the app</Link>
              </Button>
            </div>
          }
        />
      </main>
      <SiteFooter appName={env.APP_NAME} />
    </div>
  )
}
