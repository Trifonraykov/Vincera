import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setClockForTests } from "@/lib/clock"
import {
  clientIp,
  RATE_LIMITS,
  rateLimit,
  resetMemoryRateLimits,
  retryAfterSeconds,
  windowMs,
} from "@/lib/ratelimit"

import { stubServiceEnv } from "../helpers/service-env"

const T0 = new Date("2026-05-01T00:00:00.000Z")

beforeEach(() => {
  stubServiceEnv()
  resetMemoryRateLimits()
  setClockForTests(T0)
})

afterEach(() => setClockForTests(null))

describe("rateLimit (in-memory fake)", () => {
  it("allows up to the limit, then blocks until the window slides", async () => {
    const rule = { limit: 3, window: "1 m" } as const
    const results = []
    for (let i = 0; i < 4; i++) results.push(await rateLimit("test", "user-1", rule))

    expect(results.map((r) => r.success)).toEqual([true, true, true, false])
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0])
    expect(results[3]?.reset).toBe(T0.getTime() + 60_000)
    expect(retryAfterSeconds(results[3]!)).toBe(60)

    setClockForTests(new Date(T0.getTime() + 60_001))
    expect((await rateLimit("test", "user-1", rule)).success).toBe(true)
  })

  it("keeps keys and buckets independent", async () => {
    const rule = { limit: 1, window: "1 h" } as const
    expect((await rateLimit("a", "k1", rule)).success).toBe(true)
    expect((await rateLimit("a", "k1", rule)).success).toBe(false)
    expect((await rateLimit("a", "k2", rule)).success).toBe(true)
    expect((await rateLimit("b", "k1", rule)).success).toBe(true)
  })

  it("uses the predefined §14 buckets", async () => {
    expect(RATE_LIMITS.proposals).toEqual({ limit: 20, window: "1 d" })
    for (let i = 0; i < 20; i++) {
      expect((await rateLimit("proposals", "user-1")).success).toBe(true)
    }
    const blocked = await rateLimit("proposals", "user-1")
    expect(blocked).toMatchObject({ success: false, limit: 20, remaining: 0 })
  })

  it("requires a rule for unknown buckets and validates rules", async () => {
    // @ts-expect-error -- custom buckets must pass a rule
    await expect(rateLimit("custom", "k")).rejects.toThrow(/Unknown rate limit bucket/)
    await expect(rateLimit("custom", "k", { limit: 0, window: "1 m" })).rejects.toThrow()
  })
})

describe("helpers", () => {
  it("parses windows", () => {
    expect(windowMs("500 ms")).toBe(500)
    expect(windowMs("10 m")).toBe(600_000)
    expect(windowMs("1 d")).toBe(86_400_000)
    // @ts-expect-error -- not a valid window
    expect(() => windowMs("forever")).toThrow()
  })

  it("reads the client IP from proxy headers", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    )
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2")
    expect(clientIp(new Headers())).toBe("unknown")
  })
})
