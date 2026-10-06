import { describe, expect, it, vi } from "vitest"

import type { Tx } from "@/lib/db/client"
import { eventTime, handledStripeEventTypes, on, stripeEventHandler } from "@/lib/stripe/handlers"
import { registerStripeHandlers } from "@/lib/stripe/handlers/define"
import { stripeAccountSchema, stripeEventSchema } from "@/lib/stripe/schemas"

import accountUpdated from "../../fixtures/stripe/account.updated.json"

const context = {
  tx: {} as Tx,
  now: new Date("2026-10-05T12:00:00.000Z"),
  afterCommit: () => {},
}

describe("Stripe webhook handler registry", () => {
  it("handles the Connect account events (Phase 1) and the money events (Phase 5)", () => {
    expect(handledStripeEventTypes()).toEqual(
      expect.arrayContaining([
        "account.updated",
        "capability.updated",
        "charge.dispute.closed",
        "charge.dispute.created",
        "charge.refunded",
        "refund.created",
        "refund.failed",
        "refund.updated",
        "transfer.reversed",
      ]),
    )
    expect(stripeEventHandler("account.updated")).toBeTypeOf("function")
    expect(stripeEventHandler("capability.updated")).toBeTypeOf("function")
  })

  it("has no handler for other types, including object prototype keys", () => {
    for (const type of ["customer.created", "toString", "__proto__", "constructor"]) {
      expect(stripeEventHandler(type)).toBeNull()
    }
  })

  it("refuses two topic groups handling the same type", () => {
    const handler = async () => {}
    expect(() =>
      registerStripeHandlers([{ "account.updated": handler }, { "account.updated": handler }]),
    ).toThrow(/"account.updated" is registered twice/)
    expect(
      registerStripeHandlers([{ "account.updated": handler }, { "transfer.reversed": handler }])
        .size,
    ).toBe(2)
  })
})

describe("on(schema, handler)", () => {
  const event = stripeEventSchema.parse(accountUpdated)

  it("passes the event with data.object parsed by the schema", async () => {
    const received = vi.fn(async () => {})
    await on(stripeAccountSchema, received)(event, context)
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        id: event.id,
        data: expect.objectContaining({
          // Parsed: only the schema's fields are left.
          object: stripeAccountSchema.parse(accountUpdated.data.object),
          previous_attributes: event.data.previous_attributes,
        }),
      }),
      context,
    )
  })

  it("throws (the event fails and is retried) when data.object does not parse", async () => {
    const received = vi.fn(async () => {})
    const broken = { ...event, data: { object: { id: "acct_1", object: "customer" } } }
    await expect(on(stripeAccountSchema, received)(broken, context)).rejects.toThrow()
    expect(received).not.toHaveBeenCalled()
  })

  it("reads the event time in whole seconds", () => {
    expect(eventTime({ created: 1791201600 })).toEqual(new Date("2026-10-05T12:00:00.000Z"))
  })
})
