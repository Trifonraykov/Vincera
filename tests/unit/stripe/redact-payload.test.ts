import { describe, expect, it } from "vitest"

import { redactStripePayload } from "@/lib/stripe/redact-payload"

/** `stripe_events.payload` is stored without personal data (CLAUDE.md §19.37). */
describe("redactStripePayload", () => {
  it("drops buyer and account-holder details, keeps ids, statuses and amounts", () => {
    const event = {
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          amount_total: 1900,
          payment_status: "paid",
          customer_details: {
            email: "buyer@example.com",
            name: "Ana Buyer",
            address: { country: "ES", line1: "Calle 1" },
          },
          customer_email: "buyer@example.com",
          metadata: { order_ref: "0192e4c1-1111-7000-8000-000000000000" },
        },
        previous_attributes: { billing_details: { email: "old@example.com" } },
      },
      list: [{ receipt_email: "a@b.c", amount: 5 }],
    }
    const stored = redactStripePayload(event)
    const text = JSON.stringify(stored)
    expect(text).not.toContain("@example.com")
    expect(text).not.toContain("Ana Buyer")
    expect(text).not.toContain("a@b.c")
    expect(stored).toMatchObject({
      id: "evt_1",
      data: {
        object: {
          id: "cs_test_1",
          amount_total: 1900,
          payment_status: "paid",
          customer_details: null,
          metadata: { order_ref: "0192e4c1-1111-7000-8000-000000000000" },
        },
      },
      list: [{ receipt_email: null, amount: 5 }],
    })
    // The input is not changed (handlers read it).
    expect(event.data.object.customer_details.email).toBe("buyer@example.com")
  })
})
