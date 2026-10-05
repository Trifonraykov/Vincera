"use client"

import { ArrowRight, CircleAlert, Loader2, Save } from "lucide-react"
import { useActionState, useId, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/actions/result"
import { confirmAudienceReview, updateAudienceSummary } from "@/lib/social/actions"
import { SUMMARY_MAX_LENGTH, TOPICS_MAX } from "@/lib/social/summary-form"

/**
 * The editable audience summary and topics (§7.3 use 1). `review` mode is the onboarding review
 * ("Continue" saves, records the decision and moves on); `edit` mode saves on /app/audience.
 */
export function AudienceSummaryForm({
  mode,
  summary,
  topics,
  onSaved,
}: {
  mode: "review" | "edit"
  summary: string | null
  topics: readonly string[]
  /** Edit mode: called after a successful save (e.g. to close the editor). */
  onSaved?: () => void
}) {
  const id = useId()
  const [length, setLength] = useState(summary?.length ?? 0)
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) => {
      const result =
        mode === "review"
          ? await confirmAudienceReview(formData)
          : await updateAudienceSummary(formData)
      if (result.ok) onSaved?.()
      return result
    },
    null,
  )
  const error = state && !state.ok ? state : null
  const summaryError = error?.fieldErrors?.summary?.[0]
  const topicsError = error?.fieldErrors?.topics?.[0]
  const summaryId = `${id}-summary`
  const topicsId = `${id}-topics`

  return (
    <form action={formAction} className="space-y-5">
      {error && !summaryError && !topicsError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor={summaryId}>Audience summary</Label>
        <Textarea
          id={summaryId}
          name="summary"
          defaultValue={summary ?? ""}
          maxLength={SUMMARY_MAX_LENGTH}
          rows={6}
          onChange={(event) => setLength(event.currentTarget.value.length)}
          placeholder="Who follows you, where they are, and what they care about."
          aria-invalid={summaryError ? true : undefined}
          aria-describedby={`${summaryId}-hint${summaryError ? ` ${summaryId}-error` : ""}`}
        />
        <p id={`${summaryId}-hint`} className="text-sm text-muted-foreground">
          Builders read this on your profile. {length}/{SUMMARY_MAX_LENGTH} characters.
        </p>
        {summaryError ? (
          <p id={`${summaryId}-error`} className="text-sm text-destructive">
            {summaryError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={topicsId}>Topics</Label>
        <Input
          id={topicsId}
          name="topics"
          defaultValue={topics.join(", ")}
          placeholder="home cooking, budget recipes, meal prep"
          aria-invalid={topicsError ? true : undefined}
          aria-describedby={`${topicsId}-hint${topicsError ? ` ${topicsId}-error` : ""}`}
        />
        <p id={`${topicsId}-hint`} className="text-sm text-muted-foreground">
          Up to {TOPICS_MAX}, separated by commas. We use them to match you with builders.
        </p>
        {topicsError ? (
          <p id={`${topicsId}-error`} className="text-sm text-destructive">
            {topicsError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {mode === "edit" && state?.ok ? (
          <p role="status" className="self-center text-sm text-muted-foreground sm:mr-auto">
            Saved.
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {mode === "review" ? (
            <>
              Continue
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
            </>
          ) : (
            <>
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              Save summary
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
