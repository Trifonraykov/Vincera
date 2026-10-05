import {
  fakeDashboardPageGet,
  fakeStripeNotFound,
  fakeStripePageDeps,
  fakeStripePagesEnabled,
} from "@/lib/stripe/fake-pages"

/**
 * Fake Stripe Express Dashboard (§19.3): what a fake login link opens. Exists only while Stripe
 * is fake (404 otherwise).
 */

type Context = { params: Promise<{ accountId: string }> }

export async function GET(_request: Request, context: Context): Promise<Response> {
  if (!fakeStripePagesEnabled()) return fakeStripeNotFound()
  const { accountId } = await context.params
  return fakeDashboardPageGet(accountId, fakeStripePageDeps())
}
