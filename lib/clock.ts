import { AsyncLocalStorage } from "node:async_hooks"

/**
 * The single source of "now" for business logic (§19.4). Never call `new Date()` / `Date.now()`
 * in lib/ or inngest/ (ESLint enforces this); call `now()` so tests and jobs can mock time.
 *
 * Server-side only (uses AsyncLocalStorage).
 */

export type Clock = () => Date

const scopedClock = new AsyncLocalStorage<Clock>()
let globalClock: Clock | null = null

function toClock(source: Date | Clock): Clock {
  if (typeof source === "function") return source
  const fixed = source.getTime()
  return () => new Date(fixed)
}

/** Current time: the scoped clock (runWithClock), else the test override, else the real time. */
export function now(): Date {
  const clock = scopedClock.getStore() ?? globalClock
  return clock ? clock() : new Date()
}

/**
 * Run `fn` (and everything it awaits) with a mocked clock. Concurrent requests are unaffected,
 * so this is safe inside a running server, e.g. a test route that runs a job "15 days later".
 */
export function runWithClock<T>(clock: Date | Clock, fn: () => T): T {
  return scopedClock.run(toClock(clock), fn)
}

/** Process-wide clock override for unit/integration tests. Pass `null` to restore real time. */
export function setClockForTests(clock: Date | Clock | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setClockForTests is not available in production; use runWithClock")
  }
  globalClock = clock === null ? null : toClock(clock)
}

/** A clock that starts at `start` and moves forward with real elapsed time. */
export function offsetClock(start: Date): Clock {
  const offset = start.getTime() - Date.now()
  return () => new Date(Date.now() + offset)
}
