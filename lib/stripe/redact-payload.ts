import type { JsonObject, JsonValue } from "@/lib/db/schema"

/**
 * Personal data removed from a Stripe event before it is stored in `stripe_events.payload`
 * (§11, §14; CLAUDE.md §19.37). The stored copy only serves idempotency and debugging (ids, types,
 * statuses, amounts); handlers read the event as received. Checkout Sessions carry the buyer's
 * `customer_details` (email, name, address, phone, tax ids), charges `billing_details` and
 * `receipt_email`, and `account.*` events the connected account's email, business profile and
 * people. Each key below is replaced by null wherever it appears (also in `previous_attributes`).
 */
export const STRIPE_PII_KEYS = new Set([
  "customer_details",
  "customer_email",
  "billing_details",
  "receipt_email",
  "shipping",
  "shipping_details",
  "collected_information",
  "email",
  "phone",
  "individual",
  "company",
  "business_profile",
  "external_accounts",
])

function scrub(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === "object") {
    const out: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = STRIPE_PII_KEYS.has(key) && item !== null ? null : scrub(item)
    }
    return out
  }
  return value
}

/** A copy of the event without the personal data in `STRIPE_PII_KEYS`. */
export function redactStripePayload(payload: JsonObject): JsonObject {
  return scrub(payload) as JsonObject
}
