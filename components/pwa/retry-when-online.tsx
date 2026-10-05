"use client"

import { RotateCw } from "lucide-react"
import { useEffect } from "react"

import { Button } from "@/components/ui/button"

/**
 * The offline page's "Try again": reloads the page the person was opening (the service worker
 * shows the offline page at that URL), and does so by itself when the connection comes back.
 */
export function RetryWhenOnline() {
  useEffect(() => {
    const reload = () => window.location.reload()
    window.addEventListener("online", reload)
    return () => window.removeEventListener("online", reload)
  }, [])

  return (
    <div className="flex w-full flex-col gap-2">
      <Button type="button" size="lg" className="w-full" onClick={() => window.location.reload()}>
        <RotateCw aria-hidden="true" />
        Try again
      </Button>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        This page reloads by itself when you&apos;re back online.
      </p>
    </div>
  )
}
