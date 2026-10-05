import { afterEach, describe, expect, it } from "vitest"

import { now, offsetClock, runWithClock, setClockForTests } from "@/lib/clock"

const fixed = new Date("2026-01-15T12:00:00.000Z")

afterEach(() => setClockForTests(null))

describe("clock", () => {
  it("returns the real time by default", () => {
    const before = Date.now()
    const current = now().getTime()
    expect(current).toBeGreaterThanOrEqual(before)
    expect(current).toBeLessThanOrEqual(Date.now())
  })

  it("can be overridden globally in tests", () => {
    setClockForTests(fixed)
    expect(now().toISOString()).toBe(fixed.toISOString())
    setClockForTests(null)
    expect(now().getTime()).not.toBe(fixed.getTime())
  })

  it("returns a copy, so callers cannot mutate the mocked time", () => {
    setClockForTests(fixed)
    now().setUTCFullYear(2000)
    expect(now().toISOString()).toBe(fixed.toISOString())
  })

  it("scopes runWithClock to the callback, including across awaits", async () => {
    const later = new Date("2026-02-01T00:00:00.000Z")
    const seen = await runWithClock(later, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return now().toISOString()
    })
    expect(seen).toBe(later.toISOString())
    expect(now().toISOString()).not.toBe(later.toISOString())
  })

  it("keeps concurrent scopes isolated", async () => {
    const a = new Date("2030-01-01T00:00:00.000Z")
    const b = new Date("2031-01-01T00:00:00.000Z")
    const read = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return now().toISOString()
    }
    const [seenA, seenB] = await Promise.all([runWithClock(a, read), runWithClock(b, read)])
    expect(seenA).toBe(a.toISOString())
    expect(seenB).toBe(b.toISOString())
  })

  it("prefers the scoped clock over the global override", () => {
    setClockForTests(fixed)
    const scoped = new Date("2027-01-01T00:00:00.000Z")
    expect(runWithClock(scoped, () => now().toISOString())).toBe(scoped.toISOString())
  })

  it("supports clocks that advance from a start time", () => {
    setClockForTests(offsetClock(fixed))
    const elapsed = now().getTime() - fixed.getTime()
    expect(elapsed).toBeGreaterThanOrEqual(0)
    expect(elapsed).toBeLessThan(1000)
  })
})
