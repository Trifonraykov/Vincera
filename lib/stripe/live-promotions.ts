import "server-only"

import type Stripe from "stripe"

import type { PromotionsGateway } from "./gateway"
import { stripePromotionCodeSchema } from "./promotions-shared"

/**
 * Live promotion codes (Phase 4, CLAUDE.md §19.31, §19.32): a tracked link's discount code is a
 * `percent_off` coupon (`duration: "once"`) with a customer-facing promotion code over it
 * (endive: `promotion: { type: "coupon", coupon }`). Both requests are idempotent, keyed on the
 * caller's key, so a retry never makes a second coupon or code.
 */
export function createLivePromotionsGateway(stripe: Stripe): PromotionsGateway {
  return {
    async createPromotionCode(input, { idempotencyKey }) {
      const coupon = await stripe.coupons.create(
        {
          percent_off: input.percentOff,
          duration: "once",
          name: `${input.code} (${input.percentOff}% off)`,
          metadata: input.metadata,
        },
        { idempotencyKey: `${idempotencyKey}:coupon` },
      )
      const code = await stripe.promotionCodes.create(
        {
          promotion: { type: "coupon", coupon: coupon.id },
          code: input.code,
          metadata: input.metadata,
        },
        { idempotencyKey: `${idempotencyKey}:code` },
      )
      return stripePromotionCodeSchema.parse(code)
    },

    async deactivatePromotionCode(promotionCodeId) {
      return stripePromotionCodeSchema.parse(
        await stripe.promotionCodes.update(promotionCodeId, { active: false }),
      )
    },
  }
}
