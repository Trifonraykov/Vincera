import type { Metadata } from "next"
import type { ReactNode } from "react"

import { SiteFooter } from "@/components/layout/site-footer"
import { SiteHeader } from "@/components/layout/site-header"
import { env } from "@/lib/env"

/**
 * The buyer's access pages (§12 `/access/[token]`): the site's chrome, never indexed, and no
 * `Referer` leaves the page (the token is in its URL), including the downloads it links to.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

export default function AccessLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader appName={env.APP_NAME} />
      <main
        id="main"
        className="mx-auto w-full max-w-2xl flex-1 py-8 px-safe-4 sm:py-10 sm:px-safe-6"
      >
        {children}
      </main>
      <SiteFooter appName={env.APP_NAME} />
    </div>
  )
}
