import type Stripe from "stripe"
import { z } from "zod"

import type { DeliveryType } from "@/lib/db/schema/enums"

import { expandableIdSchema, stripeIdSchema, stripeMetadataSchema } from "./ids"
import { balanceTransactionFieldSchema } from "./money-shared"

/**
 * Checkout objects of the Stripe gateway (Phase 4, CLAUDE.md §19.31): Checkout Sessions, the
 * PaymentIntent and its charge (whose balance transaction carries the Stripe fee, §9), plus the
 * session parameters and metadata contract shared by the live gateway and the fake.
 *
 * Owner: the checkout builder (`./live-checkout.ts`, `./fake-checkout.ts`). The parameter builder
 * and metadata keys below are the contract: change them only together with §19.31.
 */

const amount = z.int()
const currency = z.string().regex(/^[a-z]{3}$/)
const unixSeconds = z.int().nonnegative()

// --- Metadata (§7.2: `metadata: { order_ref, launch_id, tracked_link_id }`) ---------------------

/** Metadata keys on the session and on `payment_intent_data` (strings only; absent = none). */
export const CHECKOUT_METADATA_KEYS = {
  /** UUIDv7 made before the session; becomes `orders.id` (§19.31). */
  orderRef: "order_ref",
  launchId: "launch_id",
  /** Only when the checkout is attributed to a tracked link. */
  trackedLinkId: "tracked_link_id",
  /** `cookie | ref`, with `tracked_link_id` (discount-code attribution is decided at completion). */
  attribution: "attribution",
} as const

/** The metadata as it comes back on the session or the PaymentIntent. */
export const checkoutMetadataSchema = z.object({
  order_ref: z.uuid(),
  launch_id: z.uuid(),
  tracked_link_id: z.uuid().optional(),
  attribution: z.enum(["cookie", "ref"]).optional(),
})
export type CheckoutMetadata = z.output<typeof checkoutMetadataSchema>

// --- Stripe Tax codes (§7.2, docs/integrations/stripe.md) ---------------------------------------

/**
 * Default product tax code per delivery type: downloadable software for files and license keys,
 * SaaS for URL deliveries (personal use; the business-use variants apply to B2B sales and are not
 * used in the MVP). `launches.tax_code` overrides it when set.
 */
export const DEFAULT_TAX_CODES = {
  file: "txcd_10202000",
  license_key: "txcd_10202000",
  url: "txcd_10103000",
} as const satisfies Record<DeliveryType, string>

export function taxCodeFor(launch: { deliveryType: DeliveryType; taxCode: string | null }): string {
  return launch.taxCode ?? DEFAULT_TAX_CODES[launch.deliveryType]
}

// --- Creating a session ----------------------------------------------------------------------

/** Checkout sessions expire after 30 minutes (Stripe's minimum). */
export const CHECKOUT_SESSION_TTL_SECONDS = 30 * 60

export type CreateCheckoutSessionInput = {
  orderRef: string
  launchId: string
  /** The attributed link (cookie or `?ref=`), else null. */
  trackedLinkId: string | null
  attribution: "cookie" | "ref" | null
  /** The launch title (shown on Stripe's page and the receipt). */
  productName: string
  /** Tax-inclusive price in integer cents (`launches.price_cents`). */
  priceCents: number
  currency: string
  taxCode: string
  /** Absolute URL; must contain `{CHECKOUT_SESSION_ID}`. */
  successUrl: string
  /** Absolute URL of the product page. */
  cancelUrl: string
  /** Unix seconds (now + CHECKOUT_SESSION_TTL_SECONDS). */
  expiresAt: number
  /**
   * A promotion code to apply up front (`/p/[slug]?code=`), else null: the buyer may still type one
   * on Stripe's page (`allow_promotion_codes`). Stripe accepts one of the two, not both.
   */
  promotionCodeId: string | null
}

function checkoutMetadata(input: CreateCheckoutSessionInput): Record<string, string> {
  return {
    [CHECKOUT_METADATA_KEYS.orderRef]: input.orderRef,
    [CHECKOUT_METADATA_KEYS.launchId]: input.launchId,
    ...(input.trackedLinkId ? { [CHECKOUT_METADATA_KEYS.trackedLinkId]: input.trackedLinkId } : {}),
    ...(input.trackedLinkId && input.attribution
      ? { [CHECKOUT_METADATA_KEYS.attribution]: input.attribution }
      : {}),
  }
}

/**
 * The `checkout.sessions.create` parameters (§7.2, §19.10, docs/integrations/stripe.md): one
 * tax-inclusive line, Stripe Tax, the metadata on both the session and the PaymentIntent, and the
 * transfer group `order_<order_ref>`. Never `payment_method_types` (removed in endive). Shared by
 * the live gateway and the fake so both describe the same session.
 */
export function checkoutSessionParams(input: CreateCheckoutSessionInput) {
  const metadata = checkoutMetadata(input)
  return {
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency,
          unit_amount: input.priceCents,
          tax_behavior: "inclusive",
          product_data: {
            name: input.productName,
            tax_code: input.taxCode,
            metadata: { [CHECKOUT_METADATA_KEYS.launchId]: input.launchId },
          },
        },
      },
    ],
    automatic_tax: { enabled: true },
    billing_address_collection: "auto",
    tax_id_collection: { enabled: true },
    customer_creation: "if_required",
    client_reference_id: input.orderRef,
    metadata,
    payment_intent_data: { metadata, transfer_group: `order_${input.orderRef}` },
    ...(input.promotionCodeId
      ? { discounts: [{ promotion_code: input.promotionCodeId }] }
      : { allow_promotion_codes: true }),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: input.expiresAt,
  } satisfies Stripe.Checkout.SessionCreateParams
}

// --- Objects ---------------------------------------------------------------------------------

/** A `Charge`; `balance_transaction` is null until Stripe settles the fee (async capture, §19.10). */
export const stripeChargeSchema = z.object({
  id: stripeIdSchema("ch"),
  object: z.literal("charge"),
  amount,
  amount_refunded: amount,
  currency,
  status: z.string().min(1),
  paid: z.boolean(),
  refunded: z.boolean(),
  /** Whether the charge has a dispute (reconciliation, `ledger:check`). */
  disputed: z.boolean().optional(),
  payment_intent: expandableIdSchema("pi").nullish(),
  balance_transaction: balanceTransactionFieldSchema,
  metadata: stripeMetadataSchema.nullish(),
  created: unixSeconds,
})
export type StripeCharge = z.output<typeof stripeChargeSchema>

/**
 * A `PaymentIntent`, retrieved with `expand: ["latest_charge.balance_transaction"]` so the fee is
 * known when the balance transaction exists.
 */
export const stripePaymentIntentSchema = z.object({
  id: stripeIdSchema("pi"),
  object: z.literal("payment_intent"),
  amount,
  currency,
  status: z.string().min(1),
  latest_charge: z.union([stripeIdSchema("ch"), stripeChargeSchema]).nullable(),
  metadata: stripeMetadataSchema.nullish(),
  created: unixSeconds,
})
export type StripePaymentIntent = z.output<typeof stripePaymentIntentSchema>

/** One of `Session.discounts`: a promotion code (or coupon) applied to the session. */
const sessionDiscountSchema = z.object({
  promotion_code: expandableIdSchema("promo").nullish(),
})

/**
 * A Checkout `Session`. Fulfil only when `payment_status === "paid"` (§19.10); `amount_total`
 * is what the buyer paid (tax included, discount applied).
 */
export const stripeCheckoutSessionSchema = z.object({
  id: stripeIdSchema("cs"),
  object: z.literal("checkout.session"),
  /** `open | complete | expired`. */
  status: z.string().nullish(),
  /** `paid | unpaid | no_payment_required`. */
  payment_status: z.string().min(1),
  mode: z.string().min(1),
  url: z.string().nullish(),
  amount_subtotal: amount.nullish(),
  amount_total: amount.nullish(),
  currency: currency.nullish(),
  client_reference_id: z.string().nullish(),
  customer_details: z
    .object({
      email: z.string().nullish(),
      address: z.object({ country: z.string().nullish() }).nullish(),
    })
    .nullish(),
  total_details: z
    .object({ amount_discount: amount, amount_tax: amount, amount_shipping: amount.nullish() })
    .nullish(),
  discounts: z.array(sessionDiscountSchema).nullish(),
  metadata: stripeMetadataSchema.nullish(),
  payment_intent: expandableIdSchema("pi").nullish(),
  created: unixSeconds,
  expires_at: unixSeconds,
})
export type StripeCheckoutSession = z.output<typeof stripeCheckoutSessionSchema>
