import { ArrowLeft, Banknote, CircleAlert, FileSignature, Info, ShieldCheck } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import type { ReactNode } from "react"

import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { SkipStepButton } from "@/components/onboarding/skip-step-button"
import { PayoutsStatusCard } from "@/components/payouts/payouts-status-card"
import { StartPayoutsForm } from "@/components/payouts/start-payouts-form"
import { StripeDashboardButton } from "@/components/payouts/stripe-dashboard-button"
import { PageHeader } from "@/components/shared/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { env } from "@/lib/env"
import { requireOnboardingStep } from "@/lib/onboarding/page"
import { payoutsStatusOf, type PayoutsStatus } from "@/lib/payouts/readiness"
import { payoutCountryOptions, type PayoutCountry } from "@/lib/stripe/countries"
import { loadPayoutsPageState } from "@/lib/stripe/page-state"
import { payoutsErrorMessage } from "@/lib/stripe/paths"

import { FinishPayoutsStepButton } from "./finish-step-button"

export const metadata: Metadata = { title: "Set up payouts" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/**
 * Last onboarding step (§12, §16 Phase 1): Stripe Connect payouts. "Set up payouts" creates the
 * connected account and opens Stripe's hosted onboarding; coming back (`?return=1`) re-fetches the
 * account. Once payouts are ready (or Stripe is verifying what the user submitted), "Finish"
 * records the step; "Do this later" skips it (payouts are still needed to sign an agreement).
 */
export default async function OnboardingPayoutsPage({ searchParams }: Props) {
  const { user, progress } = await requireOnboardingStep("payouts")
  const params = await searchParams
  const { account, defaultCountry, refreshFailed } = await loadPayoutsPageState(user.id, {
    returned: params.return === "1",
  })
  const status = payoutsStatusOf(account)
  const errorMessage = payoutsErrorMessage(params.error)
  const canFinish = status.kind === "ready" || status.kind === "verifying"

  return (
    <div className="space-y-8">
      <OnboardingProgress progress={progress} />

      <PageHeader
        title="Get paid for what you sell"
        description="Set up payouts with Stripe, our payments partner, so your share of every sale reaches your bank account."
      />

      {errorMessage ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      {refreshFailed ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>
            We couldn&apos;t reach Stripe to refresh your status, so it may be a few minutes old.
          </AlertDescription>
        </Alert>
      ) : null}

      <PayoutsStatusCard
        status={status}
        holdDays={env.HOLD_DAYS}
        actions={cardActions(status, defaultCountry)}
      />

      <section aria-labelledby="why-payouts" className="space-y-4">
        <h2 id="why-payouts" className="text-base font-semibold">
          Why we ask for this
        </h2>
        <ul className="grid gap-4 sm:grid-cols-3">
          <Reason icon={<Banknote className="size-5" aria-hidden="true" />}>
            Buyers pay through Stripe. After a {env.HOLD_DAYS}-day hold, your share of each sale is
            sent to your Stripe account and paid out to your bank.
          </Reason>
          <Reason icon={<ShieldCheck className="size-5" aria-hidden="true" />}>
            Stripe checks your identity and bank details. We never see your ID documents or bank
            account number.
          </Reason>
          <Reason icon={<FileSignature className="size-5" aria-hidden="true" />}>
            Both sides of a collaboration need payouts set up before signing an agreement. You can
            skip this now and finish it from Settings later.
          </Reason>
        </ul>
      </section>

      <div className="flex flex-col-reverse gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
        {progress.previousHref ? (
          <Button asChild variant="ghost" className="self-start">
            <Link href={progress.previousHref}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Link>
          </Button>
        ) : (
          <span />
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
          {canFinish ? null : <SkipStepButton step="payouts" />}
          {canFinish ? (
            <FinishPayoutsStepButton label={progress.nextHref ? "Continue" : "Finish"} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function cardActions(status: PayoutsStatus, defaultCountry: PayoutCountry | null): ReactNode {
  switch (status.kind) {
    case "not_started":
      return (
        <StartPayoutsForm
          from="onboarding"
          label="Set up payouts with Stripe"
          countries={payoutCountryOptions()}
          defaultCountry={defaultCountry}
        />
      )
    case "action_required":
      return <StartPayoutsForm from="onboarding" label="Continue with Stripe" />
    case "restricted":
      return <StripeDashboardButton />
    case "verifying":
    case "ready":
      return null
  }
}

function Reason({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3 rounded-xl border bg-card p-4 text-sm text-muted-foreground sm:flex-col">
      <span className="text-primary">{icon}</span>
      <span>{children}</span>
    </li>
  )
}
