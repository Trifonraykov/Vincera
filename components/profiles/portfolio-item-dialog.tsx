"use client"

import { Loader2, Pencil, Plus } from "lucide-react"
import { useId, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { ProductFormat } from "@/lib/db/schema/enums"
import { addPortfolioItemAction, updatePortfolioItemAction } from "@/lib/profiles/actions"
import {
  PORTFOLIO_DESCRIPTION_MAX,
  PORTFOLIO_TITLE_MAX,
  PORTFOLIO_URL_MAX,
  PRODUCT_FORMAT_LABELS,
  PRODUCT_FORMAT_VALUES,
  type ProfileFormSource,
} from "@/lib/profiles/fields"

import { describe, Field, FormErrorAlert, NativeSelect, useFormAction } from "./form-kit"

export type PortfolioItemView = {
  id: string
  title: string
  url: string | null
  description: string | null
  format: ProductFormat | null
  isShipped: boolean
}

const FIELDS = ["title", "url", "description", "format", "isShipped"] as const

/**
 * Add a portfolio project, or edit one (`item`), in a dialog. Closes after a successful save; the
 * page re-renders with the new list.
 */
export function PortfolioItemDialog({
  source,
  item,
  trigger,
}: {
  source: ProfileFormSource
  item?: PortfolioItemView
  trigger?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [formKey, setFormKey] = useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // A fresh form (and no old errors) every time the dialog opens.
        if (next) setFormKey((key) => key + 1)
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant={item ? "ghost" : "default"} size={item ? "sm" : "default"}>
            {item ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {item ? (
              <>
                Edit<span className="sr-only"> {item.title}</span>
              </>
            ) : (
              "Add a project"
            )}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? "Edit project" : "Add a project"}</DialogTitle>
          <DialogDescription>
            Something you built: an app, a tool, a template. Creators see it on your profile.
          </DialogDescription>
        </DialogHeader>
        <PortfolioItemForm
          key={formKey}
          source={source}
          item={item}
          onSaved={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function PortfolioItemForm({
  source,
  item,
  onSaved,
}: {
  source: ProfileFormSource
  item?: PortfolioItemView
  onSaved: () => void
}) {
  const id = useId()
  const form = useFormAction(async (formData: FormData) => {
    const result = item
      ? await updatePortfolioItemAction(formData)
      : await addPortfolioItemAction(formData)
    if (result.ok) onSaved()
    return result
  })
  const ids = {
    title: `${id}-title`,
    url: `${id}-url`,
    description: `${id}-description`,
    format: `${id}-format`,
    shipped: `${id}-shipped`,
  }
  const shippedValue = form.error
    ? form.valueOf("isShipped", "") === "on"
    : (item?.isShipped ?? false)

  return (
    <form action={form.formAction} className="space-y-5" noValidate>
      <input type="hidden" name="from" value={source} />
      {item ? <input type="hidden" name="itemId" value={item.id} /> : null}
      {form.error && form.hasFormError(FIELDS) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}

      <Field id={ids.title} label="Title" error={form.fieldError("title")}>
        <Input
          id={ids.title}
          name="title"
          defaultValue={form.valueOf("title", item?.title ?? "")}
          required
          maxLength={PORTFOLIO_TITLE_MAX}
          placeholder="Invoice generator for freelancers"
          {...describe(ids.title, { error: form.fieldError("title") })}
        />
      </Field>

      <Field
        id={ids.url}
        label="Link"
        optional
        hint="Where people can see or try it."
        error={form.fieldError("url")}
      >
        <Input
          id={ids.url}
          name="url"
          type="url"
          inputMode="url"
          defaultValue={form.valueOf("url", item?.url ?? "")}
          maxLength={PORTFOLIO_URL_MAX}
          placeholder="https://"
          {...describe(ids.url, { hint: true, error: form.fieldError("url") })}
        />
      </Field>

      <Field
        id={ids.description}
        label="What it does"
        optional
        error={form.fieldError("description")}
      >
        <Textarea
          id={ids.description}
          name="description"
          defaultValue={form.valueOf("description", item?.description ?? "")}
          maxLength={PORTFOLIO_DESCRIPTION_MAX}
          rows={3}
          {...describe(ids.description, { error: form.fieldError("description") })}
        />
      </Field>

      <Field id={ids.format} label="Format" optional error={form.fieldError("format")}>
        <NativeSelect
          id={ids.format}
          name="format"
          defaultValue={form.valueOf("format", item?.format ?? "")}
          {...describe(ids.format, { error: form.fieldError("format") })}
        >
          <option value="">Not sure</option>
          {PRODUCT_FORMAT_VALUES.map((format) => (
            <option key={format} value={format}>
              {PRODUCT_FORMAT_LABELS[format]}
            </option>
          ))}
        </NativeSelect>
      </Field>

      <label htmlFor={ids.shipped} className="flex items-start gap-3 text-sm">
        <input
          id={ids.shipped}
          type="checkbox"
          name="isShipped"
          defaultChecked={shippedValue}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          <span className="font-medium">It&apos;s shipped</span>
          <span className="block text-muted-foreground">People can use it today.</span>
        </span>
      </label>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={form.pending}>
          {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {item ? "Save project" : "Add project"}
        </Button>
      </DialogFooter>
    </form>
  )
}
