"use client"

import { CircleAlert, ExternalLink, Loader2 } from "lucide-react"
import { useActionState, useId } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { startPayoutsOnboarding } from "@/lib/stripe/actions"
import type { PayoutCountry } from "@/lib/stripe/countries"
import type { PayoutsPage } from "@/lib/stripe/paths"
import { cn } from "@/lib/utils"

/**
 * "Set up payouts" / "Continue with Stripe": posts to `startPayoutsOnboarding`, which redirects to
 * Stripe's hosted onboarding. Before the account exists, `countries` shows the country picker
 * (the country of a Stripe account cannot be changed later).
 */
export function StartPayoutsForm({
  from,
  label,
  countries,
  defaultCountry,
  variant = "default",
}: {
  from: PayoutsPage
  label: string
  /** Country options; omit once the account exists. */
  countries?: readonly { code: PayoutCountry; name: string }[]
  defaultCountry?: PayoutCountry | null
  variant?: "default" | "outline"
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) =>
      startPayoutsOnboarding(formData),
    null,
  )
  const id = useId()
  const error = state && !state.ok ? state : null
  const countryError = error?.fieldErrors?.country?.[0]
  const selectId = `${id}-country`
  const hintId = `${id}-country-hint`
  const errorId = `${id}-country-error`

  return (
    <form action={formAction} className="w-full space-y-4">
      <input type="hidden" name="from" value={from} />

      {error && !countryError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error.error}</AlertDescription>
        </Alert>
      ) : null}

      {countries ? (
        <div className="space-y-2">
          <label htmlFor={selectId} className="text-sm leading-none font-medium">
            Country you&apos;ll be paid in
          </label>
          <select
            id={selectId}
            name="country"
            required
            defaultValue={defaultCountry ?? ""}
            aria-invalid={countryError ? true : undefined}
            aria-describedby={countryError ? `${hintId} ${errorId}` : hintId}
            className={cn(
              "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none sm:max-w-xs md:text-sm dark:bg-input/30",
              "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
            )}
          >
            <option value="" disabled>
              Choose a country
            </option>
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </select>
          <p id={hintId} className="text-sm text-muted-foreground">
            Where you or your business is based. Stripe can&apos;t change it later.
          </p>
          {countryError ? (
            <p id={errorId} className="text-sm text-destructive">
              {countryError}
            </p>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" variant={variant} disabled={pending} className="w-full sm:w-auto">
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <ExternalLink aria-hidden="true" />
        )}
        {pending ? "Opening Stripe…" : label}
      </Button>
    </form>
  )
}
