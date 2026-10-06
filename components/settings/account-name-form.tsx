"use client"

import { Loader2, Save } from "lucide-react"
import { useId } from "react"

import { describe, Field, FormErrorAlert, useFormAction } from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DISPLAY_NAME_MAX } from "@/lib/profiles/fields"
import { updateAccountNameAction } from "@/lib/users/account-actions"

/** The account name (Settings → Account). Profiles keep their own display names. */
export function AccountNameForm({ name }: { name: string }) {
  const id = useId()
  const form = useFormAction(updateAccountNameAction)
  const fieldId = `${id}-name`
  const error = form.fieldError("name")

  return (
    <form action={form.formAction} className="space-y-4" noValidate>
      {form.error && form.hasFormError(["name"]) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}
      <Field
        id={fieldId}
        label="Your name"
        hint="Used in emails and in the app. Your public profiles have their own display name."
        error={error}
        className="sm:max-w-sm"
      >
        <Input
          id={fieldId}
          name="name"
          defaultValue={form.valueOf("name", name)}
          required
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="name"
          {...describe(fieldId, { hint: true, error })}
        />
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button type="submit" disabled={form.pending} className="w-full sm:w-auto">
          {form.pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          Save name
        </Button>
        {form.result?.ok ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saved.
          </p>
        ) : null}
      </div>
    </form>
  )
}
