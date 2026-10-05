"use client"

import { ArrowRight, Loader2, Save } from "lucide-react"
import { useId } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { Availability, DealPreference } from "@/lib/db/schema/enums"
import { saveBuilderProfileAction } from "@/lib/profiles/actions"
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_VALUES,
  BIO_MAX,
  DEAL_PREFERENCE_LABELS,
  DEAL_PREFERENCE_VALUES,
  DISPLAY_NAME_MAX,
  TAGS_MAX,
  type ProfileFormSource,
} from "@/lib/profiles/fields"

import { describe, Field, FormErrorAlert, RadioCard, useFormAction } from "./form-kit"
import { HandleField } from "./handle-field"

export type BuilderProfileFormDefaults = {
  displayName: string
  handle: string
  bio: string | null
  skills: readonly string[]
  stack: readonly string[]
  availability: Availability
  dealPreference: DealPreference
}

const FIELDS = [
  "displayName",
  "handle",
  "bio",
  "skills",
  "stack",
  "availability",
  "dealPreference",
] as const

/**
 * The builder profile (§5 builder_profiles): name, handle, bio, skills, stack, availability and
 * deal preference. `onboarding` creates it and continues; `settings` saves in place.
 */
export function BuilderProfileForm({
  source,
  defaults,
  sharedHandleNote,
}: {
  source: ProfileFormSource
  defaults: BuilderProfileFormDefaults
  sharedHandleNote?: string
}) {
  const id = useId()
  const form = useFormAction(saveBuilderProfileAction)
  const ids = {
    displayName: `${id}-name`,
    handle: `${id}-handle`,
    bio: `${id}-bio`,
    skills: `${id}-skills`,
    stack: `${id}-stack`,
    availability: `${id}-availability`,
    dealPreference: `${id}-deal`,
  }
  const availability = form.valueOf("availability", defaults.availability)
  const dealPreference = form.valueOf("dealPreference", defaults.dealPreference)
  const saved = source === "settings" && form.result?.ok === true

  return (
    <form action={form.formAction} className="space-y-6" noValidate>
      <input type="hidden" name="from" value={source} />
      {form.error && form.hasFormError(FIELDS) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          id={ids.displayName}
          label="Name"
          hint="Your name or your studio's."
          error={form.fieldError("displayName")}
        >
          <Input
            id={ids.displayName}
            name="displayName"
            defaultValue={form.valueOf("displayName", defaults.displayName)}
            required
            maxLength={DISPLAY_NAME_MAX}
            autoComplete="nickname"
            {...describe(ids.displayName, { hint: true, error: form.fieldError("displayName") })}
          />
        </Field>
        <HandleField
          id={ids.handle}
          defaultValue={form.valueOf("handle", defaults.handle)}
          error={form.fieldError("handle")}
          publicPathPrefix="/b/"
          sharedNote={sharedHandleNote}
        />
      </div>

      <Field
        id={ids.bio}
        label="Bio"
        optional
        hint={`What you build and for whom. Up to ${BIO_MAX} characters.`}
        error={form.fieldError("bio")}
      >
        <Textarea
          id={ids.bio}
          name="bio"
          defaultValue={form.valueOf("bio", defaults.bio ?? "")}
          maxLength={BIO_MAX}
          rows={4}
          placeholder="I build small web apps and AI tools that creators can sell to their audience."
          {...describe(ids.bio, { hint: true, error: form.fieldError("bio") })}
        />
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          id={ids.skills}
          label="Skills"
          optional
          hint={`What you're good at, separated by commas. Up to ${TAGS_MAX}.`}
          error={form.fieldError("skills")}
        >
          <Input
            id={ids.skills}
            name="skills"
            defaultValue={form.valueOf("skills", defaults.skills.join(", "))}
            placeholder="Web apps, AI tools, Notion templates"
            {...describe(ids.skills, { hint: true, error: form.fieldError("skills") })}
          />
        </Field>
        <Field
          id={ids.stack}
          label="Stack"
          optional
          hint={`Languages and tools you build with, separated by commas. Up to ${TAGS_MAX}.`}
          error={form.fieldError("stack")}
        >
          <Input
            id={ids.stack}
            name="stack"
            defaultValue={form.valueOf("stack", defaults.stack.join(", "))}
            placeholder="TypeScript, Next.js, Postgres"
            {...describe(ids.stack, { hint: true, error: form.fieldError("stack") })}
          />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm leading-none font-medium">Availability</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {AVAILABILITY_VALUES.map((value) => (
            <RadioCard
              key={value}
              name="availability"
              value={value}
              title={AVAILABILITY_LABELS[value].title}
              description={AVAILABILITY_LABELS[value].description}
              defaultChecked={availability === value}
              required
            />
          ))}
        </div>
        {form.fieldError("availability") ? (
          <p className="text-sm text-destructive" role="alert">
            {form.fieldError("availability")}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm leading-none font-medium">How you like to be paid</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {DEAL_PREFERENCE_VALUES.map((value) => (
            <RadioCard
              key={value}
              name="dealPreference"
              value={value}
              title={DEAL_PREFERENCE_LABELS[value].title}
              description={DEAL_PREFERENCE_LABELS[value].description}
              defaultChecked={dealPreference === value}
              required
            />
          ))}
        </div>
        {form.fieldError("dealPreference") ? (
          <p className="text-sm text-destructive" role="alert">
            {form.fieldError("dealPreference")}
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-2 border-t pt-6 sm:flex-row sm:items-center sm:justify-end">
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground sm:mr-auto">
            Saved.
          </p>
        ) : null}
        <Button type="submit" disabled={form.pending} className="w-full sm:w-auto">
          {source === "onboarding" ? (
            <>
              Continue
              {form.pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
            </>
          ) : (
            <>
              {form.pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              Save builder profile
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
