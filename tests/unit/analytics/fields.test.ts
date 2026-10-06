import { describe, expect, it } from "vitest"

import {
  conversion,
  formatRate,
  lastDays,
  parseDayRange,
  rangeBounds,
  rangeDays,
} from "@/lib/analytics/range"
import { refundRequestFormSchema, declineRefundRequestSchema } from "@/lib/refund-requests/fields"
import { createLinkSchema, discountPath } from "@/lib/tracked-links/fields"

const NOW = new Date("2026-10-05T12:00:00Z")
const LAUNCH = "0192f0a0-0000-7000-8000-000000000001"

describe("day ranges", () => {
  it("defaults, clamps to today, caps the length and rejects nonsense", () => {
    const options = { now: NOW, defaultDays: 30, maxDays: 90 }
    expect(parseDayRange({}, options)).toEqual(lastDays(30, NOW))
    expect(lastDays(30, NOW)).toEqual({ from: "2026-09-06", to: "2026-10-05" })
    expect(parseDayRange({ from: "2026-10-01", to: "2026-12-01" }, options)).toEqual({
      from: "2026-10-01",
      to: "2026-10-05",
    })
    expect(parseDayRange({ from: "2026-02-30", to: "2026-10-01" }, options)).toEqual(
      lastDays(30, NOW),
    )
    expect(parseDayRange({ from: "2026-10-04", to: "2026-10-01" }, options)).toEqual(
      lastDays(30, NOW),
    )
    expect(parseDayRange({ from: "2025-01-01", to: "2026-10-05" }, options)).toEqual({
      from: "2026-07-08",
      to: "2026-10-05",
    })
  })

  it("lists days and bounds in UTC", () => {
    const range = { from: "2026-10-30", to: "2026-11-01" }
    expect(rangeDays(range)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"])
    expect(rangeBounds(range)).toEqual({
      start: new Date("2026-10-30T00:00:00Z"),
      end: new Date("2026-11-02T00:00:00Z"),
    })
  })

  it("formats conversion rates", () => {
    expect(conversion(1, 0)).toBeNull()
    expect(formatRate(null)).toBe("–")
    expect(formatRate(conversion(1, 3))).toBe("33%")
    expect(formatRate(conversion(1, 200))).toBe("0.5%")
  })
})

describe("tracked link form", () => {
  it("normalises codes and percentages", () => {
    expect(
      createLinkSchema.parse({
        launchId: LAUNCH,
        label: " Bio ",
        discountCode: " summer 20 ",
        discountPercent: "20%",
      }),
    ).toEqual({ launchId: LAUNCH, label: "Bio", discountCode: "SUMMER20", discountPercent: 20 })
    expect(createLinkSchema.parse({ launchId: LAUNCH, label: "Bio", discountCode: "" })).toEqual({
      launchId: LAUNCH,
      label: "Bio",
    })
  })

  it("needs a name, and a code and a percentage together", () => {
    expect(createLinkSchema.safeParse({ launchId: LAUNCH, label: "" }).success).toBe(false)
    expect(createLinkSchema.safeParse({ launchId: LAUNCH, label: "x".repeat(81) }).success).toBe(
      false,
    )
    expect(
      createLinkSchema.safeParse({ launchId: LAUNCH, label: "a", discountPercent: "10" }).success,
    ).toBe(false)
    expect(
      createLinkSchema.safeParse({
        launchId: LAUNCH,
        label: "a",
        discountCode: "ABCD",
        discountPercent: "101",
      }).success,
    ).toBe(false)
    expect(discountPath("my-app", "SAVE10")).toBe("/p/my-app?code=SAVE10")
  })
})

describe("refund request forms", () => {
  it("needs a known reason; the message is optional and capped", () => {
    expect(refundRequestFormSchema.parse({ reason: "other", message: "  " })).toEqual({
      reason: "other",
    })
    expect(refundRequestFormSchema.safeParse({ reason: "bored" }).success).toBe(false)
    expect(
      refundRequestFormSchema.safeParse({ reason: "other", message: "x".repeat(1001) }).success,
    ).toBe(false)
  })

  it("needs a note to decline", () => {
    const requestId = LAUNCH
    expect(declineRefundRequestSchema.safeParse({ requestId, note: " " }).success).toBe(false)
    expect(declineRefundRequestSchema.parse({ requestId, note: "No." })).toEqual({
      requestId,
      note: "No.",
    })
  })
})
