import { beforeEach, describe, expect, it, vi } from "vitest"

import { inngest, isJobEventName, JOB_EVENT_NAMES } from "@/inngest/client"
import { functions, jobs, jobsFor } from "@/inngest/functions"
import { setClockForTests } from "@/lib/clock"
import { enqueue, runJobsNow } from "@/lib/jobs/enqueue"

import { stubServiceEnv } from "../helpers/service-env"

beforeEach(() => {
  stubServiceEnv()
  setClockForTests(new Date("2026-06-01T08:00:00.000Z"))
  return () => setClockForTests(null)
})

describe("job registry", () => {
  it("registers every job once, with an Inngest function each", () => {
    const ids = jobs.map((job) => job.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(functions).toHaveLength(jobs.length)
    for (const job of jobs) expect(isJobEventName(job.event)).toBe(true)
    expect(JOB_EVENT_NAMES).toEqual(
      expect.arrayContaining([
        "system/ping",
        "social/sync.requested",
        "embeddings/refresh.requested",
        "matching/recompute.requested",
      ]),
    )
    // Every declared event has a job listening to it.
    for (const name of JOB_EVENT_NAMES) expect(jobsFor(name).length, name).toBeGreaterThan(0)
  })

  it("registers the Phase 2–3 job ids and schedules of the W2 contract (CLAUDE.md §19.24)", () => {
    const byId = new Map(jobs.map((job) => [job.id, job]))
    expect(Object.fromEntries([...byId].map(([id, job]) => [id, job.event]))).toMatchObject({
      "embeddings-refresh": "embeddings/refresh.requested",
      "matching-recompute": "matching/recompute.requested",
      "matching-target-changed": "matching/target-changed.requested",
      "matching-nightly": "matching/nightly.requested",
      "proposals-expire": "proposals/expire.requested",
      "reminders-stalled": "reminders/stalled.requested",
      "agreements-finalize": "agreements/finalize.requested",
    })
    expect(byId.get("matching-nightly")?.cron).toEqual({ schedule: "30 5 * * *", data: {} })
    expect(byId.get("proposals-expire")?.cron).toEqual({ schedule: "5 * * * *", data: {} })
    expect(byId.get("reminders-stalled")?.cron).toEqual({ schedule: "50 8 * * *", data: {} })
  })

  it("runs a handler inline with a validated payload and pass-through steps", async () => {
    const [ping] = jobsFor("system/ping")
    expect(await ping?.runInline({ note: "hi" })).toEqual({
      pong: true,
      at: "2026-06-01T08:00:00.000Z",
      mode: "inline",
      note: "hi",
    })
    await expect(ping?.runInline({ note: 42 })).rejects.toThrow()
  })
})

describe("enqueue", () => {
  it("runs jobs inline when the jobs service is fake (outside a request: awaited)", async () => {
    const [ping] = jobsFor("system/ping")
    const spy = vi.spyOn(ping!, "runInline")
    await enqueue("system/ping", { note: "inline" })
    expect(spy).toHaveBeenCalledWith({ note: "inline" })
  })

  it("reports inline handler failures instead of throwing", async () => {
    const [ping] = jobsFor("system/ping")
    vi.spyOn(ping!, "runInline").mockRejectedValueOnce(new Error("boom"))
    await expect(enqueue("system/ping", {})).resolves.toBeUndefined()
  })

  it("validates payloads before sending", async () => {
    await expect(
      // @ts-expect-error -- connectionId must be a UUID string
      enqueue("social/sync.requested", { connectionId: 1, reason: "manual" }),
    ).rejects.toThrow()
  })

  it("sends to Inngest when jobs are live", async () => {
    stubServiceEnv({ INNGEST_EVENT_KEY: "evt", INNGEST_SIGNING_KEY: "signkey-test-123" })
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: ["evt_1"] })
    const connectionId = "01890000-0000-7000-8000-000000000001"
    await enqueue("social/sync.requested", { connectionId, reason: "connected" }, { id: "dedupe" })
    expect(send).toHaveBeenCalledWith({
      name: "social/sync.requested",
      data: { connectionId, reason: "connected" },
      id: "dedupe",
    })
  })

  it("runJobsNow awaits handlers and rethrows failures", async () => {
    expect(await runJobsNow("system/ping", {})).toEqual([
      { pong: true, at: "2026-06-01T08:00:00.000Z", mode: "inline", note: null },
    ])
    const [ping] = jobsFor("system/ping")
    vi.spyOn(ping!, "runInline").mockRejectedValueOnce(new Error("boom"))
    await expect(runJobsNow("system/ping", {})).rejects.toThrow("boom")
  })
})
