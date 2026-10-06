import "server-only"

import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"

import type { FakeStripeOptions, FakeStripeStore } from "./fake"
import { unixSeconds } from "./fake"
import type { PromotionsGateway } from "./gateway"
import { stripePromotionCodeSchema } from "./promotions-shared"
import { StripeGatewayError } from "./shared"

/**
 * Fake promotion codes (Phase 4, CLAUDE.md §19.31, §19.32): `coupon` and `promotion_code`
 * objects in the fake store. Ids derive from the idempotency key (`promo_fake_…`, `fake_coupon_…`),
 * so a retried request replays the first result, and the same key with other parameters fails
 * like Stripe's idempotency check. Stripe refuses a second **active** promotion code with the same
 * `code`; so does the fake. The checkout builder's fake checkout page reads these objects to apply
 * a code.
 */
export function createFakePromotionsGateway(
  store: FakeStripeStore,
  options: FakeStripeOptions,
): PromotionsGateway {
  void options
  const idFor = (prefix: string, key: string) =>
    `${prefix}${createHash("sha256").update(key).digest("hex").slice(0, 16)}`

  async function activeCodeExists(code: string): Promise<boolean> {
    let names: string[]
    try {
      names = await readdir(path.join(store.root, "promotion_code"))
    } catch {
      return false
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const object = await store.read("promotion_code", name.slice(0, -".json".length))
      if (object?.code === code && object.active === true) return true
    }
    return false
  }

  return {
    async createPromotionCode(input, { idempotencyKey }) {
      const id = idFor("promo_fake_", idempotencyKey)
      const existing = await store.read("promotion_code", id)
      if (existing) {
        const coupon =
          typeof existing.coupon === "string" ? await store.read("coupon", existing.coupon) : null
        if (existing.code !== input.code || coupon?.percent_off !== input.percentOff) {
          throw new StripeGatewayError(
            "invalid_request",
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          )
        }
        return stripePromotionCodeSchema.parse(existing)
      }
      if (await activeCodeExists(input.code)) {
        throw new StripeGatewayError(
          "invalid_request",
          "An active promotion code with that customer-facing code already exists.",
        )
      }
      const couponId = idFor("fake_coupon_", idempotencyKey)
      const created = unixSeconds()
      await store.write("coupon", couponId, {
        id: couponId,
        object: "coupon",
        percent_off: input.percentOff,
        duration: "once",
        valid: true,
        metadata: input.metadata,
        created,
      })
      const promotionCode = {
        id,
        object: "promotion_code",
        code: input.code,
        active: true,
        coupon: couponId,
        metadata: input.metadata,
        created,
      }
      await store.write("promotion_code", id, promotionCode)
      return stripePromotionCodeSchema.parse(promotionCode)
    },

    async deactivatePromotionCode(promotionCodeId) {
      const existing = await store.read("promotion_code", promotionCodeId)
      if (!existing) {
        throw new StripeGatewayError(
          "resource_missing",
          `No such promotion code: '${promotionCodeId}'`,
        )
      }
      const updated = { ...existing, active: false }
      await store.write("promotion_code", promotionCodeId, updated)
      return stripePromotionCodeSchema.parse(updated)
    },
  }
}
