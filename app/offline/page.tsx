import { WifiOff } from "lucide-react"
import type { Metadata } from "next"

import { RetryWhenOnline } from "@/components/pwa/retry-when-online"
import { LogoMark } from "@/components/shared/logo"
import { env } from "@/lib/env"

export const metadata: Metadata = {
  title: "You're offline",
  robots: { index: false, follow: false },
}

// Built once and precached by the service worker (public/sw.js), which shows it when a page can't
// load without a connection. It must stay static and the same for everyone: no session, no data.
export const dynamic = "force-static"

export default function OfflinePage() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-svh w-full max-w-md flex-col items-center justify-center gap-6 px-6 pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(2.5rem+env(safe-area-inset-bottom))] text-center"
    >
      <LogoMark className="size-10" />
      <div className="flex size-14 items-center justify-center rounded-full bg-muted">
        <WifiOff className="size-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">You&apos;re offline</h1>
        <p className="text-sm text-pretty text-muted-foreground">
          {env.APP_NAME} needs a connection to show your work. Nothing you see in the app is stored
          on this device, so check your Wi-Fi or mobile data and try again.
        </p>
      </div>
      <RetryWhenOnline />
    </main>
  )
}
