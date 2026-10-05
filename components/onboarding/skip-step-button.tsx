"use client"

import { Loader2 } from "lucide-react"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { skipOnboardingStep } from "@/lib/onboarding/actions"
import type { SkippableOnboardingStepId } from "@/lib/onboarding/steps"

/**
 * "Do this later" for a skippable onboarding step (connect, portfolio, payouts): records the skip
 * and continues to the next step (the server action redirects).
 */
export function SkipStepButton({
  step,
  label = "Do this later",
}: {
  step: SkippableOnboardingStepId
  label?: string
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) =>
      skipOnboardingStep(formData),
    null,
  )

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="step" value={step} />
      <Button type="submit" variant="ghost" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {label}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  )
}
