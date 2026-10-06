import { CircleAlert, CircleCheck, Clock, MailCheck, PackageOpen } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { SyncRefresher } from "@/components/social/sync-refresher"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { headers } from "next/headers"

import { loadSuccessState, SUCCESS_STRIPE_LOOKUPS } from "@/lib/checkout/success"
import { getDb } from "@/lib/db/client"
import { clientIp, rateLimit } from "@/lib/ratelimit"
import { getStripeGateway } from "@/lib/stripe/gateway"

/**
 * After paying (§12 `/p/[slug]/success`; CLAUDE.md §19.31, §19.34): Stripe sends the buyer here
 * with `?session_id=`. Shows the order once the webhook created it ("check your email" and the
 * access link), refreshes itself while the webhook is on its way, and explains delayed payments,
 * failed payments, abandoned and expired checkouts. Dynamic and never indexed; the token-bearing
 * access link leaves no `Referer`.
 */

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Thanks for your purchase",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ session_id?: string | string[] }>
}

export default async function CheckoutSuccessPage({ params, searchParams }: Props) {
  const { slug } = await params
  const { session_id: raw } = await searchParams
  const sessionId = typeof raw === "string" ? raw : null
  const ip = clientIp(await headers())
  const state = await loadSuccessState(
    getDb(),
    getStripeGateway(),
    { slug, sessionId },
    {
      allowStripeLookup: async () =>
        (await rateLimit("checkout-success", ip, SUCCESS_STRIPE_LOOKUPS)).success,
    },
  )
  const back = (
    <Button asChild variant="outline" className="h-11 w-full sm:w-auto md:h-9">
      <Link href={`/p/${slug}`}>Back to the product</Link>
    </Button>
  )

  return (
    <div className="mx-auto max-w-xl space-y-6">
      {state.kind === "paid" ? (
        <>
          <header className="space-y-2">
            <CircleCheck
              className="size-10 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <h1 className="text-2xl font-semibold tracking-tight text-balance">
              Thanks, your payment went through
            </h1>
            <p className="text-muted-foreground">
              “{state.launchTitle}” is yours. Order reference {state.reference}.
            </p>
          </header>
          <Alert>
            <MailCheck aria-hidden="true" />
            <AlertTitle>Check your email</AlertTitle>
            <AlertDescription>
              We sent your receipt and a link to your purchase. Keep that email: the link is how you
              get back to it.
            </AlertDescription>
          </Alert>
          {state.accessHref ? (
            <Button asChild size="lg" className="h-12 w-full text-base sm:w-auto">
              <a href={state.accessHref} rel="noreferrer">
                <PackageOpen aria-hidden="true" />
                Open your purchase
              </a>
            </Button>
          ) : state.refunded ? (
            <p className="text-sm text-muted-foreground">This order was refunded.</p>
          ) : null}
        </>
      ) : null}

      {state.kind === "finishing" ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Finishing your order…</h1>
          <p className="text-muted-foreground">
            Your payment for “{state.launchTitle}” went through. We&apos;re setting up your access;
            this page updates by itself.
          </p>
          <SyncRefresher message="Confirming your payment…" intervalMs={2000} maxAttempts={30} />
        </>
      ) : null}

      {state.kind === "processing" ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Your payment is processing</h1>
          <Alert>
            <Clock aria-hidden="true" />
            <AlertTitle>We&apos;ll email you when it clears</AlertTitle>
            <AlertDescription>
              Bank payments for “{state.launchTitle}” can take a few days. As soon as it clears, we
              email your receipt and the link to your purchase.
            </AlertDescription>
          </Alert>
          <SyncRefresher message="Waiting for your bank…" intervalMs={3000} maxAttempts={20} />
          {back}
        </>
      ) : null}

      {state.kind === "failed" ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">
            Your payment didn&apos;t go through
          </h1>
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Nothing was charged</AlertTitle>
            <AlertDescription>
              Your bank declined the payment for “{state.launchTitle}”. You can try again with
              another way to pay.
            </AlertDescription>
          </Alert>
          {back}
        </>
      ) : null}

      {state.kind === "unpaid" ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">You haven&apos;t paid yet</h1>
          <p className="text-muted-foreground">
            The checkout for “{state.launchTitle}” is still open. Nothing was charged.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            {state.resumeUrl ? (
              <Button asChild className="h-11 w-full sm:w-auto md:h-9">
                <a href={state.resumeUrl}>Continue to payment</a>
              </Button>
            ) : null}
            {back}
          </div>
        </>
      ) : null}

      {state.kind === "expired" ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">This checkout expired</h1>
          <p className="text-muted-foreground">
            Nothing was charged for “{state.launchTitle}”. Start again from the product page.
          </p>
          {back}
        </>
      ) : null}

      {state.kind === "not_found" ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">
            We couldn&apos;t find this checkout
          </h1>
          <p className="text-muted-foreground">
            If you paid, your receipt and access link are in your email.
          </p>
          {back}
        </>
      ) : null}
    </div>
  )
}
