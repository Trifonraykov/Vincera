import { CircleSlash, Clock, Timer } from "lucide-react"
import type { Metadata } from "next"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"

import { RefundRequestForm } from "@/components/refunds/refund-request-form"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { agreementDate } from "@/lib/agreements/template-v1"
import { ACCESS_RATE_LIMIT } from "@/lib/delivery/access"
import { getDb } from "@/lib/db/client"
import { formatMoney } from "@/lib/money"
import { clientIp, rateLimit } from "@/lib/ratelimit"
import { submitRefundRequestAction } from "@/lib/refund-requests/actions"
import {
  REFUND_REASON_LABELS,
  REFUND_REFUSAL_MESSAGES,
  REFUND_STATUS_LABELS,
} from "@/lib/refund-requests/fields"
import { loadBuyerRefundContext } from "@/lib/refund-requests/service"

/**
 * Ask for a refund (§12 `/access/[token]/refund`, v1; CLAUDE.md §19.38). No account: the access
 * token is the key, as on `/access/[token]`. Dynamic, rate limited per IP (`access`), never
 * indexed and without a `Referer` (the layout). Within 14 days of payment, once per order, the
 * buyer picks a reason and may add a message; admins decide. Unknown tokens are 404s; a revoked
 * grant shows the plain "no longer available" text.
 */

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Ask for a refund" }

type Props = { params: Promise<{ token: string }> }

export default async function RefundRequestPage({ params }: Props) {
  const { token } = await params
  const limit = await rateLimit("access", clientIp(await headers()), ACCESS_RATE_LIMIT)
  if (!limit.success) {
    return (
      <Alert>
        <Timer aria-hidden="true" />
        <AlertTitle>Too many requests</AlertTitle>
        <AlertDescription>Wait a minute, then reload this page.</AlertDescription>
      </Alert>
    )
  }

  const context = await loadBuyerRefundContext(getDb(), token)
  if (!context) notFound()
  const back = (
    <p className="text-sm text-muted-foreground">
      <Link href={`/access/${token}`} className="underline underline-offset-4">
        Back to your purchase
      </Link>
    </p>
  )

  const header = (
    <header className="space-y-2">
      <p className="text-sm text-muted-foreground">Ask for a refund</p>
      <h1 className="text-2xl font-semibold tracking-tight text-balance break-words">
        {context.launchTitle}
      </h1>
      <p className="text-sm text-muted-foreground">Bought on {agreementDate(context.paidAt)}.</p>
    </header>
  )

  if (context.request) {
    return (
      <div className="space-y-6">
        {header}
        <Alert>
          <Clock aria-hidden="true" />
          <AlertTitle>{REFUND_STATUS_LABELS[context.request.status]}</AlertTitle>
          <AlertDescription>
            You asked for a refund of {formatMoney(context.request.amountCents, context.currency)}{" "}
            on {agreementDate(context.request.createdAt)} (
            {REFUND_REASON_LABELS[context.request.reason].toLowerCase()}).{" "}
            {context.request.status === "pending"
              ? "We email you the answer."
              : context.request.status === "approved"
                ? "The money goes back to the card or account you paid with."
                : "We emailed you why."}
          </AlertDescription>
        </Alert>
        {back}
      </div>
    )
  }

  if (context.refusal) {
    return (
      <div className="space-y-6">
        {header}
        <Alert>
          <CircleSlash aria-hidden="true" />
          <AlertTitle>A refund can&apos;t be requested here</AlertTitle>
          <AlertDescription>
            {REFUND_REFUSAL_MESSAGES[context.refusal]} If something is wrong, reply to your receipt
            email.
          </AlertDescription>
        </Alert>
        {back}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}
      <p className="text-sm text-pretty">
        You can ask for a refund of {formatMoney(context.amountLeftCents, context.currency)} until{" "}
        {agreementDate(context.windowEndsAt)}. Our team reads every request and emails you the
        answer; approved refunds go back to the card or account you paid with.
      </p>
      <RefundRequestForm action={submitRefundRequestAction.bind(null, token)} />
      {back}
    </div>
  )
}
