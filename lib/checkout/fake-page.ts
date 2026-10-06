import "server-only"

import { after } from "next/server"
import type Stripe from "stripe"

import type { JsonObject } from "@/lib/db/schema"
import { env, stripeWebhookSecrets } from "@/lib/env"
import { formatMoney } from "@/lib/money"
import { reportError } from "@/lib/observability"
import { dataDir } from "@/lib/services"
import { countryName } from "@/lib/stripe/countries"
import {
  createFakeEvent,
  createFakeStripeStore,
  deliverFakeWebhook,
  type FakeStripeStore,
} from "@/lib/stripe/fake"
import {
  completeFakeCheckoutSession,
  FAKE_CHECKOUT_COUNTRIES,
  FAKE_PAYMENT_METHODS,
  fakeTaxRateBps,
  inclusiveTaxCents,
  readFakeCheckoutSession,
  settleFakeChargeFee,
  settleFakeDelayedPayment,
  type FakePaymentMethod,
} from "@/lib/stripe/fake-checkout"
import { escapeHtml, fakeStripePagesEnabled } from "@/lib/stripe/fake-pages"
import { absoluteUrl } from "@/lib/urls"

/**
 * The fake Stripe Checkout page (§19.3; CLAUDE.md §19.34), served by
 * `/api/dev/fake-stripe/checkout/[sessionId]` while Stripe is fake (404 otherwise).
 *
 * GET shows the product, the price with the VAT it includes, an email and country field, a
 * promotion-code field (when the session allows one), and one button per payment method. POST
 * pays the session (`completeFakeCheckoutSession`), delivers the events Stripe would send to the
 * real `/api/webhooks/stripe` over HTTP, signed with the platform endpoint's secret, then redirects
 * to the session's `success_url`, like Stripe:
 *
 * - card: `checkout.session.completed` (paid; the fee is known, so the ledger posts at once);
 * - card, fee pending: `checkout.session.completed`, then the fee settles and `charge.updated`;
 * - delayed method: `checkout.session.completed` (unpaid) now, and a moment after the redirect the
 *   payment settles and `checkout.session.async_payment_succeeded` (or `_failed`) is delivered.
 */

export type FakeCheckoutPageDeps = {
  store: FakeStripeStore
  appName: string
  /** Absolute URL of `/api/webhooks/stripe` (NEXT_PUBLIC_APP_URL, never the Host header). */
  webhookUrl: string
  /** The platform endpoint's secret: checkout events are platform events. */
  webhookSecret: string
  fetch?: typeof fetch
  /** Runs the delayed settlement after the response (`after()` in the route); tests await it. */
  later?: (task: () => Promise<void>) => void
  /** Delay before a delayed payment settles. */
  settleDelayMs?: number
}

const NO_STORE = { "Cache-Control": "no-store" } as const
const DEFAULT_SETTLE_DELAY_MS = 1500

export function fakeCheckoutPagesEnabled(): boolean {
  return fakeStripePagesEnabled()
}

export function fakeCheckoutPageDeps(): FakeCheckoutPageDeps {
  return {
    store: createFakeStripeStore(dataDir("fake-stripe")),
    appName: env.APP_NAME,
    webhookUrl: absoluteUrl("/api/webhooks/stripe"),
    webhookSecret: stripeWebhookSecrets().platform,
    later: (task) => after(task),
  }
}

export async function fakeCheckoutPageGet(
  sessionId: string,
  deps: FakeCheckoutPageDeps,
  notice?: string,
): Promise<Response> {
  const stored = await readFakeCheckoutSession(deps.store, sessionId)
  if (!stored) return notFoundPage(deps.appName)
  const { session, extras } = stored
  if (session.status !== "open") {
    const body =
      session.status === "expired"
        ? "<p>This checkout expired. Go back to the product page and start again.</p>"
        : "<p>This checkout is already paid.</p>"
    return htmlResponse(
      page(
        deps.appName,
        session.status === "expired" ? "Checkout expired" : "Already paid",
        `${body}<p><a class="button" href="${escapeHtml(extras.cancel_url)}">Back to the product</a></p>`,
      ),
      410,
    )
  }

  const currency = session.currency ?? "eur"
  const discount = session.total_details?.amount_discount ?? 0
  const total = session.amount_total ?? extras.fake_line.unit_amount
  const defaultCountry = FAKE_CHECKOUT_COUNTRIES[0]
  const tax = inclusiveTaxCents(total, fakeTaxRateBps(defaultCountry))
  const rows = [
    `<dt>${escapeHtml(extras.fake_line.name)}</dt><dd>${escapeHtml(formatMoney(extras.fake_line.unit_amount, currency))}</dd>`,
    ...(discount > 0
      ? [`<dt>Discount</dt><dd>−${escapeHtml(formatMoney(discount, currency))}</dd>`]
      : []),
    `<dt>VAT included (${escapeHtml(countryName(defaultCountry))})</dt><dd>${escapeHtml(formatMoney(tax, currency))}</dd>`,
    `<dt><strong>Total</strong></dt><dd><strong>${escapeHtml(formatMoney(total, currency))}</strong></dd>`,
  ]
  const countries = FAKE_CHECKOUT_COUNTRIES.map(
    (code) =>
      `<option value="${code}"${code === defaultCountry ? " selected" : ""}>${escapeHtml(countryName(code))}</option>`,
  ).join("")
  const promo =
    extras.allow_promotion_codes && discount === 0
      ? `<label for="promotion_code">Promotion code (optional)</label>
         <input id="promotion_code" name="promotion_code" autocomplete="off" maxlength="20">`
      : ""
  const body = `
    ${notice ? `<p class="notice" role="alert">${escapeHtml(notice)}</p>` : ""}
    <dl class="summary">${rows.join("")}</dl>
    <p class="muted">VAT is worked out for your country when you pay (test rates).</p>
    <form method="post" class="form">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" value="buyer@example.com">
      <label for="country">Country</label>
      <select id="country" name="country">${countries}</select>
      ${promo}
      <div class="actions">
        <button type="submit" name="method" value="card" class="button primary">Pay with test card 4242</button>
        <button type="submit" name="method" value="card_fee_pending" class="button">Pay by card (fee settles later)</button>
        <button type="submit" name="method" value="delayed" class="button">Pay with delayed method (SEPA debit)</button>
        <button type="submit" name="method" value="delayed_fail" class="button">Delayed method that fails</button>
        <a class="button ghost" href="${escapeHtml(extras.cancel_url)}">Cancel and go back</a>
      </div>
    </form>`
  return htmlResponse(page(deps.appName, "Checkout", body))
}

function isMethod(value: string): value is FakePaymentMethod {
  return (FAKE_PAYMENT_METHODS as readonly string[]).includes(value)
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function fakeCheckoutPagePost(
  request: Request,
  sessionId: string,
  deps: FakeCheckoutPageDeps,
): Promise<Response> {
  const form = await request.formData()
  const method = String(form.get("method") ?? "")
  const email = String(form.get("email") ?? "").trim()
  const country = String(form.get("country") ?? "")
  const promotionCode = String(form.get("promotion_code") ?? "").trim() || null

  const stored = await readFakeCheckoutSession(deps.store, sessionId)
  if (!stored) return notFoundPage(deps.appName)
  if (!isMethod(method)) return fakeCheckoutPageGet(sessionId, deps, "Choose a way to pay.")
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return fakeCheckoutPageGet(sessionId, deps, "Enter a valid email address.")
  }
  if (!(FAKE_CHECKOUT_COUNTRIES as readonly string[]).includes(country)) {
    return fakeCheckoutPageGet(sessionId, deps, "Choose a country from the list.")
  }

  const result = await completeFakeCheckoutSession(deps.store, sessionId, {
    method,
    email,
    country,
    promotionCode,
  })
  if (!result.ok) {
    if (result.reason === "invalid_code") {
      return fakeCheckoutPageGet(sessionId, deps, "That promotion code isn't valid.")
    }
    return fakeCheckoutPageGet(sessionId, deps)
  }

  await deliver(deps, "checkout.session.completed", result.session)
  if (method === "card_fee_pending" && result.chargeId) {
    const charge = await settleFakeChargeFee(deps.store, result.chargeId)
    await deliver(deps, "charge.updated", charge)
  }
  if ((method === "delayed" || method === "delayed_fail") && result.paymentIntentId) {
    const outcome = method === "delayed" ? "succeeded" : "failed"
    const settle = async () => {
      await sleep(deps.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS)
      const session = await settleFakeDelayedPayment(deps.store, sessionId, outcome)
      await deliver(
        deps,
        outcome === "succeeded"
          ? "checkout.session.async_payment_succeeded"
          : "checkout.session.async_payment_failed",
        session,
      )
    }
    if (deps.later) deps.later(settle)
    else await settle()
  }

  return redirect(stored.extras.success_url.replace("{CHECKOUT_SESSION_ID}", sessionId))
}

/**
 * Deliver one event to the real webhook. A failed delivery is reported; the success page then
 * shows the order as processing (as with a slow webhook at Stripe), and nothing retries it.
 */
async function deliver(
  deps: FakeCheckoutPageDeps,
  type: Stripe.Event.Type,
  object: JsonObject,
): Promise<void> {
  const event = await createFakeEvent(deps.store, type, object)
  try {
    const { status } = await deliverFakeWebhook(event, {
      url: deps.webhookUrl,
      secret: deps.webhookSecret,
      fetch: deps.fetch,
    })
    if (status < 200 || status >= 300) {
      reportError(new Error(`Fake Stripe: webhook answered ${status} for ${type}`), {
        tags: { fake: "stripe" },
        extra: { event_id: event.id },
      })
    }
  } catch (error) {
    reportError(error, { tags: { fake: "stripe" }, extra: { event_id: event.id } })
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

export function fakeCheckoutNotFound(): Response {
  return new Response("Not Found", { status: 404, headers: NO_STORE })
}

function notFoundPage(appName: string): Response {
  return htmlResponse(
    page(appName, "Checkout not found", "<p>This checkout link is not valid.</p>"),
    404,
  )
}

function redirect(url: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, Location: url } })
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  })
}

function page(appName: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Fake Stripe</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f8fa; --card: #fff; --fg: #1a1f36; --muted: #5b6475;
    --border: #e3e8ee; --primary: #635bff; --primary-fg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1218; --card: #171b24; --fg: #e8eaf0;
    --muted: #9aa3b5; --border: #2a3140; --primary: #7a73ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 30rem; margin: 0 auto;
    padding: max(1.5rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
      max(1.5rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); }
  .badge { display: inline-block; font-size: .75rem; font-weight: 600; padding: .15rem .5rem;
    border-radius: 999px; background: #fff3cd; color: #7a5300; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: .75rem;
    padding: 1.25rem; margin-top: 1rem; }
  h1 { font-size: 1.375rem; margin: .25rem 0 0; }
  .muted { color: var(--muted); font-size: .9rem; }
  .notice { background: #fde8e8; color: #8a1c1c; padding: .5rem .75rem; border-radius: .5rem; }
  .summary { display: grid; grid-template-columns: 1fr auto; gap: .375rem 1rem; margin: 1rem 0 .5rem; }
  .summary dt { overflow-wrap: anywhere; } .summary dd { margin: 0; text-align: right; }
  .form { display: grid; gap: .375rem; margin-top: 1rem; }
  label { font-weight: 600; font-size: .9rem; margin-top: .5rem; }
  input, select { font: inherit; font-size: 16px; min-height: 44px; padding: .5rem .75rem;
    border-radius: .5rem; border: 1px solid var(--border); background: var(--card); color: var(--fg); }
  .actions { display: grid; gap: .5rem; margin-top: 1rem; }
  .button { display: flex; align-items: center; justify-content: center; min-height: 44px;
    text-align: center; font: inherit; font-weight: 600; padding: .5rem 1rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer;
    text-decoration: none; }
  .button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); }
  .button.ghost { border-color: transparent; color: var(--muted); }
  .button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <span class="badge">Test mode · fake Stripe for ${escapeHtml(appName)}</span>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </div>
</main>
</body>
</html>`
}
