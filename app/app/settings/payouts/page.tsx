import { CalendarClock, CircleAlert, FileSignature, Info, Landmark } from "lucide-react"
import type { Metadata } from "next"
import type { ReactNode } from "react"

import { PayoutsStatusCard } from "@/components/payouts/payouts-status-card"
import { StartPayoutsForm } from "@/components/payouts/start-payouts-form"
import { StripeDashboardButton } from "@/components/payouts/stripe-dashboard-button"
import { PageHeader } from "@/components/shared/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { requireOnboardedUser } from "@/lib/auth/session"
import { env } from "@/lib/env"
import { formatMoney } from "@/lib/money"
import { payoutsStatusOf, type PayoutsStatus } from "@/lib/payouts/readiness"
import type { StripeAccountRow } from "@/lib/stripe/connect"
import { payoutCountryOptions, type PayoutCountry } from "@/lib/stripe/countries"
import { loadPayoutsPageState } from "@/lib/stripe/page-state"
import { payoutsErrorMessage } from "@/lib/stripe/paths"

export const metadata: Metadata = { title: "Payouts" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/**
 * Settings → Payouts (§12): the user's Stripe Connect status (not started, action needed,
 * verifying, restricted, ready) with the fitting action: start or continue Stripe onboarding, or
 * open the Stripe Express dashboard. Stripe's `return_url` lands here with `?return=1`.
 */
export default async function PayoutsSettingsPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const params = await searchParams
  const { account, defaultCountry, refreshFailed } = await loadPayoutsPageState(user.id, {
    returned: params.return === "1",
  })
  const status = payoutsStatusOf(account)
  const errorMessage = payoutsErrorMessage(params.error)

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title="Payouts"
        description="How your share of each sale reaches your bank account, through Stripe."
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
        details={
          account
            ? {
                country: account.country,
                payoutsEnabled: account.payoutsEnabled,
                transfersCapability: account.transfersCapability,
                updatedFromStripeAt: account.updatedFromStripeAt,
              }
            : null
        }
        actions={cardActions(status, account, defaultCountry)}
      />

      <section aria-labelledby="how-payouts-work" className="space-y-4">
        <h2 id="how-payouts-work" className="text-base font-semibold">
          How payouts work
        </h2>
        <ul className="grid gap-4 sm:grid-cols-3">
          <Fact icon={<CalendarClock className="size-5" aria-hidden="true" />}>
            Each sale is held for {env.HOLD_DAYS} days so refunds can be handled. After that your
            share is sent to Stripe in a daily batch.
          </Fact>
          <Fact icon={<Landmark className="size-5" aria-hidden="true" />}>
            We send your balance once it reaches {formatMoney(env.MIN_PAYOUT_CENTS, "eur")}. Stripe
            then pays it out to your bank on your Stripe payout schedule.
          </Fact>
          <Fact icon={<FileSignature className="size-5" aria-hidden="true" />}>
            You need payouts ready before you can sign a collaboration agreement, and so does your
            partner.
          </Fact>
        </ul>
      </section>
    </div>
  )
}

function cardActions(
  status: PayoutsStatus,
  account: StripeAccountRow | null,
  defaultCountry: PayoutCountry | null,
): ReactNode {
  switch (status.kind) {
    case "not_started":
      return (
        <StartPayoutsForm
          from="settings"
          label="Set up payouts with Stripe"
          countries={payoutCountryOptions()}
          defaultCountry={defaultCountry}
        />
      )
    case "action_required":
      return (
        <>
          <StartPayoutsForm from="settings" label="Continue onboarding" />
          {account?.detailsSubmitted ? <StripeDashboardButton /> : null}
        </>
      )
    case "verifying":
    case "restricted":
    case "ready":
      return <StripeDashboardButton />
  }
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3 rounded-xl border bg-card p-4 text-sm text-muted-foreground sm:flex-col">
      <span className="text-primary">{icon}</span>
      <span>{children}</span>
    </li>
  )
}
