"use client"

import { CircleAlert, Loader2, MailCheck } from "lucide-react"
import { useActionState, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestMagicLink } from "@/lib/auth/actions"
import { INITIAL_MAGIC_LINK_STATE, type MagicLinkState } from "@/lib/auth/magic-link-state"

/**
 * Magic-link form for /sign-in and /sign-up. After a successful request it turns into the
 * "check your email" state; errors are shown in plain language next to the form.
 */
export function EmailSignInForm({
  intent,
  callbackUrl,
}: {
  intent: "sign-in" | "sign-up"
  callbackUrl?: string
}) {
  const [state, formAction, pending] = useActionState(requestMagicLink, INITIAL_MAGIC_LINK_STATE)
  // "Use a different email" hides this particular "sent" state and shows the form again.
  const [dismissed, setDismissed] = useState<MagicLinkState | null>(null)

  if (state.status === "sent" && state !== dismissed) {
    return <CheckEmail email={state.email} onRetry={() => setDismissed(state)} />
  }

  const error = state.status === "error" ? state : null
  const emailError = error?.fieldErrors?.email?.[0]
  const nameError = error?.fieldErrors?.name?.[0]

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <input type="hidden" name="intent" value={intent} />
      {callbackUrl ? <input type="hidden" name="callbackUrl" value={callbackUrl} /> : null}

      {error && !emailError && !nameError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      {intent === "sign-up" ? (
        <div className="grid gap-2">
          <Label htmlFor="name">
            Name <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="name"
            name="name"
            autoComplete="name"
            maxLength={80}
            defaultValue={error?.values.name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "name-error" : undefined}
          />
          {nameError ? (
            <p id="name-error" className="text-sm text-destructive">
              {nameError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          defaultValue={error?.values.email}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? "email-error" : undefined}
        />
        {emailError ? (
          <p id="email-error" className="text-sm text-destructive">
            {emailError}
          </p>
        ) : null}
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {intent === "sign-up" ? "Create account" : "Email me a sign-in link"}
      </Button>
    </form>
  )
}

function CheckEmail({ email, onRetry }: { email: string; onRetry: () => void }) {
  return (
    <div className="grid gap-4 text-center" role="status" aria-live="polite">
      <MailCheck className="mx-auto size-10 text-primary" aria-hidden="true" />
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="text-sm text-pretty text-muted-foreground">
          We sent a sign-in link to <span className="font-medium text-foreground">{email}</span>. It
          works once and expires in 24 hours. You can close this tab.
        </p>
      </div>
      <Button type="button" variant="ghost" onClick={onRetry}>
        Use a different email
      </Button>
    </div>
  )
}
