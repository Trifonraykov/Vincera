import type { ReactNode } from "react"

import { SiteFooter } from "@/components/layout/site-footer"
import { SiteHeader } from "@/components/layout/site-header"
import { env } from "@/lib/env"

/** Public creator and builder profiles, `/c/[handle]` and `/b/[handle]` (pages in Phase 1). */
export default function PublicProfilesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader appName={env.APP_NAME} />
      <main
        id="main"
        className="mx-auto w-full max-w-5xl flex-1 py-8 px-safe-4 sm:py-10 sm:px-safe-6"
      >
        {children}
      </main>
      <SiteFooter appName={env.APP_NAME} />
    </div>
  )
}
