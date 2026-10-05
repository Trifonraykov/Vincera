import { getDb } from "@/lib/db/client"
import { stripeWebhookSecrets } from "@/lib/env"
import { handleStripeWebhookRequest } from "@/lib/stripe/webhooks"

/**
 * Stripe webhooks (§7.2): the platform endpoint and the Connect endpoint both point here, each
 * with its own signing secret (§19.10). The raw body is verified, recorded in `stripe_events` and
 * processed idempotently; see lib/stripe/webhooks.ts. Fake Stripe posts its signed events here
 * too, so the same code runs in development and e2e (§19.3).
 */
export async function POST(request: Request): Promise<Response> {
  const { platform, connect } = stripeWebhookSecrets()
  return handleStripeWebhookRequest(request, { db: getDb(), secrets: [platform, connect] })
}
