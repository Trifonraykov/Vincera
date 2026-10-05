"use client"

import { Loader2, RefreshCw } from "lucide-react"
import { useRouter } from "next/navigation"
import { useActionState, useEffect } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { resyncSocialConnection } from "@/lib/social/actions"

/** "Resync": queue a fresh sync of one connection (rate limited on the server). */
export function ResyncButton({ connectionId, label }: { connectionId: string; label: string }) {
  const router = useRouter()
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<{ queued: true }> | null, formData: FormData) =>
      resyncSocialConnection(formData),
    null,
  )

  // The sync runs in the background: re-render a couple of times to pick up the new numbers.
  useEffect(() => {
    if (!state?.ok) return
    const timers = [3000, 8000].map((delay) => window.setTimeout(() => router.refresh(), delay))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [state, router])

  return (
    <form action={formAction} className="flex flex-col gap-1 sm:items-start">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`Resync ${label}`}
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
        Resync
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {state?.ok ? (
          <span className="text-muted-foreground">Sync started. New numbers appear shortly.</span>
        ) : state ? (
          <span className="text-destructive">{state.error}</span>
        ) : null}
      </p>
    </form>
  )
}
