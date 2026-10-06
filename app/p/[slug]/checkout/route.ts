import { checkoutGetResponse, handleCheckoutRequest } from "@/lib/checkout/start"
import { getDb } from "@/lib/db/client"
import { getStripeGateway } from "@/lib/stripe/gateway"

/**
 * Checkout (§12 `/p/[slug]/checkout`, §7.2): the product page's Buy button posts here; the handler
 * creates the Stripe Checkout Session and answers 303 to Stripe's page. A route handler (§4:
 * checkout). See lib/checkout/start.ts.
 */

type Context = { params: Promise<{ slug: string }> }

export const dynamic = "force-dynamic"

export async function POST(request: Request, context: Context): Promise<Response> {
  const { slug } = await context.params
  return handleCheckoutRequest(request, slug, { db: getDb(), gateway: getStripeGateway() })
}

/** Reloading or sharing the checkout URL goes back to the product page. */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { slug } = await context.params
  return checkoutGetResponse(slug)
}
