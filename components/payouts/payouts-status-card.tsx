import { CircleAlert, CircleCheck, Clock, ShieldAlert, Wallet, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardTitle } from "@/components/ui/card"
import type { StripeCapabilityStatus } from "@/lib/db/schema"
import type { PayoutsStatus } from "@/lib/payouts/readiness"
import { countryName } from "@/lib/stripe/countries"
import { cn } from "@/lib/utils"

/**
 * Payout status for `/onboarding/payouts` and `/app/settings/payouts` (§12): where the user stands
 * with Stripe (`payoutsStatusOf()` in lib/payouts/readiness.ts), what that means, and the actions
 * that fit (passed in as `actions`).
 */

type StatusCopy = {
  icon: LucideIcon
  badge: string
  title: string
  description: (status: PayoutsStatus, holdDays: number) => string
  tone: "muted" | "warning" | "success" | "danger"
}

const STATUS_COPY: Record<PayoutsStatus["kind"], StatusCopy> = {
  not_started: {
    icon: Wallet,
    badge: "Not started",
    title: "Payouts aren't set up yet",
    description: () =>
      "Connect a Stripe account so your share of each sale can be paid to your bank account. It takes about five minutes.",
    tone: "muted",
  },
  action_required: {
    icon: CircleAlert,
    badge: "Action needed",
    title: "Stripe needs a few more details",
    description: (status) =>
      status.kind === "action_required" && status.dueCount > 0
        ? `${status.dueCount} ${status.dueCount === 1 ? "item is" : "items are"} still missing. Continue with Stripe to finish; your progress is saved.`
        : "Continue with Stripe to finish the form; your progress is saved.",
    tone: "warning",
  },
  verifying: {
    icon: Clock,
    badge: "Verifying",
    title: "Stripe is checking your details",
    description: () =>
      "This usually takes a few minutes, occasionally a couple of days. We'll email you as soon as payouts are ready.",
    tone: "muted",
  },
  restricted: {
    icon: ShieldAlert,
    badge: "Restricted",
    title: "Stripe couldn't verify this account",
    description: () =>
      "Payouts are paused. Open your Stripe dashboard to see why, or contact Stripe support to resolve it.",
    tone: "danger",
  },
  ready: {
    icon: CircleCheck,
    badge: "Ready",
    title: "Payouts are ready",
    description: (status, holdDays) =>
      `Your share of every sale is paid to your bank account once the ${holdDays}-day hold ends.` +
      (status.kind === "ready" && status.dueCount > 0
        ? " Stripe will need a little more information soon; check your Stripe dashboard."
        : ""),
    tone: "success",
  },
}

const TONE_CLASSES: Record<StatusCopy["tone"], string> = {
  muted: "bg-muted text-muted-foreground",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  danger: "bg-destructive/15 text-destructive",
}

const CAPABILITY_LABELS: Record<StripeCapabilityStatus, string> = {
  active: "Active",
  pending: "Pending review",
  inactive: "Not active yet",
  unrequested: "Not requested",
}

export type PayoutsAccountDetails = {
  country: string | null
  payoutsEnabled: boolean
  transfersCapability: StripeCapabilityStatus
  updatedFromStripeAt: Date | null
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
})

export function PayoutsStatusCard({
  status,
  holdDays,
  details,
  actions,
  className,
}: {
  status: PayoutsStatus
  holdDays: number
  /** Account facts (settings page); omit to show just the status. */
  details?: PayoutsAccountDetails | null
  actions?: ReactNode
  className?: string
}) {
  const copy = STATUS_COPY[status.kind]
  const Icon = copy.icon

  return (
    <Card className={className} role="region" aria-labelledby="payouts-status-title">
      <div className="flex items-start gap-4 px-6">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            TONE_CLASSES[copy.tone],
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <CardTitle id="payouts-status-title" className="leading-snug">
              {copy.title}
            </CardTitle>
            <Badge variant={status.kind === "ready" ? "default" : "outline"}>
              <span className="sr-only">Status: </span>
              {copy.badge}
            </Badge>
          </div>
          <CardDescription>{copy.description(status, holdDays)}</CardDescription>
        </div>
      </div>

      {details ? (
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail term="Country">
              {details.country ? countryName(details.country) : "Not set"}
            </Detail>
            <Detail term="Payouts to your bank">
              {details.payoutsEnabled ? "Enabled" : "Not enabled yet"}
            </Detail>
            <Detail term="Transfers from us">
              {CAPABILITY_LABELS[details.transfersCapability]}
            </Detail>
            <Detail term="Last update from Stripe">
              {details.updatedFromStripeAt
                ? `${dateFormat.format(details.updatedFromStripeAt)} UTC`
                : "Not yet"}
            </Detail>
          </dl>
        </CardContent>
      ) : null}

      {actions ? (
        <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {actions}
        </CardFooter>
      ) : null}
    </Card>
  )
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  )
}
