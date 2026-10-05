"use client"

import { ArrowRight, Loader2, Save } from "lucide-react"
import { useId } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { saveCreatorProfileAction } from "@/lib/profiles/actions"
import {
  BIO_MAX,
  DISPLAY_NAME_MAX,
  LANGUAGES_MAX,
  NICHE_MAX,
  type ProfileFormSource,
} from "@/lib/profiles/fields"
import { COMMON_LANGUAGE_COUNT, type Option } from "@/lib/profiles/locale"

import { describe, Field, FormErrorAlert, NativeSelect, useFormAction } from "./form-kit"
import { HandleField } from "./handle-field"

export type CreatorProfileFormDefaults = {
  displayName: string
  handle: string
  niche: string | null
  bio: string | null
  country: string | null
  languages: readonly string[]
}

const FIELDS = ["displayName", "handle", "niche", "bio", "country", "languages"] as const

/**
 * The creator profile (§5 creator_profiles): name, handle, niche, bio, country and languages.
 * `onboarding` creates it and continues to the next step; `settings` saves in place.
 */
export function CreatorProfileForm({
  source,
  defaults,
  countries,
  languages,
  sharedHandleNote,
}: {
  source: ProfileFormSource
  defaults: CreatorProfileFormDefaults
  countries: readonly Option<string>[]
  languages: readonly Option<string>[]
  sharedHandleNote?: string
}) {
  const id = useId()
  const form = useFormAction(saveCreatorProfileAction)
  const ids = {
    displayName: `${id}-name`,
    handle: `${id}-handle`,
    niche: `${id}-niche`,
    bio: `${id}-bio`,
    country: `${id}-country`,
    languages: `${id}-languages`,
  }
  const selectedLanguages = new Set(form.valuesFor("languages", defaults.languages))
  const common = languages.slice(0, COMMON_LANGUAGE_COUNT)
  const more = languages.slice(COMMON_LANGUAGE_COUNT)
  const moreSelected = more.some((language) => selectedLanguages.has(language.code))
  const saved = source === "settings" && form.result?.ok === true

  const languageCheckbox = (language: Option<string>) => (
    <label
      key={language.code}
      className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
    >
      <input
        type="checkbox"
        name="languages"
        value={language.code}
        defaultChecked={selectedLanguages.has(language.code)}
        className="size-4 accent-primary"
      />
      {language.name}
    </label>
  )

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
          hint="Your creator name, as your audience knows you."
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
          publicPathPrefix="/c/"
          sharedNote={sharedHandleNote}
        />
      </div>

      <Field
        id={ids.niche}
        label="Your niche"
        optional
        hint="What your content is about, in a few words. Builders search by it."
        error={form.fieldError("niche")}
      >
        <Input
          id={ids.niche}
          name="niche"
          defaultValue={form.valueOf("niche", defaults.niche ?? "")}
          maxLength={NICHE_MAX}
          placeholder="Budget cooking for students"
          {...describe(ids.niche, { hint: true, error: form.fieldError("niche") })}
        />
      </Field>

      <Field
        id={ids.bio}
        label="Bio"
        optional
        hint={`A few sentences for your public profile. Up to ${BIO_MAX} characters.`}
        error={form.fieldError("bio")}
      >
        <Textarea
          id={ids.bio}
          name="bio"
          defaultValue={form.valueOf("bio", defaults.bio ?? "")}
          maxLength={BIO_MAX}
          rows={4}
          placeholder="I make weekly videos about cooking well on a small budget."
          {...describe(ids.bio, { hint: true, error: form.fieldError("bio") })}
        />
      </Field>

      <Field
        id={ids.country}
        label="Where you're based"
        optional
        hint="Shown on your profile. It also preselects your payout country."
        error={form.fieldError("country")}
        className="sm:max-w-xs"
      >
        <NativeSelect
          id={ids.country}
          name="country"
          defaultValue={form.valueOf("country", defaults.country ?? "")}
          {...describe(ids.country, { hint: true, error: form.fieldError("country") })}
        >
          <option value="">Prefer not to say</option>
          {countries.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </NativeSelect>
      </Field>

      <fieldset className="space-y-3" aria-describedby={`${ids.languages}-hint`}>
        <legend className="text-sm leading-none font-medium">
          Languages your content is in{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </legend>
        <p id={`${ids.languages}-hint`} className="text-sm text-muted-foreground">
          Up to {LANGUAGES_MAX}. We match you with products for audiences that speak them.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {common.map(languageCheckbox)}
        </div>
        {more.length > 0 ? (
          <details open={moreSelected} className="group">
            <summary className="cursor-pointer text-sm font-medium text-primary underline-offset-4 hover:underline">
              More languages
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {more.map(languageCheckbox)}
            </div>
          </details>
        ) : null}
        {form.fieldError("languages") ? (
          <p className="text-sm text-destructive" role="alert">
            {form.fieldError("languages")}
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
              Save creator profile
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
