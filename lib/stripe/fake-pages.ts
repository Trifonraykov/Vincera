import "server-only"

import type { JsonObject, JsonValue } from "@/lib/db/schema"
import { env, stripeWebhookSecrets } from "@/lib/env"
import { reportError } from "@/lib/observability"
import { dataDir } from "@/lib/services"
import { absoluteUrl } from "@/lib/urls"

import { isStripeFake } from "./client"
import { countryName } from "./countries"
import {
  checkFakeAccountLink,
  completeFakeOnboarding,
  createFakeEvent,
  createFakeStripeStore,
  deliverFakeWebhook,
  consumeFakeAccountLink,
  FAKE_ONBOARDING_OUTCOMES,
  type FakeOnboardingOutcome,
  type FakeStripeStore,
} from "./fake"
import { STRIPE_ACCOUNT_ID_PATTERN, stripeAccountSchema, type StripeAccount } from "./schemas"

/**
 * The fake Stripe-hosted pages (§19.3): Connect onboarding (what an Account Link opens) and the
 * Express Dashboard (what a login link opens). Served by the dev-only routes under
 * `/api/dev/fake-stripe/`, which answer 404 unless Stripe is fake.
 *
 * Completing the fake onboarding changes the stored account, then posts a signed `account.updated`
 * event to the real webhook endpoint over HTTP (so the real verification and handler run), then
 * redirects to the link's `return_url`, like Stripe.
 */

export type FakeStripePageDeps = {
  store: FakeStripeStore
  appName: string
  /** Absolute URL of `/api/webhooks/stripe` on this server. */
  webhookUrl: string
  /** Connect endpoint secret (falls back to STRIPE_WEBHOOK_SECRET outside production). */
  webhookSecret: string
  /** Where the fake dashboard's "back" link goes. */
  appUrl: string
  fetch?: typeof fetch
}

const NO_STORE = { "Cache-Control": "no-store" } as const

/**
 * Whether the fake pages exist: only while Stripe is fake. `isStripeFake()` throws when a fake
 * would run in production, and then the routes must not exist either.
 */
export function fakeStripePagesEnabled(): boolean {
  try {
    return isStripeFake()
  } catch {
    return false
  }
}

/**
 * The app's dependencies for the fake pages. The webhook goes to this app at its configured URL
 * (NEXT_PUBLIC_APP_URL, the origin the fake links point at), never to the request's Host header,
 * so a forged Host cannot send a signed event elsewhere.
 */
export function fakeStripePageDeps(): FakeStripePageDeps {
  return {
    store: createFakeStripeStore(dataDir("fake-stripe")),
    appName: env.APP_NAME,
    webhookUrl: absoluteUrl("/api/webhooks/stripe"),
    webhookSecret: stripeWebhookSecrets().connect,
    appUrl: env.NEXT_PUBLIC_APP_URL,
  }
}

/** 404 for the dev routes while Stripe is live. */
export function fakeStripeNotFound(): Response {
  return new Response("Not Found", { status: 404, headers: NO_STORE })
}

// --- Connect onboarding -----------------------------------------------------------------------

/** GET: the onboarding page for a valid link; an expired or used link goes to `refresh_url`. */
export async function fakeConnectPageGet(
  request: Request,
  accountId: string,
  deps: FakeStripePageDeps,
): Promise<Response> {
  const linkId = new URL(request.url).searchParams.get("link") ?? ""
  const check = await checkFakeAccountLink(deps.store, accountId, linkId)
  if (!check.ok) {
    if (check.reason === "missing") return notFoundPage(deps.appName)
    return redirect(check.link.refresh_url)
  }
  const account = await readAccount(deps.store, accountId)
  if (!account) return notFoundPage(deps.appName)
  return htmlResponse(onboardingPage(account, linkId, deps.appName))
}

/**
 * POST: finish (`outcome=enabled | pending_verification`) or leave (`outcome=exit`) the fake
 * onboarding. Uses the link up, applies the outcome, delivers `account.updated`, and redirects to
 * the link's `return_url`.
 */
export async function fakeConnectPagePost(
  request: Request,
  accountId: string,
  deps: FakeStripePageDeps,
): Promise<Response> {
  const form = await request.formData()
  const linkId = String(form.get("link") ?? "")
  const outcome = String(form.get("outcome") ?? "")

  const check = await checkFakeAccountLink(deps.store, accountId, linkId)
  if (!check.ok) {
    if (check.reason === "missing") return notFoundPage(deps.appName)
    return redirect(check.link.refresh_url)
  }
  await consumeFakeAccountLink(deps.store, linkId)

  if (isOutcome(outcome)) {
    const before = await deps.store.read("account", accountId)
    const after = await completeFakeOnboarding(deps.store, accountId, outcome)
    const event = await createFakeEvent(deps.store, "account.updated", after, {
      account: accountId,
      previousAttributes: before ? previousAttributes(before, after) : undefined,
    })
    await deliver(event, deps)
  } else if (outcome !== "exit") {
    return htmlResponse(
      page(deps.appName, "Unknown action", "<p>Choose one of the buttons on the page.</p>"),
      400,
    )
  }
  return redirect(check.link.return_url)
}

function isOutcome(value: string): value is FakeOnboardingOutcome {
  return (FAKE_ONBOARDING_OUTCOMES as readonly string[]).includes(value)
}

async function deliver(event: JsonObject, deps: FakeStripePageDeps): Promise<void> {
  try {
    const { status } = await deliverFakeWebhook(event, {
      url: deps.webhookUrl,
      secret: deps.webhookSecret,
      fetch: deps.fetch,
    })
    if (status < 200 || status >= 300) {
      reportError(new Error(`Fake Stripe: webhook answered ${status}`), {
        tags: { fake: "stripe" },
        extra: { event_id: event.id },
      })
    }
  } catch (error) {
    // The return page re-fetches the account, so the user still sees the new status.
    reportError(error, { tags: { fake: "stripe" }, extra: { event_id: event.id } })
  }
}

/** Stripe's `previous_attributes`: the old values of the top-level fields that changed. */
function previousAttributes(before: JsonObject, after: JsonObject): JsonObject {
  const changed: JsonObject = {}
  const fields = [
    "charges_enabled",
    "payouts_enabled",
    "details_submitted",
    "capabilities",
    "requirements",
  ] as const
  for (const key of fields) {
    const old: JsonValue | undefined = before[key]
    if (old !== undefined && JSON.stringify(old) !== JSON.stringify(after[key])) changed[key] = old
  }
  return changed
}

// --- Express dashboard ------------------------------------------------------------------------

export async function fakeDashboardPageGet(
  accountId: string,
  deps: FakeStripePageDeps,
): Promise<Response> {
  const account = await readAccount(deps.store, accountId)
  if (!account) return notFoundPage(deps.appName)
  const back = new URL("/app/settings/payouts", deps.appUrl).toString()
  const body = `
    <p class="muted">This is a stand-in for the Stripe Express Dashboard, where a real account
    manages its bank account, payout schedule and tax forms.</p>
    ${accountSummary(account)}
    <p><a class="button" href="${escapeHtml(back)}">Back to ${escapeHtml(deps.appName)}</a></p>`
  return htmlResponse(page(deps.appName, "Express Dashboard", body))
}

// --- HTML -------------------------------------------------------------------------------------

async function readAccount(store: FakeStripeStore, accountId: string) {
  if (!STRIPE_ACCOUNT_ID_PATTERN.test(accountId)) return null
  const raw = await store.read("account", accountId)
  const parsed = stripeAccountSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function onboardingPage(account: StripeAccount, linkId: string, appName: string): string {
  const field = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
  const body = `
    <p class="muted">${escapeHtml(appName)} uses Stripe to pay you. In test mode this page stands
    in for Stripe's onboarding form: choose how the onboarding ends.</p>
    ${accountSummary(account)}
    <form method="post" class="actions">
      ${field("link", linkId)}
      <button type="submit" name="outcome" value="enabled" class="button primary">
        Complete onboarding
      </button>
      <button type="submit" name="outcome" value="pending_verification" class="button">
        Submit details (verification pending)
      </button>
      <button type="submit" name="outcome" value="exit" class="button ghost">
        Return without finishing
      </button>
    </form>`
  return page(appName, "Set up payouts", body)
}

function accountSummary(account: StripeAccount): string {
  const due = account.requirements?.currently_due ?? []
  const rows: [string, string][] = [
    ["Account", account.id],
    ["Country", account.country ? countryName(account.country) : "Not set"],
    ["Email", account.email ?? "Not set"],
    ["Details submitted", account.details_submitted ? "Yes" : "No"],
    ["Payouts enabled", account.payouts_enabled ? "Yes" : "No"],
    ["Transfers capability", account.capabilities?.transfers ?? "not requested"],
    ["Still needed", due.length > 0 ? due.join(", ") : "Nothing"],
  ]
  return `<dl>${rows
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("")}</dl>`
}

function notFoundPage(appName: string): Response {
  return htmlResponse(
    page(
      appName,
      "Link not found",
      "<p>This Stripe link is not valid. Start again from the app.</p>",
    ),
    404,
  )
}

function page(appName: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Fake Stripe</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f8fa; --card: #fff; --fg: #1a1f36; --muted: #5b6475;
    --border: #e3e8ee; --primary: #635bff; --primary-fg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1218; --card: #171b24; --fg: #e8eaf0;
    --muted: #9aa3b5; --border: #2a3140; --primary: #7a73ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 34rem; margin: 0 auto; padding: 2rem 1rem; }
  .badge { display: inline-block; font-size: .75rem; font-weight: 600; padding: .15rem .5rem;
    border-radius: 999px; background: #fff3cd; color: #7a5300; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: .75rem;
    padding: 1.5rem; margin-top: 1rem; }
  h1 { font-size: 1.375rem; margin: .5rem 0 0; }
  .muted { color: var(--muted); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 1rem 0;
    font-size: .9rem; }
  dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
  .actions { display: grid; gap: .5rem; margin-top: 1rem; }
  .button { display: inline-block; text-align: center; font: inherit; font-weight: 600;
    padding: .625rem 1rem; border-radius: .5rem; border: 1px solid var(--border);
    background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; }
  .button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); }
  .button.ghost { border-color: transparent; color: var(--muted); }
  .button:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
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

function redirect(url: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, Location: url } })
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
