import { describe, expect, it } from "vitest"

import {
  currencyMinorDigits,
  currencySymbol,
  formatMoneyInput,
  parseMoneyInput,
} from "@/lib/money-input"

/** Prices typed by people → integer cents and back (§0: money is integer minor units). */

describe("parseMoneyInput", () => {
  it.each([
    ["19", 1900],
    ["19.9", 1990],
    ["19.99", 1999],
    ["19,99", 1999],
    ["19.", 1900],
    ["0", 0],
    ["€19", 1900],
    ["19 €", 1900],
    ["EUR 19.50", 1950],
    ["19 eur", 1900],
    ["1 299", 129_900],
    ["1'299.50", 129_950],
    ["  42  ", 4200],
  ])("%j → %d cents", (typed, cents) => {
    expect(parseMoneyInput(typed)).toEqual({ ok: true, cents })
  })

  it("treats an empty field as no price", () => {
    expect(parseMoneyInput("")).toEqual({ ok: true, cents: null })
    expect(parseMoneyInput("   ")).toEqual({ ok: true, cents: null })
  })

  it.each(["-5", "abc", "1e3", "1.299,00", "19.99.1", ",5", "USD 19", "19 dollars"])(
    "refuses %j",
    (typed) => {
      expect(parseMoneyInput(typed)).toEqual({ ok: false, reason: "invalid" })
    },
  )

  it("refuses more decimals than the currency has, and amounts over the cap", () => {
    expect(parseMoneyInput("19.999")).toEqual({ ok: false, reason: "too_many_decimals" })
    expect(parseMoneyInput("10000.01", { max: 1_000_000 })).toEqual({
      ok: false,
      reason: "too_large",
    })
    expect(parseMoneyInput("10000", { max: 1_000_000 })).toEqual({ ok: true, cents: 1_000_000 })
    expect(parseMoneyInput("9".repeat(20))).toEqual({ ok: false, reason: "too_large" })
  })

  it("follows the currency's minor unit (no decimals for yen)", () => {
    expect(currencyMinorDigits("jpy")).toBe(0)
    expect(parseMoneyInput("1500", { currency: "jpy" })).toEqual({ ok: true, cents: 1500 })
    expect(parseMoneyInput("15.5", { currency: "jpy" })).toEqual({
      ok: false,
      reason: "too_many_decimals",
    })
  })
})

describe("formatMoneyInput", () => {
  it("writes cents back as the field's text, which parses to the same cents", () => {
    for (const cents of [0, 5, 1900, 1990, 1999, 129_950]) {
      const text = formatMoneyInput(cents)
      expect(parseMoneyInput(text)).toEqual({ ok: true, cents })
    }
    expect(formatMoneyInput(1900)).toBe("19")
    expect(formatMoneyInput(1905)).toBe("19.05")
    expect(formatMoneyInput(null)).toBe("")
  })

  it("names the currency's symbol for the field prefix", () => {
    expect(currencySymbol("eur")).toBe("€")
  })
})
