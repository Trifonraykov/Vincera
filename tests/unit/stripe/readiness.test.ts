import { describe, expect, it } from "vitest"

import {
  isPayoutsReady,
  payoutsStateOf,
  payoutsStatusOf,
  type PayoutsStatusInput,
} from "@/lib/payouts/readiness"
import { isPayoutCountry, payoutCountryOptions, PAYOUT_COUNTRY_CODES } from "@/lib/stripe/countries"
import { payoutsErrorMessage } from "@/lib/stripe/paths"

const base: PayoutsStatusInput = {
  payoutsEnabled: false,
  transfersCapability: "inactive",
  detailsSubmitted: false,
  requirementsCurrentlyDue: ["external_account"],
  disabledReason: "requirements.past_due",
}

describe("isPayoutsReady (§19.10)", () => {
  it("needs payouts_enabled and an active transfers capability", () => {
    expect(isPayoutsReady(null)).toBe(false)
    expect(isPayoutsReady({ payoutsEnabled: true, transfersCapability: "active" })).toBe(true)
    expect(isPayoutsReady({ payoutsEnabled: true, transfersCapability: "pending" })).toBe(false)
    expect(isPayoutsReady({ payoutsEnabled: false, transfersCapability: "active" })).toBe(false)
  })

  it("summarises to none / pending / ready", () => {
    expect(payoutsStateOf(undefined)).toBe("none")
    expect(payoutsStateOf(base)).toBe("pending")
    expect(payoutsStateOf({ ...base, payoutsEnabled: true, transfersCapability: "active" })).toBe(
      "ready",
    )
  })
})

describe("payoutsStatusOf", () => {
  it("is not_started without an account", () => {
    expect(payoutsStatusOf(null)).toEqual({ kind: "not_started" })
  })

  it("asks for action while onboarding is unfinished or requirements are due", () => {
    expect(payoutsStatusOf(base)).toEqual({ kind: "action_required", dueCount: 1 })
    expect(payoutsStatusOf({ ...base, requirementsCurrentlyDue: [] })).toEqual({
      kind: "action_required",
      dueCount: 0,
    })
    expect(
      payoutsStatusOf({ ...base, detailsSubmitted: true, requirementsCurrentlyDue: ["x", "y"] }),
    ).toEqual({ kind: "action_required", dueCount: 2 })
  })

  it("is verifying when everything is submitted but not active yet", () => {
    expect(
      payoutsStatusOf({
        ...base,
        detailsSubmitted: true,
        transfersCapability: "pending",
        requirementsCurrentlyDue: [],
        disabledReason: "requirements.pending_verification",
      }),
    ).toEqual({ kind: "verifying" })
  })

  it("is restricted when Stripe rejected the account", () => {
    expect(
      payoutsStatusOf({ ...base, detailsSubmitted: true, disabledReason: "rejected.fraud" }),
    ).toEqual({ kind: "restricted" })
  })

  it("is ready when payouts-ready, flagging upcoming requirements", () => {
    const ready = {
      ...base,
      payoutsEnabled: true,
      transfersCapability: "active" as const,
      detailsSubmitted: true,
      disabledReason: null,
    }
    expect(payoutsStatusOf({ ...ready, requirementsCurrentlyDue: [] })).toEqual({
      kind: "ready",
      dueCount: 0,
    })
    expect(payoutsStatusOf(ready)).toEqual({ kind: "ready", dueCount: 1 })
  })
})

describe("payout countries", () => {
  it("covers the cross-border regions (EEA, UK, CH, US, CA) and sorts by name", () => {
    for (const code of ["ES", "DE", "NO", "LI", "GB", "CH", "US", "CA"]) {
      expect(isPayoutCountry(code)).toBe(true)
    }
    for (const code of ["IS", "BR", "es", "", null, undefined, "toString"]) {
      expect(isPayoutCountry(code)).toBe(false)
    }
    const names = payoutCountryOptions().map((option) => option.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")))
    expect(names).toHaveLength(PAYOUT_COUNTRY_CODES.length)
  })
})

describe("payoutsErrorMessage", () => {
  it("explains known codes only", () => {
    expect(payoutsErrorMessage("link")).toMatch(/couldn't open Stripe/)
    expect(payoutsErrorMessage("nope")).toBeNull()
    expect(payoutsErrorMessage(["link"])).toBeNull()
    expect(payoutsErrorMessage(undefined)).toBeNull()
  })
})
