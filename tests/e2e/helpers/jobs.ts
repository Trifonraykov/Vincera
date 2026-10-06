import { expect, type APIRequestContext } from "@playwright/test"
import { z } from "zod"

const jobResponseSchema = z.object({ ok: z.literal(true), result: z.unknown() })

/**
 * Run a registered job through the test-only route (`app/api/test/jobs/[name]/route.ts`, needs
 * E2E_TEST_ROUTES=1), optionally under a mocked clock, e.g. the payout job "15 days later" (§15).
 * Returns the job's result; fails the test when the job fails.
 */
export async function runJob(
  request: APIRequestContext,
  jobId: string,
  options: { now?: Date; data?: Record<string, unknown> } = {},
): Promise<unknown> {
  const response = await request.post(`/api/test/jobs/${jobId}`, {
    data: { now: options.now?.toISOString(), data: options.data },
  })
  const body: unknown = await response.json()
  expect(response.status(), JSON.stringify(body)).toBe(200)
  return jobResponseSchema.parse(body).result
}
