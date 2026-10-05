"use client"

import { Loader2, Sparkles } from "lucide-react"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { regenerateAudienceSummary } from "@/lib/social/actions"

/** "Regenerate": a fresh AI summary from the latest stats (replaces the creator's edit). */
export function RegenerateSummaryButton({ replacesEdit }: { replacesEdit: boolean }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) =>
      regenerateAudienceSummary(formData),
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-1 sm:items-start">
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <Sparkles aria-hidden="true" />
        )}
        {pending ? "Writing…" : "Regenerate with AI"}
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {state && !state.ok ? (
          <span className="text-destructive">{state.error}</span>
        ) : replacesEdit && !state ? (
          <span className="text-muted-foreground">Replaces your edited text.</span>
        ) : null}
      </p>
    </form>
  )
}
