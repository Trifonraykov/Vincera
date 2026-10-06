"use client"

import { Loader2, Save, Send } from "lucide-react"
import { useId } from "react"

import {
  describe,
  Field,
  FormActions,
  FormErrorAlert,
  NativeSelect,
  splitList,
  useFormAction,
} from "@/components/profiles/form-kit"
import { TagInput } from "@/components/profiles/tag-input"
import { MoneyInput } from "@/components/supply/money-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { IdeaStatus, ProductFormat } from "@/lib/db/schema/enums"
import { createIdeaAction, updateIdeaAction } from "@/lib/ideas/actions"
import { IDEA_EVIDENCE_MAX, IDEA_FIELD_NAMES, IDEA_PROBLEM_MAX } from "@/lib/ideas/fields"
import { PRODUCT_FORMAT_LABELS, PRODUCT_FORMAT_VALUES } from "@/lib/profiles/fields"
import { parseTopicsInput } from "@/lib/social/summary-form"
import { SUPPLY_CURRENCY, SUPPLY_TITLE_MAX, TOPICS_MAX } from "@/lib/supply/fields"

export type IdeaFormDefaults = {
  title: string
  problem: string
  audienceEvidence: string
  format: ProductFormat | ""
  /** As typed in the price field ("19.99"), not cents. */
  targetPrice: string
  topics: readonly string[]
}

export const EMPTY_IDEA_DEFAULTS: IdeaFormDefaults = {
  title: "",
  problem: "",
  audienceEvidence: "",
  format: "",
  targetPrice: "",
  topics: [],
}

/** A topic as ideas store them: lowercase, no `#` (lib/social/summary-form.ts). */
function normalizeTopic(tag: string): string {
  return parseTopicsInput(tag)[0] ?? ""
}

type IdeaSaveResult = { status: IdeaStatus; published: boolean; changed: string[] }

type Props =
  | {
      mode: "create"
      defaults: IdeaFormDefaults
      /** The sealed AI brief the fields came from (lib/ideas/brief.ts), sent with the save. */
      briefToken?: string | null
    }
  | { mode: "edit"; ideaId: string; status: IdeaStatus; defaults: IdeaFormDefaults }

/**
 * The idea form (§5 ideas) for `/app/ideas/new` and `/app/ideas/[id]`: title, format, target
 * price, the problem and the audience evidence (Markdown), and topics. "Save draft" keeps it to
 * yourself; "Publish" saves and opens it to builders (it needs the problem and a topic, which the
 * server explains next to the fields). On phones the buttons sit in the sticky action bar.
 */
export function IdeaForm(props: Props) {
  const id = useId()
  const form = useFormAction<IdeaSaveResult>(
    props.mode === "create" ? createIdeaAction : updateIdeaAction,
  )
  const { defaults } = props
  const ids = {
    title: `${id}-title`,
    format: `${id}-format`,
    targetPrice: `${id}-price`,
    problem: `${id}-problem`,
    audienceEvidence: `${id}-evidence`,
    topics: `${id}-topics`,
  }
  const isDraft = props.mode === "create" || props.status === "draft"
  const lastSave = form.result?.ok ? form.result.data : null
  const savedMessage =
    props.mode === "edit" && lastSave
      ? lastSave.published
        ? "Published. Builders can find it now."
        : "Saved."
      : null

  return (
    <form action={form.formAction} className="space-y-6" noValidate>
      {props.mode === "edit" ? <input type="hidden" name="ideaId" value={props.ideaId} /> : null}
      {props.mode === "create" && props.briefToken ? (
        <input type="hidden" name="brief" value={props.briefToken} />
      ) : null}
      {form.error && form.hasFormError(IDEA_FIELD_NAMES) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}

      <Field
        id={ids.title}
        label="Title"
        hint="What would you call the product?"
        error={form.fieldError("title")}
      >
        <Input
          id={ids.title}
          name="title"
          defaultValue={form.valueOf("title", defaults.title)}
          required
          maxLength={SUPPLY_TITLE_MAX}
          autoComplete="off"
          placeholder="Budget planner for students"
          {...describe(ids.title, { hint: true, error: form.fieldError("title") })}
        />
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          id={ids.format}
          label="Format"
          hint="The kind of product you picture."
          error={form.fieldError("format")}
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
          id={ids.targetPrice}
          label="Target price"
          optional
          hint="What your audience would pay, once. In euros."
          error={form.fieldError("targetPrice")}
        >
          <MoneyInput
            id={ids.targetPrice}
            name="targetPrice"
            currency={SUPPLY_CURRENCY}
            defaultValue={form.valueOf("targetPrice", defaults.targetPrice)}
            placeholder="19"
            {...describe(ids.targetPrice, { hint: true, error: form.fieldError("targetPrice") })}
          />
        </Field>
      </div>

      <Field
        id={ids.problem}
        label="Problem"
        optional={isDraft}
        hint="What does your audience struggle with, and what should the product do about it? Markdown works."
        error={form.fieldError("problem")}
      >
        <Textarea
          id={ids.problem}
          name="problem"
          defaultValue={form.valueOf("problem", defaults.problem)}
          maxLength={IDEA_PROBLEM_MAX}
          rows={5}
          placeholder="Students ask every week how to stop running out of money before the month ends…"
          {...describe(ids.problem, { hint: true, error: form.fieldError("problem") })}
        />
      </Field>

      <Field
        id={ids.audienceEvidence}
        label="Audience evidence"
        optional
        hint="Comments, polls or DMs that show people want this. Builders read this first."
        error={form.fieldError("audienceEvidence")}
      >
        <Textarea
          id={ids.audienceEvidence}
          name="audienceEvidence"
          defaultValue={form.valueOf("audienceEvidence", defaults.audienceEvidence)}
          maxLength={IDEA_EVIDENCE_MAX}
          rows={5}
          placeholder="40+ comments on my last video asked for a template…"
          {...describe(ids.audienceEvidence, {
            hint: true,
            error: form.fieldError("audienceEvidence"),
          })}
        />
      </Field>

      <Field
        id={ids.topics}
        label="Topics"
        optional={isDraft}
        hint={`What it's about, so the right builders find it. Press Enter or a comma after each, up to ${TOPICS_MAX}.`}
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
          placeholder="budgeting, students"
          describedBy={
            describe(ids.topics, { hint: true, error: form.fieldError("topics") })[
              "aria-describedby"
            ]
          }
          invalid={Boolean(form.fieldError("topics"))}
        />
      </Field>

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
