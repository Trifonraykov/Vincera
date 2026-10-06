import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { stripeEvents } from "@/lib/db/schema"
import type { StripeEventHandler } from "@/lib/stripe/handlers"
import { jsonObjectSchema, stripeEventSchema } from "@/lib/stripe/schemas"
import { processStripeEvent } from "@/lib/stripe/webhooks"

import checkoutCompletedFixture from "../../fixtures/stripe/checkout.session.completed.json"
import { setupTestDatabase } from "../../helpers/db"

/**
 * `afterCommit` in the webhook context (CLAUDE.md §19.31): side effects queued by a handler run
 * after the event's transaction commits, never after a rollback, and their failures do not fail
 * the (already processed) event.
 */

const handler = vi.hoisted(() => ({ current: null as StripeEventHandler | null }))
vi.mock("@/lib/stripe/handlers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/stripe/handlers")>()
  return { ...original, stripeEventHandler: () => handler.current }
})
const reportError = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability", () => ({ reportError }))

const testDb = setupTestDatabase()

let counter = 0
function event() {
  counter += 1
  const raw = { ...structuredClone(checkoutCompletedFixture), id: `evt_after_commit_${counter}` }
  return { event: stripeEventSchema.parse(raw), payload: jsonObjectSchema.parse(raw) }
}

beforeEach(() => {
  handler.current = null
  reportError.mockReset()
})

describe("afterCommit", () => {
  it("runs queued tasks in order after the commit, seeing the committed rows", async () => {
    const seen: string[] = []
    const { event: e, payload } = event()
    handler.current = async (_event, { afterCommit }) => {
      afterCommit(async () => {
        const [row] = await testDb.db
          .select({ processedAt: stripeEvents.processedAt })
          .from(stripeEvents)
          .where(eq(stripeEvents.id, e.id))
        seen.push(row?.processedAt ? "first:committed" : "first:uncommitted")
      })
      afterCommit(() => {
        seen.push("second")
      })
      seen.push("handler")
    }
    await expect(processStripeEvent(testDb.db, e, payload)).resolves.toEqual({
      status: "processed",
    })
    expect(seen).toEqual(["handler", "first:committed", "second"])
  })

  it("never runs tasks of a handler that failed", async () => {
    const task = vi.fn()
    const { event: e, payload } = event()
    handler.current = async (_event, { afterCommit }) => {
      afterCommit(task)
      throw new Error("handler failed")
    }
    await expect(processStripeEvent(testDb.db, e, payload)).rejects.toThrow("handler failed")
    expect(task).not.toHaveBeenCalled()
  })

  it("reports a failing task and still runs the next one; the event stays processed", async () => {
    const next = vi.fn()
    const { event: e, payload } = event()
    handler.current = async (_event, { afterCommit }) => {
      afterCommit(() => {
        throw new Error("email down")
      })
      afterCommit(next)
    }
    await expect(processStripeEvent(testDb.db, e, payload)).resolves.toEqual({
      status: "processed",
    })
    expect(next).toHaveBeenCalledOnce()
    expect(reportError).toHaveBeenCalledOnce()
    // A duplicate delivery does not run anything again.
    await expect(processStripeEvent(testDb.db, e, payload)).resolves.toEqual({
      status: "duplicate",
    })
    expect(next).toHaveBeenCalledOnce()
  })
})
