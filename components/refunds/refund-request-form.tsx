"use client"

import { CircleCheck } from "lucide-react"
import { useActionState } from "react"

import { FormErrorAlert, RadioCard } from "@/components/profiles/form-kit"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { RefundRequestFormState } from "@/lib/refund-requests/actions"
import {
  REFUND_MESSAGE_MAX,
  REFUND_REASON_LABELS,
  REFUND_REQUEST_REASONS,
} from "@/lib/refund-requests/fields"

/**
 * The buyer's refund request: a reason (radio cards, 44 px+) and optional words for the team.
 * `action` is `submitRefundRequestAction` bound to the access token by the page.
 */
export function RefundRequestForm({
  action,
}: {
  action: (state: RefundRequestFormState, formData: FormData) => Promise<RefundRequestFormState>
}) {
  const [state, formAction, pending] = useActionState(action, null)

  if (state?.ok) {
    return (
      <Alert>
        <CircleCheck aria-hidden="true" />
        <AlertTitle>We got your request</AlertTitle>
        <AlertDescription>
          Our team looks at it and emails you the answer, usually within two business days. Your
          access link keeps working meanwhile.
        </AlertDescription>
      </Alert>
    )
  }

  const reasonError = state && !state.ok ? state.fieldErrors?.reason?.[0] : undefined
  const messageError = state && !state.ok ? state.fieldErrors?.message?.[0] : undefined
  const formError = state && !state.ok && !reasonError && !messageError ? state.error : null

  return (
    <form action={formAction} noValidate className="space-y-5">
      {formError ? <FormErrorAlert message={formError} /> : null}
      <fieldset
        className="space-y-2"
        aria-describedby={reasonError ? "refund-reason-error" : undefined}
      >
        <legend className="mb-2 text-sm font-medium">Why do you want a refund?</legend>
        {REFUND_REQUEST_REASONS.map((reason) => (
          <RadioCard
            key={reason}
            name="reason"
            value={reason}
            title={REFUND_REASON_LABELS[reason]}
            description=""
            defaultChecked={false}
            required
          />
        ))}
        {reasonError ? (
          <p id="refund-reason-error" className="text-sm text-destructive">
            {reasonError}
          </p>
        ) : null}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor="refund-message">
          Anything we should know?{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="refund-message"
          name="message"
          rows={4}
          maxLength={REFUND_MESSAGE_MAX}
          className="text-base"
          aria-invalid={messageError ? true : undefined}
          aria-describedby={messageError ? "refund-message-error" : "refund-message-hint"}
        />
        {messageError ? (
          <p id="refund-message-error" className="text-sm text-destructive">
            {messageError}
          </p>
        ) : (
          <p id="refund-message-hint" className="text-sm text-muted-foreground">
            The makers and our team read this. Don&apos;t include card details.
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="h-11 w-full sm:w-auto">
        {pending ? "Sending…" : "Ask for a refund"}
      </Button>
    </form>
  )
}
