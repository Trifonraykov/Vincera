import { z } from "zod"

import { stripeIdSchema, stripeMetadataSchema } from "./ids"

/**
 * Promotion codes of the Stripe gateway (Phase 4, CLAUDE.md §19.31): the discount code a tracked
 * link may carry (§10 "a discount code tied to a tracked link also attributes"). Owner: the launch
 * builder (`./live-promotions.ts`, `./fake-promotions.ts`).
 */

/** A `PromotionCode` (customer-facing code over a percent-off coupon). */
export const stripePromotionCodeSchema = z.object({
  id: stripeIdSchema("promo"),
  object: z.literal("promotion_code"),
  code: z.string().min(1),
  active: z.boolean(),
  /** `tracked_link_id`, `launch_id`. */
  metadata: stripeMetadataSchema.nullish(),
  created: z.int().nonnegative(),
})
export type StripePromotionCode = z.output<typeof stripePromotionCodeSchema>

export type CreatePromotionCodeInput = {
  /** `tracked_links.discount_code` (uppercase letters and digits, 4–20). */
  code: string
  /** 1–100. */
  percentOff: number
  /** At least `tracked_link_id` and `launch_id`. */
  metadata: Record<string, string>
}
