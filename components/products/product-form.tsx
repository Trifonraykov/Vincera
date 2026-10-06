"use client"

import { Loader2, Save, Send } from "lucide-react"
import { useId } from "react"

import {
  describe,
  Field,
  FormActions,
  FormErrorAlert,
  NativeSelect,
  RadioCard,
  splitList,
  useFormAction,
} from "@/components/profiles/form-kit"
import { TagInput } from "@/components/profiles/tag-input"
import { MoneyInput } from "@/components/supply/money-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { ProductFormat, ProductStage, ProductStatus } from "@/lib/db/schema/enums"
import { createProductAction, updateProductAction } from "@/lib/products/actions"
import {
  PRODUCT_DEMO_URL_MAX,
  PRODUCT_DESCRIPTION_MAX,
  PRODUCT_FIELD_NAMES,
  PRODUCT_STAGE_LABELS,
  PRODUCT_STAGE_VALUES,
  PRODUCT_TARGET_USER_MAX,
} from "@/lib/products/fields"
import { PRODUCT_FORMAT_LABELS, PRODUCT_FORMAT_VALUES } from "@/lib/profiles/fields"
import { parseTopicsInput } from "@/lib/social/summary-form"
import { SUPPLY_CURRENCY, SUPPLY_TITLE_MAX, TOPICS_MAX } from "@/lib/supply/fields"

export type ProductFormDefaults = {
  title: string
  description: string
  targetUser: string
  stage: ProductStage
  demoUrl: string
  format: ProductFormat | ""
  /** As typed in the price field ("19.99"), not cents. */
  targetPrice: string
  topics: readonly string[]
  /** As typed ("60"), empty for no preference. */
  preferredSplitBuilderPct: string
  exclusivity: boolean
}

export const EMPTY_PRODUCT_DEFAULTS: ProductFormDefaults = {
  title: "",
  description: "",
  targetUser: "",
  stage: "idea",
  demoUrl: "",
  format: "",
  targetPrice: "",
  topics: [],
  preferredSplitBuilderPct: "",
  exclusivity: false,
}

function normalizeTopic(tag: string): string {
  return parseTopicsInput(tag)[0] ?? ""
}

type ProductSaveResult = { status: ProductStatus; published: boolean; changed: string[] }

type Props =
  | { mode: "create"; defaults: ProductFormDefaults }
  | { mode: "edit"; productId: string; status: ProductStatus; defaults: ProductFormDefaults }

/**
 * The product form (§5 products) for `/app/products/new` and `/app/products/[id]`: title,
 * description (Markdown), who it's for, stage, demo link, format, planned price, topics, the
 * builder's preferred split and exclusivity. "Save draft" keeps it to yourself; "Publish" saves it
 * and lists it for creators (it needs a description and a topic).
 */
export function ProductForm(props: Props) {
  const id = useId()
  const form = useFormAction<ProductSaveResult>(
    props.mode === "create" ? createProductAction : updateProductAction,
  )
  const { defaults } = props
  const ids = {
    title: `${id}-title`,
    description: `${id}-description`,
    targetUser: `${id}-target-user`,
    demoUrl: `${id}-demo`,
    format: `${id}-format`,
    targetPrice: `${id}-price`,
    topics: `${id}-topics`,
    split: `${id}-split`,
    exclusivity: `${id}-exclusive`,
  }
  const isDraft = props.mode === "create" || props.status === "draft"
  const stage = form.valueOf("stage", defaults.stage)
  const exclusive = form.error ? form.valueOf("exclusivity", "") === "on" : defaults.exclusivity
  const lastSave = form.result?.ok ? form.result.data : null
  const savedMessage =
    props.mode === "edit" && lastSave
      ? lastSave.published
        ? "Published. Creators can find it now."
        : "Saved."
      : null

  return (
    <form action={form.formAction} className="space-y-6" noValidate>
      {props.mode === "edit" ? (
        <input type="hidden" name="productId" value={props.productId} />
      ) : null}
      {form.error && form.hasFormError(PRODUCT_FIELD_NAMES) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}

      <Field
        id={ids.title}
        label="Title"
        hint="The product's name, or what it does in a few words."
        error={form.fieldError("title")}
      >
        <Input
          id={ids.title}
          name="title"
          defaultValue={form.valueOf("title", defaults.title)}
          required
          maxLength={SUPPLY_TITLE_MAX}
          autoComplete="off"
          placeholder="Invoice generator for freelancers"
          {...describe(ids.title, { hint: true, error: form.fieldError("title") })}
        />
      </Field>

      <Field
        id={ids.description}
        label="Description"
        optional={isDraft}
        hint="What it is, what it does and what's done. Markdown works: **bold**, lists, links."
        error={form.fieldError("description")}
      >
        <Textarea
          id={ids.description}
          name="description"
          defaultValue={form.valueOf("description", defaults.description)}
          maxLength={PRODUCT_DESCRIPTION_MAX}
          rows={7}
          placeholder="Creates a PDF invoice in two clicks, tracks who has paid…"
          {...describe(ids.description, { hint: true, error: form.fieldError("description") })}
        />
      </Field>

      <Field
        id={ids.targetUser}
        label="Who it's for"
        optional
        hint="The people who would buy it."
        error={form.fieldError("targetUser")}
      >
        <Input
          id={ids.targetUser}
          name="targetUser"
          defaultValue={form.valueOf("targetUser", defaults.targetUser)}
          maxLength={PRODUCT_TARGET_USER_MAX}
          autoComplete="off"
          placeholder="Freelance designers who bill clients monthly"
          {...describe(ids.targetUser, { hint: true, error: form.fieldError("targetUser") })}
        />
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-sm leading-none font-medium">Stage</legend>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {PRODUCT_STAGE_VALUES.map((value) => (
            <RadioCard
              key={value}
              name="stage"
              value={value}
              title={PRODUCT_STAGE_LABELS[value].title}
              description={PRODUCT_STAGE_LABELS[value].description}
              defaultChecked={stage === value}
              required
            />
          ))}
        </div>
        {form.fieldError("stage") ? (
          <p className="text-sm text-destructive" role="alert">
            {form.fieldError("stage")}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          id={ids.format}
          label="Format"
          error={form.fieldError("format")}
          hint="The kind of product it is."
        >
          <NativeSelect
            id={ids.format}
            name="format"
            defaultValue={form.valueOf("format", defaults.format)}
            required
            {...describe(ids.format, { hint: true, error: form.fieldError("format") })}
          >
            <option value="" disabled>
              Choose a format
            </option>
            {PRODUCT_FORMAT_VALUES.map((value) => (
              <option key={value} value={value}>
                {PRODUCT_FORMAT_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id={ids.demoUrl}
          label="Demo link"
          optional
          hint="A live demo, video or screenshots."
          error={form.fieldError("demoUrl")}
        >
          <Input
            id={ids.demoUrl}
            name="demoUrl"
            type="url"
            inputMode="url"
            defaultValue={form.valueOf("demoUrl", defaults.demoUrl)}
            maxLength={PRODUCT_DEMO_URL_MAX}
            autoComplete="url"
            placeholder="https://demo.example.com"
            {...describe(ids.demoUrl, { hint: true, error: form.fieldError("demoUrl") })}
          />
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          id={ids.targetPrice}
          label="Planned price"
          optional
          hint="What a buyer would pay, once. In euros."
          error={form.fieldError("targetPrice")}
        >
          <MoneyInput
            id={ids.targetPrice}
            name="targetPrice"
            currency={SUPPLY_CURRENCY}
            defaultValue={form.valueOf("targetPrice", defaults.targetPrice)}
            placeholder="29"
            {...describe(ids.targetPrice, { hint: true, error: form.fieldError("targetPrice") })}
          />
        </Field>
        <Field
          id={ids.split}
          label="Your preferred share"
          optional
          hint="The part of each sale you'd like, in %. The creator gets the rest; you agree on it per proposal."
          error={form.fieldError("preferredSplitBuilderPct")}
        >
          <div className="relative">
            <Input
              id={ids.split}
              name="preferredSplitBuilderPct"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoComplete="off"
              defaultValue={form.valueOf(
                "preferredSplitBuilderPct",
                defaults.preferredSplitBuilderPct,
              )}
              placeholder="50"
              className="pr-8 tabular-nums"
              {...describe(ids.split, {
                hint: true,
                error: form.fieldError("preferredSplitBuilderPct"),
              })}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
            >
              %
            </span>
          </div>
        </Field>
      </div>

      <Field
        id={ids.topics}
        label="Topics"
        optional={isDraft}
        hint={`What it's about, so the right creators find it. Press Enter or a comma after each, up to ${TOPICS_MAX}.`}
        error={form.fieldError("topics")}
      >
        <TagInput
          key={defaults.topics.join("|")}
          id={ids.topics}
          name="topics"
          label="topic"
          defaultValue={splitList(form.valueOf("topics", defaults.topics.join(", ")))}
          max={TOPICS_MAX}
          normalize={normalizeTopic}
          placeholder="freelancing, invoicing"
          describedBy={
            describe(ids.topics, { hint: true, error: form.fieldError("topics") })[
              "aria-describedby"
            ]
          }
          invalid={Boolean(form.fieldError("topics"))}
        />
      </Field>

      <div className="space-y-2">
        <label
          htmlFor={ids.exclusivity}
          className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-4 text-sm shadow-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
        >
          <input
            id={ids.exclusivity}
            type="checkbox"
            name="exclusivity"
            defaultChecked={exclusive}
            className="mt-0.5 size-4 shrink-0 accent-primary"
            aria-describedby={
              form.fieldError("exclusivity")
                ? `${ids.exclusivity}-hint ${ids.exclusivity}-error`
                : `${ids.exclusivity}-hint`
            }
            aria-invalid={form.fieldError("exclusivity") ? true : undefined}
          />
          <span className="space-y-1">
            <span className="block font-medium">Exclusive to one creator</span>
            <span id={`${ids.exclusivity}-hint`} className="block text-muted-foreground">
              Work with one creator at a time. Leave it off to team up with several creators on the
              same product.
            </span>
          </span>
        </label>
        {form.fieldError("exclusivity") ? (
          <p id={`${ids.exclusivity}-error`} className="text-sm text-destructive">
            {form.fieldError("exclusivity")}
          </p>
        ) : null}
      </div>

      <FormActions className="flex-row flex-wrap">
        {savedMessage ? (
          <p
            role="status"
            className="basis-full text-center text-sm text-muted-foreground sm:mr-auto sm:basis-auto sm:text-left"
          >
            {savedMessage}
          </p>
        ) : null}
        {isDraft ? (
          <>
            <Button
              type="submit"
              name="intent"
              value="save"
              variant="outline"
              disabled={form.pending}
              className="h-11 flex-1 sm:h-9 sm:flex-none"
            >
              {form.pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              Save draft
            </Button>
            <Button
              type="submit"
              name="intent"
              value="publish"
              disabled={form.pending}
              className="h-11 flex-1 sm:h-9 sm:flex-none"
            >
              <Send aria-hidden="true" />
              Publish
            </Button>
          </>
        ) : (
          <Button
            type="submit"
            name="intent"
            value="save"
            disabled={form.pending}
            className="h-11 flex-1 sm:h-9 sm:flex-none"
          >
            {form.pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Save aria-hidden="true" />
            )}
            Save changes
          </Button>
        )}
      </FormActions>
    </form>
  )
}
