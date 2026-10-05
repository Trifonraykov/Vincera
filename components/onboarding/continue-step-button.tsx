"use client"

import { ArrowRight, Loader2 } from "lucide-react"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"

/**
 * "Continue" on an optional onboarding step once it has something in it: posts the step's server
 * action (which records the step and redirects to the next one) and shows its error, if any.
 */
export function ContinueStepButton({
  action,
  label = "Continue",
}: {
  action: (formData: FormData) => Promise<ActionResult<unknown>>
  label?: string
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) => action(formData),
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
