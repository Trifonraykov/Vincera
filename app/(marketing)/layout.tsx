import type { ReactNode } from "react"

import { SiteFooter } from "@/components/layout/site-footer"
import { SiteHeader } from "@/components/layout/site-header"
import { PwaRuntime } from "@/components/pwa/pwa-runtime"
import { env } from "@/lib/env"

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      {/* The service worker registers from the first public page too (offline fallback). */}
      <PwaRuntime />
      <SiteHeader appName={env.APP_NAME} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter appName={env.APP_NAME} />
    </div>
  )
}
