import { AlertCircle, CalendarClock, ShoppingBag, Wallet } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { EarningsNav } from "@/components/earnings/earnings-nav"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { canViewOwnEarnings } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { getDb } from "@/lib/db/client"
import type { OrderStatus } from "@/lib/db/schema/enums"
import { env } from "@/lib/env"
import { formatMoney } from "@/lib/money"
import { loadEarningsOverview, type RecentSale } from "@/lib/payouts/earnings"
import type { UserBalance } from "@/lib/ledger/types"

export const metadata: Metadata = { title: "Earnings" }

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

const ORDER_STATUS: Record<OrderStatus, { label: string; tone: "default" | "warning" }> = {
  paid: { label: "Paid", tone: "default" },
  partially_refunded: { label: "Partly refunded", tone: "warning" },
  refunded: { label: "Refunded", tone: "warning" },
  disputed: { label: "Chargeback", tone: "warning" },
}

/**
 * Earnings (§12 `/app/earnings`; CLAUDE.md §19.35): the user's own money from their launches.
 * Balances per currency (in the hold period with release dates, available for the next payout,
 * held by a chargeback, paid out), a breakdown per launch, and recent sales with the user's share.
 * Amounts only: buyers' emails are never shown to members.
 */
export default async function EarningsPage() {
  const user = await requireOnboardedUser()
  authorizePage(canViewOwnEarnings(user), "/app")
  const overview = await loadEarningsOverview(getDb(), { userId: user.id, at: now() })
  const hasMoney =
    overview.balances.length > 0 || overview.recentSales.length > 0 || overview.launches.length > 0

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Earnings"
        description={`Your share of every sale. It's held for ${env.HOLD_DAYS} days, then paid out daily once you have at least ${formatMoney(env.MIN_PAYOUT_CENTS, "eur")}.`}
      />
      <EarningsNav current="overview" />

      {overview.payouts !== "ready" ? (
        <div
          role="note"
          className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="flex gap-2">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {overview.payouts === "none"
                ? "Set up payouts so we can send you your earnings."
                : "Stripe still needs something before we can send you your earnings."}{" "}
              Your balance waits for you in the meantime.
            </span>
          </p>
          <Button asChild size="sm" variant="outline" className="h-11 shrink-0 sm:h-8">
            <Link href="/app/settings/payouts">Payout settings</Link>
          </Button>
        </div>
      ) : null}

      {!hasMoney ? (
        <EmptyState
          icon={Wallet}
          title="No earnings yet"
          description="When one of your launches makes a sale, your share shows up here."
          action={
            <Button asChild size="sm" className="h-11 sm:h-8">
              <Link href="/app/launches">Open your launches</Link>
            </Button>
          }
        />
      ) : (
        <>
          <section aria-labelledby="balances-heading" className="space-y-3">
            <h2 id="balances-heading" className="sr-only">
              Balances
            </h2>
            {overview.balances.map((balance) => (
              <BalanceCards key={balance.currency} balance={balance} />
            ))}
            {overview.feePendingCount > 0 ? (
              <p className="text-sm text-muted-foreground">
                {overview.feePendingCount === 1
                  ? "1 recent sale is still being confirmed by the card network; your share appears once Stripe settles it."
                  : `${overview.feePendingCount} recent sales are still being confirmed by the card network; your share appears once Stripe settles them.`}
              </p>
            ) : null}
          </section>

          {overview.releases.length > 0 ? (
            <section aria-labelledby="releases-heading" className="space-y-3">
              <h2 id="releases-heading" className="text-lg font-semibold">
                Coming out of the hold
              </h2>
              <ul className="divide-y rounded-xl border bg-card">
                {overview.releases.map((release) => (
                  <li
                    key={`${release.date}-${release.currency}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <CalendarClock className="size-4 text-muted-foreground" aria-hidden="true" />
                      {dateFormat.format(new Date(`${release.date}T00:00:00Z`))}
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatMoney(release.amountCents, release.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {overview.launches.length > 0 ? (
            <section aria-labelledby="launches-heading" className="space-y-3">
              <h2 id="launches-heading" className="text-lg font-semibold">
                By launch
              </h2>
              <ul className="space-y-2">
                {overview.launches.map((launch) => (
                  <li
                    key={`${launch.launchId}-${launch.currency}`}
                    className="rounded-xl border bg-card p-4"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-medium break-words">{launch.title}</h3>
                      <span className="font-semibold tabular-nums">
                        {formatMoney(launch.earnedCents + launch.refundedCents, launch.currency)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {launch.orderCount === 1 ? "1 sale" : `${launch.orderCount} sales`} ·{" "}
                      {formatMoney(launch.earnedCents, launch.currency)} earned
                      {launch.refundedCents !== 0
                        ? ` · ${formatMoney(-launch.refundedCents, launch.currency)} refunded`
                        : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="sales-heading" className="space-y-3">
            <h2 id="sales-heading" className="text-lg font-semibold">
              Recent sales
            </h2>
            {overview.recentSales.length === 0 ? (
              <EmptyState icon={ShoppingBag} title="No sales yet" />
            ) : (
              <ul className="divide-y rounded-xl border bg-card">
                {overview.recentSales.map((sale) => (
                  <SaleRow key={sale.orderId} sale={sale} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function BalanceCards({ balance }: { balance: UserBalance }) {
  const cells = [
    { label: "Available", value: balance.availableCents, hint: "Goes out with the next payout" },
    {
      label: "In the hold period",
      value: balance.pendingCents,
      hint: "Released on the dates below",
    },
    { label: "Paid out", value: balance.paidOutCents, hint: "Sent to your Stripe account" },
  ]
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {cells.map((cell) => (
          <div key={cell.label} className="rounded-xl border bg-card p-4">
            <dt className="text-sm text-muted-foreground">{cell.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {formatMoney(cell.value, balance.currency)}
            </dd>
            <dd className="mt-1 text-xs text-muted-foreground">{cell.hint}</dd>
          </div>
        ))}
      </dl>
      {balance.onHoldCents !== 0 ? (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          {formatMoney(balance.onHoldCents, balance.currency)} is held back while a buyer&apos;s
          chargeback is open. It&apos;s released if the dispute is won.
        </p>
      ) : null}
    </div>
  )
}

function SaleRow({ sale }: { sale: RecentSale }) {
  const status = ORDER_STATUS[sale.status]
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 space-y-1">
        <p className="font-medium break-words">{sale.launchTitle}</p>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>{dateFormat.format(sale.paidAt)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatMoney(sale.grossCents, sale.currency)} paid</span>
          {sale.status !== "paid" ? (
            <Badge
              variant={status.tone === "warning" ? "outline" : "secondary"}
              className={status.tone === "warning" ? "border-amber-500/60" : undefined}
            >
              {status.label}
            </Badge>
          ) : null}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-semibold tabular-nums">
          {sale.shareCents === null ? "Pending" : formatMoney(sale.shareCents, sale.currency)}
        </p>
        <p className="text-xs text-muted-foreground">your share</p>
      </div>
    </li>
  )
}
