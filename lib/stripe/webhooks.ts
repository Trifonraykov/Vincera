import "server-only"

import { eq } from "drizzle-orm"
import Stripe from "stripe"

import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { stripeEvents, type JsonObject } from "@/lib/db/schema"
import { reportError } from "@/lib/observability"

import { stripeEventHandler } from "./handlers"
import { jsonObjectSchema, stripeEventSchema, type StripeEvent } from "./schemas"

/**
 * Stripe webhooks (§7.2, §19.10, §19.11, §19.12): signature verification, idempotent processing
 * through `stripe_events`, and dispatch to the typed handlers in `./handlers/`.
 *
 * One endpoint (`/api/webhooks/stripe`) receives both the platform endpoint's events and the
 * Connect endpoint's (`account.updated`, `capability.updated`), each signed with its own secret,
 * so a request is accepted when its signature matches either.
 *
 * Processing an event:
 * 1. the event is recorded in `stripe_events` (insert-if-absent, so a failed one keeps its payload);
 * 2. in one transaction: the row is locked, an already processed event (`processed_at` set) is a
 *    no-op, the handler runs with that transaction, and `processed_at` is set;
 * 3. if the handler throws, everything it wrote rolls back, `processed_at` stays null and the
 *    endpoint answers 500, so Stripe's retry processes the event again.
 *
 * Event types without a handler are acknowledged (200), recorded, and marked processed: there is
 * nothing to do for them. `processed_at IS NULL` therefore always means failed (or in flight).
 *
 * To handle a new type (Phases 4–5: `checkout.session.completed`, `charge.updated`, refunds,
 * disputes, `transfer.reversed`, ...), see `./handlers/index.ts`.
 */

// --- Verification -----------------------------------------------------------------------------

export type VerifiedStripeWebhook =
  | { ok: true; event: StripeEvent; payload: JsonObject }
  | { ok: false; reason: "missing_signature" | "invalid_signature" | "invalid_payload" }

/**
 * Verify a webhook request body against each secret (the platform endpoint's and the Connect
 * endpoint's) with Stripe's own check (HMAC + 5-minute timestamp tolerance), then parse it.
 */
export function verifyStripeWebhook(
  payload: string,
  signature: string | null,
  secrets: readonly string[],
): VerifiedStripeWebhook {
  if (!signature) return { ok: false, reason: "missing_signature" }

  let constructed: unknown = null
  for (const secret of new Set(secrets)) {
    try {
      constructed = Stripe.webhooks.constructEvent(payload, signature, secret)
      break
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) continue
      // A valid signature over a body that is not JSON.
      return { ok: false, reason: "invalid_payload" }
    }
  }
  if (constructed === null) return { ok: false, reason: "invalid_signature" }

  const event = stripeEventSchema.safeParse(constructed)
  const raw = jsonObjectSchema.safeParse(constructed)
  if (!event.success || !raw.success) return { ok: false, reason: "invalid_payload" }
  return { ok: true, event: event.data, payload: raw.data }
}

// --- Processing -------------------------------------------------------------------------------

export type ProcessStripeEventResult = {
  status: "processed" | "ignored" | "duplicate"
}

/** Record and process one verified event (see the module comment for the guarantees). */
export async function processStripeEvent(
  database: DbOrTx,
  event: StripeEvent,
  payload: JsonObject,
): Promise<ProcessStripeEventResult> {
  await database
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type, account: event.account ?? null, payload })
    .onConflictDoNothing({ target: stripeEvents.id })

  return withTransaction(async (tx) => {
    // The lock serialises concurrent deliveries of the same event: the second one waits, then
    // sees `processed_at` set.
    const [row] = await tx
      .select({ processedAt: stripeEvents.processedAt })
      .from(stripeEvents)
      .where(eq(stripeEvents.id, event.id))
      .for("update")
    if (!row) throw new Error(`stripe_events row ${event.id} is missing`)
    if (row.processedAt !== null) return { status: "duplicate" }

    const handler = stripeEventHandler(event.type)
    if (handler) await handler(event, { tx, now: now() })

    await tx.update(stripeEvents).set({ processedAt: now() }).where(eq(stripeEvents.id, event.id))
    return { status: handler ? "processed" : "ignored" }
  }, database)
}

/**
 * The `/api/webhooks/stripe` handler (the route passes the app's database and secrets; tests
 * pass their own). Answers 400 for a missing or invalid signature or payload, 500 when
 * processing fails (Stripe retries), else 200 with `{ received: true, status }`.
 */
export async function handleStripeWebhookRequest(
  request: Request,
  options: { db: DbOrTx; secrets: readonly string[] },
): Promise<Response> {
  const payload = await request.text()
  const verified = verifyStripeWebhook(
    payload,
    request.headers.get("stripe-signature"),
    options.secrets,
  )
  if (!verified.ok) {
    return Response.json({ received: false, error: verified.reason }, { status: 400 })
  }

  const { event } = verified
  try {
    const result = await processStripeEvent(options.db, event, verified.payload)
    return Response.json({ received: true, status: result.status })
  } catch (error) {
    reportError(error, {
      tags: { stripe_event_type: event.type },
      extra: { stripe_event_id: event.id },
    })
    return Response.json({ received: false, error: "processing_failed" }, { status: 500 })
  }
}
