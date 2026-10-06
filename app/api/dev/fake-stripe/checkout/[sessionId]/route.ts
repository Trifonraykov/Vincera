import {
  fakeCheckoutNotFound,
  fakeCheckoutPageDeps,
  fakeCheckoutPageGet,
  fakeCheckoutPagePost,
  fakeCheckoutPagesEnabled,
} from "@/lib/checkout/fake-page"

/**
 * Fake Stripe Checkout (§19.3; CLAUDE.md §19.34): what a fake Checkout Session's `url` opens.
 * Exists only while Stripe is fake (404 otherwise). Paying delivers the events Stripe would send
 * to the real `/api/webhooks/stripe` over HTTP, then redirects to the session's `success_url`.
 * See lib/checkout/fake-page.ts.
 */

type Context = { params: Promise<{ sessionId: string }> }

export const dynamic = "force-dynamic"

export async function GET(_request: Request, context: Context): Promise<Response> {
  if (!fakeCheckoutPagesEnabled()) return fakeCheckoutNotFound()
  const { sessionId } = await context.params
  return fakeCheckoutPageGet(sessionId, fakeCheckoutPageDeps())
}

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!fakeCheckoutPagesEnabled()) return fakeCheckoutNotFound()
  const { sessionId } = await context.params
  return fakeCheckoutPagePost(request, sessionId, fakeCheckoutPageDeps())
}
