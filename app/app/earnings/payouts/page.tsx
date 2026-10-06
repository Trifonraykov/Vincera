import { Landmark } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { EarningsNav } from "@/components/earnings/earnings-nav"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { canViewOwnEarnings } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { formatMoney } from "@/lib/money"
import { listPayouts, type PayoutRow } from "@/lib/payouts/earnings"
import { payoutFailureMessage, TRANSFER_STATUS_LABELS } from "@/lib/payouts/failure-codes"

export const metadata: Metadata = { title: "Payouts" }

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

/**
 * Payouts (§12 `/app/earnings/payouts`; CLAUDE.md §19.35): the transfers to the user's Stripe
 * account, newest first, with their status (sent, failed with the reason in plain words, or
 * partly taken back after a refund).
 */
export default async function PayoutsPage() {
  const user = await requireOnboardedUser()
  authorizePage(canViewOwnEarnings(user), "/app")
  const payouts = await listPayouts(getDb(), { userId: user.id })

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Payouts"
        description="Money sent to your Stripe account. Stripe then pays it to your bank on your payout schedule."
      />
      <EarningsNav current="payouts" />
      {payouts.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No payouts yet"
          description="Once a sale has finished its hold period, your share goes out with the next daily payout."
          action={
            <Button asChild size="sm" variant="outline" className="h-11 sm:h-8">
              <Link href="/app/earnings">See your earnings</Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Your payouts">
          {payouts.map((payout) => (
            <PayoutItem key={payout.id} payout={payout} />
          ))}
        </ul>
      )}
    </div>
  )
}

function PayoutItem({ payout }: { payout: PayoutRow }) {
  const failed = payout.status === "failed"
  return (
    <li className="space-y-2 px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{dateFormat.format(payout.createdAt)}</p>
          <Badge
            variant={failed ? "destructive" : payout.status === "created" ? "secondary" : "outline"}
          >
            {TRANSFER_STATUS_LABELS[payout.status]}
          </Badge>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={
              failed
                ? "font-semibold text-muted-foreground tabular-nums line-through"
                : "font-semibold tabular-nums"
            }
          >
            {formatMoney(payout.amountCents, payout.currency)}
          </p>
          {payout.amountReversedCents > 0 ? (
            <p className="text-xs text-muted-foreground">
              {formatMoney(payout.amountReversedCents, payout.currency)} taken back for refunds
            </p>
          ) : null}
        </div>
      </div>
      {failed ? (
        <p className="text-muted-foreground">
          {payoutFailureMessage(payout.failureCode)}{" "}
          <Link
            href="/app/settings/payouts"
            className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4 sm:min-h-0"
          >
            Payout settings
          </Link>
        </p>
      ) : null}
      {payout.stripeTransferId ? (
        <p className="text-xs break-all text-muted-foreground">
          Reference: <span className="font-mono">{payout.stripeTransferId}</span>
        </p>
      ) : null}
    </li>
  )
}
