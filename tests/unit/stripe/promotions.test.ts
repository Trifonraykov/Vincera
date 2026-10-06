import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createFakeStripeStore } from "@/lib/stripe/fake"
import { createFakePromotionsGateway } from "@/lib/stripe/fake-promotions"
import { StripeGatewayError } from "@/lib/stripe/shared"

/** Fake Stripe promotion codes (CLAUDE.md §19.31–§19.32): idempotency and unique active codes. */

let root = ""
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "promo-test-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function gateway() {
  return createFakePromotionsGateway(createFakeStripeStore(root), { root, appUrl: "http://x" })
}

const input = {
  code: "SAVE10",
  percentOff: 10,
  metadata: { tracked_link_id: "l1", launch_id: "a" },
}

describe("fake promotion codes", () => {
  it("creates a code over a coupon and replays the same key", async () => {
    const first = await gateway().createPromotionCode(input, { idempotencyKey: "promo:l1" })
    expect(first).toMatchObject({ object: "promotion_code", code: "SAVE10", active: true })
    expect(first.id).toMatch(/^promo_fake_[0-9a-f]{16}$/)
    const again = await gateway().createPromotionCode(input, { idempotencyKey: "promo:l1" })
    expect(again.id).toBe(first.id)
    await expect(
      gateway().createPromotionCode({ ...input, percentOff: 20 }, { idempotencyKey: "promo:l1" }),
    ).rejects.toBeInstanceOf(StripeGatewayError)
  })

  it("refuses a second active code with the same text, until the first is deactivated", async () => {
    const first = await gateway().createPromotionCode(input, { idempotencyKey: "promo:l1" })
    await expect(
      gateway().createPromotionCode(input, { idempotencyKey: "promo:l2" }),
    ).rejects.toThrow(/already exists/)
    expect((await gateway().deactivatePromotionCode(first.id)).active).toBe(false)
    const second = await gateway().createPromotionCode(input, { idempotencyKey: "promo:l2" })
    expect(second.id).not.toBe(first.id)
    await expect(gateway().deactivatePromotionCode("promo_fake_missing")).rejects.toMatchObject({
      code: "resource_missing",
    })
  })
})
