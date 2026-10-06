"use client"

import { FileSignature, Loader2 } from "lucide-react"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import {
  describe,
  Field,
  FormActions,
  FormErrorAlert,
  useFormAction,
} from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { signAgreementAction } from "@/lib/agreements/actions"
import { TYPED_NAME_MAX, TYPED_NAME_MESSAGES } from "@/lib/agreements/fields"

/**
 * Click-signing (§12 "Sign requires typing your full name"). The form wraps the agreement text, so
 * on phones the Sign bar stays above the tab bar while the whole text scrolls past; the name field
 * sits right after the text. Signing with the field empty jumps to it instead of submitting.
 *
 * The form sends the fingerprint (`bodyHash`) of the text on screen: if the stored agreement no
 * longer matches it, the server refuses and asks for a reload. When signing is not possible yet
 * (payouts not set up), `blocked` explains why and the button is disabled.
 */
export function SignAgreementForm({
  agreementId,
  bodyHash,
  signingAs,
  blocked,
  children,
}: {
  agreementId: string
  bodyHash: string
  /** "the Creator" / "the Builder". */
  signingAs: string
  /** Why the viewer cannot sign yet (shown next to the field), or null. */
  blocked: ReactNode | null
  /** The agreement text. */
  children?: ReactNode
}) {
  const id = useId()
  const form = useFormAction(signAgreementAction)
  const inputRef = useRef<HTMLInputElement>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const handled = useRef<unknown>(null)

  useEffect(() => {
    const result = form.result
    if (!result || handled.current === result) return
    handled.current = result
    if (!result.ok) {
      if (result.fieldErrors?.typedName) inputRef.current?.focus()
      return
    }
    toast.success(
      result.data.completed
        ? "Signed. The agreement is complete: we're emailing you both the signed PDF."
        : "Signed. We've let your collaborator know it's their turn.",
    )
  }, [form.result])

  const nameError = localError ?? form.fieldError("typedName")
  const fieldId = `${id}-typed-name`

  return (
    <form
      action={form.formAction}
      noValidate
      className="space-y-6"
      onSubmit={(event) => {
        const value = inputRef.current?.value.trim() ?? ""
        if (value.length === 0) {
          event.preventDefault()
          setLocalError(TYPED_NAME_MESSAGES.missing)
          inputRef.current?.focus()
          return
        }
        setLocalError(null)
      }}
    >
      <input type="hidden" name="agreementId" value={agreementId} />
      <input type="hidden" name="bodyHash" value={bodyHash} />
      {children}

      <section
        id="sign"
        aria-labelledby={`${id}-sign-heading`}
        className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-4 shadow-xs"
      >
        <h2 id={`${id}-sign-heading`} className="font-semibold">
          Sign as {signingAs}
        </h2>
        {blocked}
        <Field
          id={fieldId}
          label="Type your full name to sign"
          hint="Your legal name, as on an ID document. Typing it and pressing Sign is your signature."
          error={nameError}
        >
          <Input
            ref={inputRef}
            id={fieldId}
            name="typedName"
            autoComplete="name"
            autoCapitalize="words"
            spellCheck={false}
            maxLength={TYPED_NAME_MAX}
            defaultValue={form.valueOf("typedName", "")}
            disabled={blocked !== null}
            className="h-11 text-base sm:h-9"
            onInput={() => setLocalError(null)}
            {...describe(fieldId, { hint: true, error: nameError })}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          We record the time, your IP address and your browser with your signature, and email you
          both a PDF copy once you have both signed.
        </p>
        {form.error && !form.fieldError("typedName") ? (
          <FormErrorAlert message={form.error.error} />
        ) : null}
      </section>

      <FormActions>
        <Button type="submit" disabled={form.pending || blocked !== null} className="h-11 sm:h-9">
          {form.pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <FileSignature aria-hidden="true" />
          )}
          Sign the agreement
        </Button>
      </FormActions>
    </form>
  )
}
