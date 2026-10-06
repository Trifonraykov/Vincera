import "server-only"

import { after } from "next/server"

import { inngest, jobEventSchemas, type JobEventData, type JobEventName } from "@/inngest/client"
import { isFake } from "@/lib/env"
import { reportError } from "@/lib/observability"

/**
 * Start background work (§13). The payload is validated against the event's schema first.
 *
 * - Live: the event is sent to Inngest, which runs every function triggered by it.
 * - Fake (`inline`, §19.3): the registered handlers run in this process right after the current
 *   response is sent (`after()`); outside a request (scripts, tests) they run before this
 *   resolves. Handler errors are reported to Sentry, never thrown at the caller, like a real
 *   background job.
 */
export async function enqueue<N extends JobEventName>(
  name: N,
  data: JobEventData<N>,
  options: {
    /** Deduplicates sends with the same id (Inngest event idempotency). */
    id?: string
  } = {},
): Promise<void> {
  const payload = jobEventSchemas[name].parse(data)

  if (!isFake("jobs")) {
    await inngest.send({ name, data: payload, ...(options.id ? { id: options.id } : {}) })
    return
  }

  const task = () => runHandlers(name, payload, { rethrow: false })
  if (!scheduleAfterResponse(task)) await task()
}

/**
 * Run every handler for `name` now and wait for them, rethrowing failures. For test routes and
 * scripts, e.g. running `payouts/release` under `runWithClock` (§19.4). Works in any mode.
 */
export async function runJobsNow<N extends JobEventName>(
  name: N,
  data: JobEventData<N>,
): Promise<unknown[]> {
  return runHandlers(name, jobEventSchemas[name].parse(data), { rethrow: true })
}

async function runHandlers(
  name: JobEventName,
  payload: unknown,
  { rethrow }: { rethrow: boolean },
): Promise<unknown[]> {
  // Loaded lazily: job modules may import enqueue() themselves to chain work.
  const { jobsFor } = await import("@/inngest/functions")
  const results: unknown[] = []
  for (const job of jobsFor(name)) {
    try {
      results.push(await job.runInline(payload))
    } catch (error) {
      if (rethrow) throw error
      reportError(error, { tags: { job: job.id, job_mode: "inline" } })
    }
  }
  return results
}

/** Defer `task` until the response is sent. False when there is no request to defer to. */
function scheduleAfterResponse(task: () => Promise<unknown>): boolean {
  try {
    after(task)
    return true
  } catch {
    // `after` throws outside a request scope (scripts, unit tests).
    return false
  }
}
