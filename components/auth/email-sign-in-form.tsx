"use client"

import { CircleAlert, Loader2, MailCheck } from "lucide-react"
import { useActionState, useId, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestMagicLink } from "@/lib/auth/actions"
import { INITIAL_MAGIC_LINK_STATE, type MagicLinkState } from "@/lib/auth/magic-link-state"

import { SignInCodeForm } from "./sign-in-code-form"

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
    return (
      <CheckEmail
        email={state.email}
        callbackUrl={callbackUrl}
        onRetry={() => setDismissed(state)}
      />
    )
  }

  const error = state.status === "error" ? state : null
  const emailError = error?.fieldErrors?.email?.[0]
  const nameError = error?.fieldErrors?.name?.[0]

  return (
    <div className="grid gap-4">
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
      {intent === "sign-in" ? <HaveACode callbackUrl={callbackUrl} /> : null}
    </div>
  )
}

/** For a code from an email sent earlier (e.g. the page was reloaded after requesting it). */
export function HaveACode({ callbackUrl }: { callbackUrl?: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return (
    <div className="grid gap-3 text-sm">
      <Button
        type="button"
        variant="link"
        className="h-auto justify-self-center p-0 text-muted-foreground"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        Have a sign-in code?
      </Button>
      {open ? (
        <div id={panelId} className="rounded-lg border p-4">
          <SignInCodeForm callbackUrl={callbackUrl} />
        </div>
      ) : null}
    </div>
  )
}

function CheckEmail({
  email,
  callbackUrl,
  onRetry,
}: {
  email: string
  callbackUrl?: string
  onRetry: () => void
}) {
  return (
    <div className="grid gap-4 text-center">
      <div className="grid gap-4" role="status" aria-live="polite">
        <MailCheck className="mx-auto size-10 text-primary" aria-hidden="true" />
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">Check your email</h2>
          <p className="text-sm text-pretty text-muted-foreground">
            We sent a sign-in link and code to{" "}
            <span className="font-medium text-foreground">{email}</span>. They work once and expire
            in 24 hours.
          </p>
        </div>
      </div>
      {/* The installed app on iOS can't receive the link's sign-in, so the code works here too. */}
      <p className="text-sm text-pretty text-muted-foreground">
        Using the app from your home screen? Enter the code from the email here.
      </p>
      <SignInCodeForm email={email} callbackUrl={callbackUrl} />
      <Button type="button" variant="ghost" onClick={onRetry}>
        Use a different email
      </Button>
    </div>
  )
}
