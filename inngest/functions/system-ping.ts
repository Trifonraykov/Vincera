import { now } from "@/lib/clock"

import { defineJob } from "../define"

/** Trivial job proving the pipeline works end to end (Inngest dashboard, inline runner, tests). */
export const systemPing = defineJob({
  id: "system-ping",
  event: "system/ping",
  retries: 0,
  handler: async ({ data, step, mode }) => {
    const at = await step.run("record-time", () => now().toISOString())
    return { pong: true, at, mode, note: data.note ?? null }
  },
})
