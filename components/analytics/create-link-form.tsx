"use client"

import { useState } from "react"
import { toast } from "sonner"

import { describe, Field, FormErrorAlert, useFormAction } from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createTrackedLinkAction } from "@/lib/tracked-links/actions"
import { LINK_LABEL_MAX } from "@/lib/tracked-links/fields"

const FIELDS = ["label", "discountCode", "discountPercent"] as const

/**
 * "New link": a name (where the link is shared, e.g. "Instagram bio") and an optional discount
 * code with its percentage. The link belongs to the member who makes it. The form resets after a
 * link is added; a refused submit keeps what was typed.
 */
export function CreateLinkForm({ launchId }: { launchId: string }) {
  const [withDiscount, setWithDiscount] = useState(false)
  // React resets the form after a successful action; only the discount toggle needs closing.
  const form = useFormAction(async (formData: FormData) => {
    const result = await createTrackedLinkAction(formData)
    if (result.ok) {
      toast.success("Link added.")
      setWithDiscount(false)
    }
    return result
  })

  const labelError = form.fieldError("label")
  const codeError = form.fieldError("discountCode")
  const percentError = form.fieldError("discountPercent")
  const showDiscount =
    withDiscount || Boolean(codeError || percentError || form.valueOf("discountCode", ""))

  return (
    <form action={form.formAction} noValidate className="space-y-4">
      <input type="hidden" name="launchId" value={launchId} />
      {form.error && form.hasFormError(FIELDS) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}
      <Field
        id="link-label"
        label="Name"
        hint="Where you'll share it, so you can tell links apart (only members see it)."
        error={labelError}
      >
        <Input
          id="link-label"
          name="label"
          maxLength={LINK_LABEL_MAX}
          placeholder="Instagram bio"
          defaultValue={form.valueOf("label", "")}
          className="h-11 md:h-9"
          {...describe("link-label", { hint: true, error: labelError })}
        />
      </Field>
      {showDiscount ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_10rem]">
          <Field
            id="link-code"
            label="Discount code"
            hint="Letters and digits, like SUMMER20. Buyers who use it are counted for this link."
            error={codeError}
          >
            <Input
              id="link-code"
              name="discountCode"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={24}
              defaultValue={form.valueOf("discountCode", "")}
              className="h-11 uppercase md:h-9"
              {...describe("link-code", { hint: true, error: codeError })}
            />
          </Field>
          <Field id="link-percent" label="Percent off" error={percentError}>
            <Input
              id="link-percent"
              name="discountPercent"
              inputMode="numeric"
              placeholder="20"
              defaultValue={form.valueOf("discountPercent", "")}
              className="h-11 md:h-9"
              {...describe("link-percent", { error: percentError })}
            />
          </Field>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="h-11 px-0 md:h-8"
          onClick={() => setWithDiscount(true)}
        >
          Add a discount code
        </Button>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={form.pending} className="h-11 w-full sm:w-auto md:h-9">
          {form.pending ? "Adding…" : "Add link"}
        </Button>
      </div>
    </form>
  )
}
