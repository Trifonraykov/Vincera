"use client"

import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

/**
 * While a connection's first sync runs in the background (§13 `social/sync`), re-render the page
 * every few seconds so the numbers appear without a manual reload. Stops after `maxAttempts`, or
 * as soon as the server stops rendering it (the page no longer has a pending sync).
 */
export function SyncRefresher({
  message = "Fetching your latest stats…",
  intervalMs = 2500,
  maxAttempts = 24,
}: {
  message?: string
  intervalMs?: number
  maxAttempts?: number
}) {
  const router = useRouter()
  const [attempts, setAttempts] = useState(0)
  const done = attempts >= maxAttempts

  useEffect(() => {
    if (done) return
    const timer = window.setTimeout(() => {
      setAttempts((count) => count + 1)
      router.refresh()
    }, intervalMs)
    return () => window.clearTimeout(timer)
  }, [attempts, done, intervalMs, router])

  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      {done ? null : <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {done ? "This is taking longer than usual. Reload the page in a minute." : message}
    </p>
  )
}
