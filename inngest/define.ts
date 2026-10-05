import type { TimeStr } from "inngest"
import type { z } from "zod"

import { newId } from "@/lib/ids"

import { inngest, jobEventSchemas, type JobEventData, type JobEventName } from "./client"

/**
 * Define a background job once and get both execution modes (§13, §19.3):
 * - **Inngest** (live): `job.fn` is an Inngest function, served by `app/api/inngest/route.ts`,
 *   with durable `step.run` memoisation and retries.
 * - **Inline** (fake jobs): `job.runInline(data)` runs the same handler in-process; `enqueue()`
 *   calls it right after the triggering request. `step.run` just calls the function, and there
 *   are no retries, debounce or cron.
 *
 * Handlers must be idempotent (Inngest retries them, and events can be delivered twice), and
 * should wrap each side effect in `step.run` so a retry does not repeat completed work. Values
 * returned from `step.run` are JSON round-tripped under Inngest (a Date comes back as a string),
 * so return plain JSON data from steps.
 *
 * Register every job in `inngest/functions/index.ts`.
 */

export type JobStep = {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>
}

export type JobContext<N extends JobEventName> = {
  event: N
  data: JobEventData<N>
  step: JobStep
  runId: string
  /** 0 on the first try; incremented on each Inngest retry. Always 0 inline. */
  attempt: number
  mode: "inngest" | "inline"
}

export type JobOptions<N extends JobEventName> = {
  /** Stable function id; changing it creates a new function in Inngest. */
  id: string
  event: N
  /** Also run on a schedule (UTC cron) with this payload. Inline mode never fires crons. */
  cron?: { schedule: string; data: JobEventData<N> }
  retries?: Parameters<typeof inngest.createFunction>[0]["retries"]
  concurrency?: { limit: number; key?: string }
  /** e.g. `{ period: "10m", key: "event.data.userId" }` for "debounced 10 min" (§8). */
  debounce?: { period: TimeStr; key?: string; timeout?: TimeStr }
  handler: (context: JobContext<N>) => Promise<unknown>
}

export type Job = {
  id: string
  event: JobEventName
  fn: ReturnType<typeof createInngestFunction>
  /** Validate `data` against the event schema and run the handler in-process. */
  runInline(data: unknown): Promise<unknown>
}

/** The schema for one event, typed by name. */
function schemaFor<N extends JobEventName>(event: N): z.ZodType<JobEventData<N>> {
  // TypeScript cannot correlate an indexed access on a generic key with its output type; the
  // map above is the single source of both, so this is sound.
  return jobEventSchemas[event] as unknown as z.ZodType<JobEventData<N>>
}

export function defineJob<N extends JobEventName>(options: JobOptions<N>): Job {
  const schema = schemaFor(options.event)
  const parse = (data: unknown): JobEventData<N> => schema.parse(data)

  return {
    id: options.id,
    event: options.event,
    fn: createInngestFunction(options, parse),
    runInline: async (data) =>
      options.handler({
        event: options.event,
        data: parse(data),
        step: { run: async (_id, fn) => fn() },
        runId: newId(),
        attempt: 0,
        mode: "inline",
      }),
  }
}

function createInngestFunction<N extends JobEventName>(
  options: JobOptions<N>,
  parse: (data: unknown) => JobEventData<N>,
) {
  const triggers = options.cron
    ? [{ event: options.event }, { cron: options.cron.schedule }]
    : [{ event: options.event }]

  return inngest.createFunction(
    {
      id: options.id,
      triggers,
      retries: options.retries,
      concurrency: options.concurrency,
      debounce: options.debounce,
    },
    async ({ event, step, runId, attempt }) => {
      // Scheduled runs arrive as `inngest/scheduled.timer`; use the declared cron payload.
      const eventName: string = event.name
      const raw: unknown = eventName === options.event ? event.data : options.cron?.data
      const jobStep: JobStep = {
        run: async <T>(id: string, fn: () => Promise<T> | T): Promise<T> => {
          const result: unknown = await step.run(id, async () => fn())
          // Inngest memoises step results as JSON; see the note above about plain data.
          return result as T
        },
      }
      return options.handler({
        event: options.event,
        data: parse(raw),
        step: jobStep,
        runId,
        attempt,
        mode: "inngest",
      })
    },
  )
}
