import type { ReactNode } from "react"

import { SiteFooter } from "@/components/layout/site-footer"
import { SiteHeader } from "@/components/layout/site-header"
import { env } from "@/lib/env"

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader appName={env.APP_NAME} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter appName={env.APP_NAME} />
    </div>
  )
}
