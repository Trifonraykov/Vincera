import { describe, expect, it } from "vitest"

import { payoutFailureMessage, TRANSFER_STATUS_LABELS } from "@/lib/payouts/failure-codes"
import { dailyRunKey, payoutIdempotencyKey } from "@/lib/payouts/release"
import {
  chargebackOutcome,
  mapStripeRefundStatus,
  orderStatusFor,
  refundStatusMayMove,
} from "@/lib/refunds/status"
import { transferStatusEnum } from "@/lib/db/schema/enums"

/** Pure rules of the payouts area (CLAUDE.md §19.35). */

describe("refund statuses", () => {
  it("maps Stripe's values and keeps unknown ones pending (fail closed)", () => {
    expect(mapStripeRefundStatus("succeeded")).toBe("succeeded")
    expect(mapStripeRefundStatus("canceled")).toBe("canceled")
    expect(mapStripeRefundStatus("something_new")).toBe("pending")
    expect(mapStripeRefundStatus(null)).toBe("pending")
  })

  it("never moves a status backwards; a succeeded refund may still fail", () => {
    expect(refundStatusMayMove("pending", "succeeded")).toBe(true)
    expect(refundStatusMayMove("succeeded", "failed")).toBe(true)
    expect(refundStatusMayMove("succeeded", "pending")).toBe(false)
    expect(refundStatusMayMove("failed", "pending")).toBe(false)
    expect(refundStatusMayMove("failed", "succeeded")).toBe(false)
    expect(refundStatusMayMove("succeeded", "succeeded")).toBe(false)
    expect(refundStatusMayMove("pending", "requires_action")).toBe(true)
  })

  it("derives the order status from the refunded amount, unless disputed", () => {
    expect(orderStatusFor({ grossCents: 1900, refundedCents: 0, disputed: false })).toBe("paid")
    expect(orderStatusFor({ grossCents: 1900, refundedCents: 1, disputed: false })).toBe(
      "partially_refunded",
    )
    expect(orderStatusFor({ grossCents: 1900, refundedCents: 1900, disputed: false })).toBe(
      "refunded",
    )
    expect(orderStatusFor({ grossCents: 1900, refundedCents: 1900, disputed: true })).toBe(
      "disputed",
    )
  })

  it("reads a dispute's outcome", () => {
    expect(chargebackOutcome("needs_response")).toBe("open")
    expect(chargebackOutcome("warning_under_review")).toBe("open")
    expect(chargebackOutcome("won")).toBe("won")
    expect(chargebackOutcome("warning_closed")).toBe("won")
    expect(chargebackOutcome("lost")).toBe("lost")
  })
})

describe("payout keys and labels", () => {
  it("names runs and idempotency keys as the contract says", () => {
    expect(dailyRunKey(new Date("2026-10-06T23:59:59Z"))).toBe("daily:2026-10-06")
    expect(payoutIdempotencyKey({ batchId: "b", userId: "u", currency: "eur" })).toBe("payout:b:u")
    expect(payoutIdempotencyKey({ batchId: "b", userId: "u", currency: "usd" })).toBe(
      "payout:b:u:usd",
    )
  })

  it("has a label for every transfer status and plain words for failures", () => {
    for (const status of transferStatusEnum.enumValues) {
      expect(TRANSFER_STATUS_LABELS[status]).toBeTruthy()
    }
    expect(payoutFailureMessage("balance_insufficient")).toMatch(/don't need to do anything/)
    expect(payoutFailureMessage(null)).toMatch(/payout settings/)
  })
})
