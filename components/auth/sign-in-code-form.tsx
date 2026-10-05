"use client"

import { useId, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { safeCallbackUrl } from "@/lib/auth/routes"
import { normalizeSignInCode, SIGN_IN_CODE_LENGTH } from "@/lib/auth/sign-in-code"

const EMAIL_CALLBACK_PATH = "/api/auth/callback/email"

/**
 * "Enter the code from the email": finishes signing in on this device, without the link. Needed
 * for the installed app on iOS, which keeps its own cookies apart from Safari's, so a link tapped
 * in Mail signs Safari in instead (CLAUDE.md §19.19). A plain GET form to Auth.js's magic-link
 * callback (it works without JavaScript); the server normalises the code and limits attempts.
 */
export function SignInCodeForm({ email, callbackUrl }: { email?: string; callbackUrl?: string }) {
  const id = useId()
  const [error, setError] = useState<string | null>(null)

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const field = event.currentTarget.elements.namedItem("token")
    const code = field instanceof HTMLInputElement ? normalizeSignInCode(field.value) : null
    if (!code) {
      event.preventDefault()
      setError(`Enter the ${SIGN_IN_CODE_LENGTH}-character code from the email, like 7K4Q-X2MZ.`)
      return
    }
    setError(null)
  }

  return (
    <form
      method="get"
      action={EMAIL_CALLBACK_PATH}
      onSubmit={onSubmit}
      className="grid gap-3 text-left"
      noValidate
    >
      {/* Where the emailed link goes too (requestMagicLink's redirectTo). */}
      <input type="hidden" name="callbackUrl" value={safeCallbackUrl(callbackUrl)} />
      {email ? (
        <input type="hidden" name="email" value={email} />
      ) : (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-email`}>Email</Label>
          <Input
            id={`${id}-email`}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
          />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-code`}>Sign-in code</Label>
        <Input
          id={`${id}-code`}
          name="token"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={12}
          placeholder="ABCD-EFGH"
          className="font-mono tracking-widest uppercase"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-code-error` : undefined}
        />
        {error ? (
          <p id={`${id}-code-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" variant="secondary" className="w-full">
        Sign in with code
      </Button>
    </form>
  )
}
