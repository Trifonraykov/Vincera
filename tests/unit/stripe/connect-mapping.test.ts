import { describe, expect, it } from "vitest"

import {
  changedAccountFields,
  isStaleStripeData,
  stripeAccountColumns,
  toCapabilityStatus,
  type StripeAccountColumns,
} from "@/lib/stripe/connect"
import { stripeAccountSchema } from "@/lib/stripe/schemas"

import accountUpdated from "../../fixtures/stripe/account.updated.json"

const fixtureAccount = stripeAccountSchema.parse(accountUpdated.data.object)

describe("toCapabilityStatus", () => {
  it("keeps Stripe's known statuses", () => {
    expect(toCapabilityStatus("active")).toBe("active")
    expect(toCapabilityStatus("pending")).toBe("pending")
    expect(toCapabilityStatus("inactive")).toBe("inactive")
    expect(toCapabilityStatus("unrequested")).toBe("unrequested")
  })

  it("treats a missing capability as never requested", () => {
    expect(toCapabilityStatus(undefined)).toBe("unrequested")
    expect(toCapabilityStatus(null)).toBe("unrequested")
  })

  it("fails closed on a status this code does not know", () => {
    expect(toCapabilityStatus("disabled_by_platform")).toBe("inactive")
  })
})

describe("stripeAccountColumns", () => {
  it("maps a recorded account.updated object", () => {
    expect(stripeAccountColumns(fixtureAccount)).toEqual({
      chargesEnabled: false,
      payoutsEnabled: true,
      detailsSubmitted: true,
      transfersCapability: "active",
      requirementsCurrentlyDue: [],
      disabledReason: null,
      country: "ES",
    })
  })

  it("maps requirements and a restricted account", () => {
    const account = stripeAccountSchema.parse({
      ...accountUpdated.data.object,
      payouts_enabled: false,
      capabilities: {},
      country: "de",
      requirements: {
        currently_due: ["external_account", "external_account", "individual.dob.day"],
        past_due: ["external_account"],
        disabled_reason: "requirements.past_due",
      },
    })
    expect(stripeAccountColumns(account)).toMatchObject({
      payoutsEnabled: false,
      transfersCapability: "unrequested",
      requirementsCurrentlyDue: ["external_account", "individual.dob.day"],
      disabledReason: "requirements.past_due",
      country: "DE",
    })
  })

  it("drops a malformed country instead of violating the column check", () => {
    const account = stripeAccountSchema.parse({ ...accountUpdated.data.object, country: "ESP" })
    expect(stripeAccountColumns(account).country).toBeNull()
  })
})

describe("changedAccountFields", () => {
  const row: StripeAccountColumns = {
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    transfersCapability: "inactive",
    requirementsCurrentlyDue: ["external_account"],
    disabledReason: "requirements.past_due",
    country: "ES",
  }

  it("lists only the fields whose value differs", () => {
    expect(changedAccountFields(row, { ...row })).toEqual([])
    expect(
      changedAccountFields(row, { ...row, requirementsCurrentlyDue: ["external_account"] }),
    ).toEqual([])
    expect(
      changedAccountFields(row, {
        ...row,
        payoutsEnabled: true,
        transfersCapability: "active",
        requirementsCurrentlyDue: [],
      }),
    ).toEqual(["payoutsEnabled", "transfersCapability", "requirementsCurrentlyDue"])
  })

  it("ignores fields a partial update does not carry", () => {
    expect(changedAccountFields(row, { transfersCapability: "active" })).toEqual([
      "transfersCapability",
    ])
  })
})

describe("isStaleStripeData", () => {
  const stored = new Date("2026-10-05T12:00:00.750Z")

  it("never treats the first data as stale", () => {
    expect(isStaleStripeData(null, new Date(0))).toBe(false)
  })

  it("rejects data from an earlier second", () => {
    expect(isStaleStripeData(stored, new Date("2026-10-05T11:59:59.000Z"))).toBe(true)
  })

  it("applies data from the same second (events carry whole seconds) or later", () => {
    expect(isStaleStripeData(stored, new Date("2026-10-05T12:00:00.000Z"))).toBe(false)
    expect(isStaleStripeData(stored, new Date("2026-10-05T12:00:01.000Z"))).toBe(false)
  })
})
