import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DELETE, GET, POST } from "@/app/api/test/jobs/[name]/route"
import * as registry from "@/inngest/functions"
import type { Job } from "@/inngest/define"
import { setClockForTests } from "@/lib/clock"

import { stubServiceEnv } from "../../helpers/service-env"

function post(name: string, body?: unknown) {
  const request = new NextRequest(`http://localhost/api/test/jobs/${name}`, {
    method: "POST",
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
  return POST(request, { params: Promise.resolve({ name }) })
}

function other(handler: typeof GET, name = "system-ping") {
  return handler(new NextRequest(`http://localhost/api/test/jobs/${name}`), {
    params: Promise.resolve({ name }),
  })
}

beforeEach(() => {
  setClockForTests(new Date("2026-06-01T08:00:00.000Z"))
  return () => setClockForTests(null)
})

describe("POST /api/test/jobs/[name]: gating", () => {
  it("does not exist unless E2E_TEST_ROUTES is set", async () => {
    stubServiceEnv()
    const runInline = vi.spyOn(registry.findJob("system-ping")!, "runInline")
    for (const response of [await post("system-ping"), await other(GET), await other(DELETE)]) {
      expect(response.status).toBe(404)
    }
    expect(runInline).not.toHaveBeenCalled()
  })

  it("does not exist in production, even with E2E_TEST_ROUTES (the env refuses it)", async () => {
    // A production build phase parses without the production-only requirements; testRoutesEnabled
    // still says no because APP_ENV is production.
    stubServiceEnv({
      APP_ENV: "production",
      NEXT_PHASE: "phase-production-build",
      E2E_TEST_ROUTES: "1",
    })
    expect((await post("system-ping")).status).toBe(404)
  })

  it("answers 405 to other methods when enabled", async () => {
    stubServiceEnv({ E2E_TEST_ROUTES: "1" })
    const response = await other(GET)
    expect(response.status).toBe(405)
    expect(response.headers.get("Allow")).toBe("POST")
  })
})

describe("POST /api/test/jobs/[name]: running jobs", () => {
  afterEach(() => vi.restoreAllMocks())

  it("runs the job now, or under the mocked clock given as `now`", async () => {
    stubServiceEnv({ E2E_TEST_ROUTES: "1" })
    const plain = await post("system-ping", { data: { note: "hi" } })
    expect(plain.status).toBe(200)
    expect(await plain.json()).toEqual({
      ok: true,
      job: "system-ping",
      now: "2026-06-01T08:00:00.000Z",
      result: { pong: true, at: "2026-06-01T08:00:00.000Z", mode: "inline", note: "hi" },
    })

    const later = await post("system-ping", { now: "2026-06-16T06:00:00+00:00" })
    expect(await later.json()).toMatchObject({
      ok: true,
      now: "2026-06-16T06:00:00.000Z",
      result: { at: "2026-06-16T06:00:00.000Z", note: null },
    })
  })

  it("accepts an empty body", async () => {
    stubServiceEnv({ E2E_TEST_ROUTES: "1" })
    expect((await post("system-ping")).status).toBe(200)
  })

  it("uses the job's cron payload when no data is given", async () => {
    stubServiceEnv({ E2E_TEST_ROUTES: "1" })
    const runInline = vi.fn(async (data: unknown) => ({ received: data }))
    const scheduled: Job = {
      ...registry.findJob("system-ping")!,
      id: "nightly-ping",
      cron: { schedule: "0 3 * * *", data: { note: "nightly" } },
      runInline,
    }
    vi.spyOn(registry, "findJob").mockReturnValue(scheduled)
    expect(await (await post("nightly-ping")).json()).toMatchObject({
      ok: true,
      result: { received: { note: "nightly" } },
    })
  })

  it("rejects unknown jobs, bad bodies and invalid job data", async () => {
    stubServiceEnv({ E2E_TEST_ROUTES: "1" })
    expect((await post("no-such-job")).status).toBe(404)
    expect((await post("system-ping", "{not json")).status).toBe(400)
    expect((await post("system-ping", { now: "tomorrow" })).status).toBe(400)
    expect((await post("system-ping", { extra: true })).status).toBe(400)
    const invalid = await post("system-ping", { data: { note: 42 } })
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error).toMatch(/Invalid data for system-ping/)
  })

  it("reports a failing handler as 500 with its message", async () => {
    stubServiceEnv({ E2E_TEST_ROUTES: "1" })
    vi.spyOn(registry.findJob("system-ping")!, "runInline").mockRejectedValueOnce(new Error("boom"))
    const response = await post("system-ping")
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: "boom" })
  })
})
