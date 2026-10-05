import {
  fakeConnectPageGet,
  fakeConnectPagePost,
  fakeStripeNotFound,
  fakeStripePageDeps,
  fakeStripePagesEnabled,
} from "@/lib/stripe/fake-pages"

/**
 * Fake Stripe Connect onboarding (§19.3): what a fake Account Link opens. Exists only while
 * Stripe is fake (404 otherwise). "Complete onboarding" updates the fake account, delivers a
 * signed `account.updated` to `/api/webhooks/stripe` over HTTP and redirects to the link's
 * `return_url`. See lib/stripe/fake-pages.ts.
 */

type Context = { params: Promise<{ accountId: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  if (!fakeStripePagesEnabled()) return fakeStripeNotFound()
  const { accountId } = await context.params
  return fakeConnectPageGet(request, accountId, fakeStripePageDeps())
}

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!fakeStripePagesEnabled()) return fakeStripeNotFound()
  const { accountId } = await context.params
  return fakeConnectPagePost(request, accountId, fakeStripePageDeps())
}
