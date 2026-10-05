"use client"

import { ExternalLink, Loader2 } from "lucide-react"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { openStripeDashboard } from "@/lib/stripe/actions"

/** Opens the user's Stripe Express Dashboard through a one-time login link (§19.10). */
export function StripeDashboardButton({
  variant = "outline",
}: {
  variant?: "default" | "outline"
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) =>
      openStripeDashboard(formData),
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-1 sm:items-start">
      <Button type="submit" variant={variant} disabled={pending} className="w-full sm:w-auto">
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <ExternalLink aria-hidden="true" />
        )}
        Open Stripe Express dashboard
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  )
}
