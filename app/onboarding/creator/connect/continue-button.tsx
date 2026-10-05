"use client"

import { ArrowRight, Loader2 } from "lucide-react"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { finishConnectStep } from "@/lib/social/actions"

/** Records the connect step as done and continues to the audience review. */
export function ContinueButton() {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) =>
      finishConnectStep(formData),
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-1 sm:items-end">
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        Continue
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
