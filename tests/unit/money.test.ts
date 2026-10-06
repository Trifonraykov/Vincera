import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  MoneyError,
  assertIntegerCents,
  assertNonNegativeCents,
  formatMoney,
  isIntegerCents,
  sumCents,
} from "@/lib/money"

/** Intl uses (narrow) no-break spaces; compare with plain spaces. */
const format = (...args: Parameters<typeof formatMoney>) =>
  formatMoney(...args).replace(/[\u00a0\u202f]/g, " ")

describe("formatMoney", () => {
  it("formats minor units using the currency's decimals", () => {
    expect(formatMoney(1999, "eur")).toBe("€19.99")
    expect(formatMoney(1999, "USD")).toBe("$19.99")
    expect(formatMoney(0, "eur")).toBe("€0.00")
    expect(formatMoney(-500, "eur")).toBe("-€5.00")
    expect(formatMoney(1999, "jpy")).toBe("¥1,999")
    expect(format(1999, "bhd")).toBe("BHD 1.999")
  })

  it("respects the locale", () => {
    expect(format(123456, "eur", "de-DE")).toBe("1.234,56 €")
    expect(format(123456, "eur", "es-ES")).toBe("1234,56 €")
  })

  it("refuses non-integer amounts", () => {
    expect(() => formatMoney(19.99, "eur")).toThrow(MoneyError)
  })
})

describe("integer helpers", () => {
  it("accepts only safe integers", () => {
    expect(isIntegerCents(100)).toBe(true)
    expect(isIntegerCents(-100)).toBe(true)
    expect(isIntegerCents(1.5)).toBe(false)
    expect(isIntegerCents(Number.NaN)).toBe(false)
    expect(isIntegerCents(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(isIntegerCents("100")).toBe(false)
    expect(() => assertIntegerCents(0.1, "price")).toThrow(/price must be an integer/)
    expect(() => assertNonNegativeCents(-1)).toThrow(/must not be negative/)
    expect(() => assertNonNegativeCents(0)).not.toThrow()
  })

  it("sums integer cents exactly", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 })), (values) => {
        const expected = values.reduce((total, value) => total + value, 0)
        expect(sumCents(values)).toBe(expected)
      }),
    )
  })

  it("fails loudly on overflow or fractional input", () => {
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyError)
    expect(() => sumCents([1, 0.5])).toThrow(MoneyError)
  })
})
