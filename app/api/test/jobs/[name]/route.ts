import type { NextRequest } from "next/server"
import { z } from "zod"

import { jobEventSchemas } from "@/inngest/client"
import { findJob } from "@/inngest/functions"
import { now, runWithClock } from "@/lib/clock"
import { testRoutesEnabled } from "@/lib/env"

/**
 * Test-only: run one registered job now, optionally under a mocked clock (§15 "the payout job
 * transfers after the hold (clock mocked)", §19.4). Exists only when `testRoutesEnabled()`
 * (E2E_TEST_ROUTES=1 and APP_ENV ≠ production); otherwise every method answers 404.
 *
 *   POST /api/test/jobs/<job id>   body (optional JSON): { "now"?: ISO 8601, "data"?: object }
 *
 * `<job id>` is the `defineJob({ id })`, e.g. `system-ping`. `data` defaults to the job's cron
 * payload, else `{}`; it is validated against the job's event schema (400 when invalid). The
 * handler runs in this process in inline mode and is awaited; the response is
 * `{ ok: true, job, now, result }`, or `{ ok: false, error }` with 500 when the handler throws.
 */

const bodySchema = z
  .object({
    now: z.iso.datetime({ offset: true }).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

type Context = { params: Promise<{ name: string }> }

const json = (body: unknown, status = 200) => Response.json(body, { status })
const notFound = () => json({ ok: false, error: "Not Found" }, 404)

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  if (!testRoutesEnabled()) return notFound()

  const { name } = await context.params
  const job = findJob(name)
  if (!job) return json({ ok: false, error: `Unknown job "${name}"` }, 404)

  const text = await request.text()
  let raw: unknown = {}
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text)
    } catch {
      return json({ ok: false, error: "The body must be JSON" }, 400)
    }
  }
  const body = bodySchema.safeParse(raw)
  if (!body.success) return json({ ok: false, error: z.prettifyError(body.error) }, 400)

  const data = jobEventSchemas[job.event].safeParse(body.data.data ?? job.cron?.data ?? {})
  if (!data.success) {
    return json(
      { ok: false, error: `Invalid data for ${job.id}: ${z.prettifyError(data.error)}` },
      400,
    )
  }

  const clock = body.data.now ? new Date(body.data.now) : null
  const run = async () => ({ result: await job.runInline(data.data), at: now().toISOString() })
  try {
    const { result, at } = clock ? await runWithClock(clock, run) : await run()
    return json({ ok: true, job: job.id, now: at, result: result ?? null })
  } catch (error) {
    // Test-only route: the message helps the failing test; it never exists in production.
    const message = error instanceof Error ? error.message : String(error)
    return json({ ok: false, error: message }, 500)
  }
}

/** Other methods: 404 while disabled (the route does not exist), else 405. */
async function otherMethod(_request: NextRequest, _context: Context): Promise<Response> {
  if (!testRoutesEnabled()) return notFound()
  return new Response(null, { status: 405, headers: { Allow: "POST" } })
}

export const GET = otherMethod
export const PUT = otherMethod
export const PATCH = otherMethod
export const DELETE = otherMethod
