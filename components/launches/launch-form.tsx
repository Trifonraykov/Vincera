"use client"

import { Loader2, Save } from "lucide-react"
import { useId, useState } from "react"
import { toast } from "sonner"

import {
  describe,
  Field,
  FormActions,
  FormErrorAlert,
  RadioCard,
  useFormAction,
} from "@/components/profiles/form-kit"
import { MoneyInput } from "@/components/supply/money-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { DeliveryType } from "@/lib/db/schema/enums"
import { saveLaunchAction } from "@/lib/launches/actions"
import {
  DELIVERY_TYPE_LABELS,
  DELIVERY_TYPES,
  LAUNCH_CURRENCY,
  LAUNCH_DESCRIPTION_MAX,
  LAUNCH_FIELD_NAMES,
  LAUNCH_INSTRUCTIONS_MAX,
  LAUNCH_TAGLINE_MAX,
  LAUNCH_TITLE_MAX,
  LAUNCH_URL_MAX,
  SLUG_MAX,
} from "@/lib/launches/fields"

export type LaunchFormDefaults = {
  title: string
  tagline: string
  descriptionMd: string
  /** As typed in the price field ("19.99"), not cents. */
  price: string
  slug: string
  deliveryType: DeliveryType | ""
  deliveryUrl: string
  instructions: string
}

type SaveResult = { changed: string[]; approvalsReset: boolean }

/**
 * The launch setup form (§12 `/app/collabs/[id]/launch`): the product page's title, tagline,
 * description (Markdown) and price, its address (`/p/<slug>`, fixed once live), and how buyers get
 * it. Either member edits; saving a change resets approvals, which the page says next to the
 * Save button. Files, images and license keys have their own sections below the form.
 */
export function LaunchForm({
  launchId,
  defaults,
  slugLocked,
  hasApprovals,
  appUrl,
}: {
  launchId: string
  defaults: LaunchFormDefaults
  slugLocked: boolean
  hasApprovals: boolean
  appUrl: string
}) {
  const id = useId()
  const form = useFormAction<SaveResult>(async (formData) => {
    const result = await saveLaunchAction(formData)
    if (result.ok) {
      toast.success(
        result.data.changed.length === 0
          ? "Nothing changed."
          : result.data.approvalsReset
            ? "Saved. Approvals were reset: both of you approve the new version."
            : "Saved.",
      )
    }
    return result
  })
  const [deliveryType, setDeliveryType] = useState<string>(
    form.valueOf("deliveryType", defaults.deliveryType),
  )
  const ids = Object.fromEntries(
    LAUNCH_FIELD_NAMES.map((name) => [name, `${id}-${name}`]),
  ) as Record<(typeof LAUNCH_FIELD_NAMES)[number], string>
  const pagePrefix = `${appUrl.replace(/\/$/, "")}/p/`

  return (
    <form action={form.formAction} className="space-y-6" noValidate>
      <input type="hidden" name="launchId" value={launchId} />
      {form.error && form.hasFormError(LAUNCH_FIELD_NAMES) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}

      <Field
        id={ids.title}
        label="Title"
        hint="The product's name, as buyers will see it."
        error={form.fieldError("title")}
      >
        <Input
          id={ids.title}
          name="title"
          defaultValue={form.valueOf("title", defaults.title)}
          required
          maxLength={LAUNCH_TITLE_MAX}
          autoComplete="off"
          {...describe(ids.title, { hint: true, error: form.fieldError("title") })}
        />
      </Field>

      <Field
        id={ids.tagline}
        label="Tagline"
        optional
        hint="One line under the title: what it does for the buyer."
        error={form.fieldError("tagline")}
      >
        <Input
          id={ids.tagline}
          name="tagline"
          defaultValue={form.valueOf("tagline", defaults.tagline)}
          maxLength={LAUNCH_TAGLINE_MAX}
          autoComplete="off"
          placeholder="Plan a week of meals in five minutes"
          {...describe(ids.tagline, { hint: true, error: form.fieldError("tagline") })}
        />
      </Field>

      <Field
        id={ids.slug}
        label="Page address"
        hint={
          slugLocked
            ? "Fixed now that the launch has gone live, so shared links keep working."
            : `Your product page will be at ${pagePrefix}…`
        }
        error={form.fieldError("slug")}
      >
        <div className="flex min-w-0 items-center rounded-md border border-input shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
          <span className="hidden shrink-0 pl-3 text-sm text-muted-foreground sm:inline">/p/</span>
          <Input
            id={ids.slug}
            name="slug"
            defaultValue={form.valueOf("slug", defaults.slug)}
            readOnly={slugLocked}
            required
            maxLength={SLUG_MAX}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="border-0 shadow-none focus-visible:ring-0 sm:pl-1 dark:bg-transparent"
            {...describe(ids.slug, { hint: true, error: form.fieldError("slug") })}
          />
        </div>
      </Field>

      <Field
        id={ids.descriptionMd}
        label="Description"
        optional
        hint="What buyers get and why it helps. Markdown works: **bold**, lists, links."
        error={form.fieldError("descriptionMd")}
      >
        <Textarea
          id={ids.descriptionMd}
          name="descriptionMd"
          defaultValue={form.valueOf("descriptionMd", defaults.descriptionMd)}
          maxLength={LAUNCH_DESCRIPTION_MAX}
          rows={8}
          {...describe(ids.descriptionMd, { hint: true, error: form.fieldError("descriptionMd") })}
        />
      </Field>

      <Field
        id={ids.price}
        label="Price"
        hint="What a buyer pays once, in euros, VAT included (at least €0.50)."
        error={form.fieldError("price")}
        className="sm:max-w-xs"
      >
        <MoneyInput
          id={ids.price}
          name="price"
          currency={LAUNCH_CURRENCY}
          defaultValue={form.valueOf("price", defaults.price)}
          placeholder="19"
          {...describe(ids.price, { hint: true, error: form.fieldError("price") })}
        />
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-sm leading-none font-medium">How buyers get it</legend>
        <div
          className="grid gap-3 sm:grid-cols-3"
          onChange={(event) => {
            const target = event.target
            if (target instanceof HTMLInputElement && target.name === "deliveryType") {
              setDeliveryType(target.value)
            }
          }}
        >
          {DELIVERY_TYPES.map((value) => (
            <RadioCard
              key={value}
              name="deliveryType"
              value={value}
              title={DELIVERY_TYPE_LABELS[value].title}
              description={DELIVERY_TYPE_LABELS[value].description}
              defaultChecked={deliveryType === value}
            />
          ))}
        </div>
        {form.fieldError("deliveryType") ? (
          <p className="text-sm text-destructive" role="alert">
            {form.fieldError("deliveryType")}
          </p>
        ) : null}
      </fieldset>

      {deliveryType === "url" ? (
        <Field
          id={ids.deliveryUrl}
          label="Link buyers are sent to"
          hint="An https:// page, e.g. your app's sign-up with access for buyers."
          error={form.fieldError("deliveryUrl")}
        >
          <Input
            id={ids.deliveryUrl}
            name="deliveryUrl"
            type="url"
            inputMode="url"
            defaultValue={form.valueOf("deliveryUrl", defaults.deliveryUrl)}
            maxLength={LAUNCH_URL_MAX}
            autoComplete="url"
            placeholder="https://app.example.com/welcome"
            {...describe(ids.deliveryUrl, { hint: true, error: form.fieldError("deliveryUrl") })}
          />
        </Field>
      ) : (
        <input type="hidden" name="deliveryUrl" value={defaults.deliveryUrl} />
      )}

      {deliveryType === "license_key" ? (
        <Field
          id={ids.instructions}
          label="How to use the key"
          optional
          hint="Shown to buyers next to their key, e.g. where to enter it."
          error={form.fieldError("instructions")}
        >
          <Textarea
            id={ids.instructions}
            name="instructions"
            defaultValue={form.valueOf("instructions", defaults.instructions)}
            maxLength={LAUNCH_INSTRUCTIONS_MAX}
            rows={3}
            {...describe(ids.instructions, { hint: true, error: form.fieldError("instructions") })}
          />
        </Field>
      ) : (
        <input type="hidden" name="instructions" value={defaults.instructions} />
      )}

      <FormActions>
        {hasApprovals ? (
          <p className="text-sm text-muted-foreground sm:mr-auto">
            Saving a change resets the approvals.
          </p>
        ) : null}
        <Button type="submit" disabled={form.pending} className="h-11 sm:h-9">
          {form.pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          Save launch
        </Button>
      </FormActions>
    </form>
  )
}
