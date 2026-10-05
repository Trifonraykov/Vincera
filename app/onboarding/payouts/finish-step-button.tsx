"use client"

import { ArrowRight, Loader2 } from "lucide-react"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { finishPayoutsStep } from "@/lib/stripe/actions"

/** Records the payouts step as done and continues (to `/app` when onboarding is finished). */
export function FinishPayoutsStepButton({ label }: { label: string }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) =>
      finishPayoutsStep(formData),
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-1 sm:items-end">
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {label}
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <ArrowRight aria-hidden="true" />
        )}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  )
}
