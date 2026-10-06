import "server-only"

import { and, count, eq, isNotNull, isNull } from "drizzle-orm"

import { resolveCheckoutAttribution } from "@/lib/attribution/resolve"
import { requestCountry, userAgentHash } from "@/lib/attribution/request-context"
import { ATTRIBUTION_COOKIE, DISCOUNT_PARAM, REF_PARAM } from "@/lib/attribution/cookie"
import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import { launches, licenseKeys, trackedLinks } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { newId } from "@/lib/ids"
import { isValidSlug } from "@/lib/launches/fields"
import { isSellable } from "@/lib/launches/status"
import { reportError } from "@/lib/observability"
import { clientIp, rateLimit, retryAfterSeconds } from "@/lib/ratelimit"
import { CHECKOUT_SESSION_TTL_SECONDS, taxCodeFor } from "@/lib/stripe/checkout-shared"
import type { CheckoutGateway } from "@/lib/stripe/gateway"
import { StripeGatewayError } from "@/lib/stripe/shared"
import { absoluteUrl } from "@/lib/urls"

import { messagePageResponse } from "./html"

/**
 * `POST /p/<slug>/checkout` (§7.2, §10, §12; CLAUDE.md §19.31 "Checkout and orders", §19.34): the
 * product page's Buy button.
 *
 * 1. Rate limit per IP (`RATE_LIMITS.checkout`).
 * 2. The launch must be `live` with a price and a delivery type; a `license_key` launch needs at
 *    least one unassigned key ("Sold out" otherwise).
 * 3. `orderRef = newId()`: it becomes `orders.id` when the payment completes.
 * 4. Attribution: the `attr` cookie when it names an enabled link of this launch, else `?ref=`
 *    (`resolveCheckoutAttribution`). A `?code=` that is the discount code of an enabled link of
 *    this launch pre-applies its Stripe promotion code (the completion then attributes the order to
 *    that link); otherwise Stripe's page lets the buyer type one.
 * 5. `createCheckoutSession` (idempotency key `checkout:<orderRef>`), `checkout.started`, and 303
 *    to the session's URL (Stripe's page, or the fake one).
 *
 * Refusals answer a small HTML page with a link back to the product (a route handler cannot render
 * the app's pages). GET (e.g. reloading the URL) goes back to the product page.
 */

export type StartCheckoutDeps = { db: DbOrTx; gateway: CheckoutGateway }

const DISCOUNT_CODE_PATTERN = /^[A-Za-z0-9]{4,20}$/

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return null
}

function productLink(slug: string) {
  return { href: `/p/${slug}`, label: "Back to the product" }
}

export function checkoutGetResponse(slug: string): Response {
  const target = isValidSlug(slug) ? `/p/${slug}` : "/"
  return new Response(null, {
    status: 303,
    headers: { Location: absoluteUrl(target), "Cache-Control": "no-store" },
  })
}

export async function handleCheckoutRequest(
  request: Request,
  slug: string,
  deps: StartCheckoutDeps,
): Promise<Response> {
  if (!isValidSlug(slug)) {
    return messagePageResponse({
      status: 404,
      title: "Product not found",
      body: "This product doesn't exist. Check the link, or ask whoever shared it for a new one.",
      link: { href: "/", label: "Go to the home page" },
    })
  }

  const limit = await rateLimit("checkout", clientIp(request.headers))
  if (!limit.success) {
    return messagePageResponse({
      status: 429,
      title: "Too many attempts",
      body: "You started checkout several times in a row. Wait a minute, then try again.",
      link: productLink(slug),
      headers: { "Retry-After": String(retryAfterSeconds(limit)) },
    })
  }

  const [launch] = await deps.db
    .select({
      id: launches.id,
      title: launches.title,
      status: launches.status,
      priceCents: launches.priceCents,
      currency: launches.currency,
      deliveryType: launches.deliveryType,
      taxCode: launches.taxCode,
    })
    .from(launches)
    .where(eq(launches.slug, slug))
  if (!launch || launch.priceCents === null || launch.deliveryType === null) {
    return messagePageResponse({
      status: 404,
      title: "Product not found",
      body: "This product doesn't exist. Check the link, or ask whoever shared it for a new one.",
      link: { href: "/", label: "Go to the home page" },
    })
  }
  if (!isSellable(launch.status)) {
    return messagePageResponse({
      status: 409,
      title: "Not available right now",
      body: "This product can't be bought at the moment. Nothing was charged.",
      link: productLink(slug),
    })
  }
  if (launch.deliveryType === "license_key") {
    const [keys] = await deps.db
      .select({ n: count() })
      .from(licenseKeys)
      .where(and(eq(licenseKeys.launchId, launch.id), isNull(licenseKeys.orderId)))
    if ((keys?.n ?? 0) === 0) {
      return messagePageResponse({
        status: 409,
        title: "Sold out",
        body: "All license keys for this product are sold. Check back later. Nothing was charged.",
        link: productLink(slug),
      })
    }
  }

  const url = new URL(request.url)
  const attribution = await resolveCheckoutAttribution(deps.db, {
    launchId: launch.id,
    cookie: readCookie(request.headers.get("cookie"), ATTRIBUTION_COOKIE),
    ref: url.searchParams.get(REF_PARAM),
  })
  const promotionCodeId = await promotionCodeFor(
    deps.db,
    launch.id,
    url.searchParams.get(DISCOUNT_PARAM),
  )

  const orderRef = newId()
  const at = now()
  let sessionUrl: string | null | undefined
  try {
    const session = await deps.gateway.createCheckoutSession(
      {
        orderRef,
        launchId: launch.id,
        trackedLinkId: attribution.trackedLinkId,
        attribution: attribution.attribution,
        productName: launch.title,
        priceCents: launch.priceCents,
        currency: launch.currency,
        taxCode: taxCodeFor({ deliveryType: launch.deliveryType, taxCode: launch.taxCode }),
        // Stripe replaces the literal `{CHECKOUT_SESSION_ID}` (it must not be URL-encoded).
        successUrl: `${absoluteUrl(`/p/${slug}/success`)}?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: absoluteUrl(`/p/${slug}`),
        expiresAt: Math.floor(at.getTime() / 1000) + CHECKOUT_SESSION_TTL_SECONDS,
        promotionCodeId,
      },
      { idempotencyKey: `checkout:${orderRef}` },
    )
    sessionUrl = session.url
  } catch (error) {
    if (!(error instanceof StripeGatewayError)) {
      reportError(error, { tags: { area: "checkout" }, extra: { launchId: launch.id } })
    } else {
      reportError(error, {
        tags: { area: "checkout", stripe_code: error.code },
        extra: { launchId: launch.id },
      })
    }
  }
  if (!sessionUrl) {
    return messagePageResponse({
      status: 502,
      title: "Checkout isn't available right now",
      body: "We couldn't reach our payment provider. Nothing was charged. Try again in a moment.",
      link: productLink(slug),
    })
  }

  await track(
    "checkout.started",
    {
      actorUserId: null,
      subjectType: "launch",
      subjectId: launch.id,
      properties: {
        tracked_link_id: attribution.trackedLinkId,
        price_cents: launch.priceCents,
        currency: launch.currency,
      },
      context: {
        ip_country: requestCountry(request.headers),
        ua_hash: userAgentHash(request.headers.get("user-agent")),
      },
      occurredAt: at,
    },
    deps.db,
  )

  return new Response(null, {
    status: 303,
    headers: {
      Location: sessionUrl,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}

/**
 * The Stripe promotion code behind `?code=`, when it is the discount code of an enabled tracked
 * link of this launch that exists at Stripe; else null (the buyer may still type a code there).
 */
async function promotionCodeFor(
  database: DbOrTx,
  launchId: string,
  code: string | null,
): Promise<string | null> {
  if (!code || !DISCOUNT_CODE_PATTERN.test(code)) return null
  const [link] = await database
    .select({ promotionCodeId: trackedLinks.stripePromotionCodeId })
    .from(trackedLinks)
    .where(
      and(
        eq(trackedLinks.launchId, launchId),
        eq(trackedLinks.discountCode, code.toUpperCase()),
        isNull(trackedLinks.disabledAt),
        isNotNull(trackedLinks.stripePromotionCodeId),
      ),
    )
  return link?.promotionCodeId ?? null
}
