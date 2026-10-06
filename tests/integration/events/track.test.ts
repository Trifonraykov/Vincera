import { eq, inArray } from "drizzle-orm"
import { afterEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { withTransaction } from "@/lib/db/client"
import { events } from "@/lib/db/schema"
import { EventPiiError } from "@/lib/events/pii"
import { track, trackMany } from "@/lib/events/track"
import type { TrackInput } from "@/lib/events/types"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"

const testDb = setupTestDatabase()

afterEach(() => setClockForTests(null))

async function eventById(id: string) {
  const [row] = await testDb.db.select().from(events).where(eq(events.id, id))
  return row
}

describe("track", () => {
  it("writes a typed event with actor, subject, properties, context and the clock's time", async () => {
    const at = new Date("2026-04-01T09:30:00.000Z")
    setClockForTests(at)
    const user = await insertUser(testDb.db)

    const id = await track(
      "user.signed_up",
      {
        actorUserId: user.id,
        subjectType: "user",
        subjectId: user.id,
        properties: { method: "email" },
        context: { ip_country: "ES", ua_hash: "abc123", session_id: "s-1" },
      },
      testDb.db,
    )

    expect(await eventById(id)).toEqual({
      id,
      type: "user.signed_up",
      occurredAt: at,
      actorUserId: user.id,
      subjectType: "user",
      subjectId: user.id,
      properties: { method: "email" },
      context: { ip_country: "ES", ua_hash: "abc123", session_id: "s-1" },
    })
  })

  it("commits and rolls back with the caller's transaction", async () => {
    const user = await insertUser(testDb.db)
    const input = {
      subjectType: "user",
      subjectId: user.id,
      properties: { role: "creator", source: "onboarding" },
    } satisfies TrackInput<"user.role_added">

    let committedId = ""
    await withTransaction(async (tx) => {
      committedId = await track("user.role_added", input, tx)
    }, testDb.db)
    expect(await eventById(committedId)).toBeDefined()

    let rolledBackId = ""
    await withTransaction(async (tx) => {
      rolledBackId = await track("user.role_added", input, tx)
      throw new Error("state change failed")
    }, testDb.db).catch(() => {})
    expect(rolledBackId).not.toBe("")
    expect(await eventById(rolledBackId)).toBeUndefined()
  })

  it("trackMany writes a batch in one insert", async () => {
    const user = await insertUser(testDb.db)
    const matchIds = [crypto.randomUUID(), crypto.randomUUID()]
    const ids = await trackMany(
      matchIds.map((matchId, index) => ({
        type: "match.shown" as const,
        actorUserId: user.id,
        subjectType: "match" as const,
        subjectId: matchId,
        properties: {
          model_version: "v0",
          target_type: "product" as const,
          rank: index + 1,
          score: 0.5,
        },
      })),
      testDb.db,
    )
    expect(ids).toHaveLength(2)
    const rows = await testDb.db.select().from(events).where(inArray(events.id, ids))
    expect(rows.map((r) => r.subjectId).sort()).toEqual([...matchIds].sort())
    expect(await trackMany([], testDb.db)).toEqual([])
  })

  it("rejects properties that look like PII outside production, writing nothing", async () => {
    const user = await insertUser(testDb.db)
    const before = await testDb.db.select().from(events)

    const attempts: Array<() => Promise<string>> = [
      // Forbidden key (the type system already refuses it; this is the runtime net).
      () =>
        track(
          "message.sent",
          {
            subjectType: "thread",
            subjectId: user.id,
            // @ts-expect-error -- `body` is not a message.sent property
            properties: { thread_kind: "collab", attachment_count: 0, body: "hello there" },
          },
          testDb.db,
        ),
      // Email hidden in an allowed string field.
      () =>
        track(
          "idea.created",
          {
            subjectType: "idea",
            subjectId: user.id,
            properties: {
              format: "app",
              topics: ["contact me at someone@example.com"],
              target_price_cents: null,
            },
          },
          testDb.db,
        ),
    ]
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(EventPiiError)

    expect(await testDb.db.select().from(events)).toHaveLength(before.length)
  })

  it("in production, drops PII-looking fields and logs instead of failing the write", async () => {
    vi.stubEnv("APP_ENV", "production")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = await insertUser(testDb.db)

    const id = await track(
      "message.sent",
      {
        subjectType: "thread",
        subjectId: user.id,
        // @ts-expect-error -- `buyer_email` is not a message.sent property
        properties: { thread_kind: "proposal", attachment_count: 2, buyer_email: "b@example.com" },
      },
      testDb.db,
    )

    expect((await eventById(id))?.properties).toEqual({
      thread_kind: "proposal",
      attachment_count: 2,
    })
    expect(log).toHaveBeenCalledOnce()
    expect(String(log.mock.calls[0]?.[0])).toContain("buyer_email")
    expect(String(log.mock.calls[0]?.[0])).not.toContain("b@example.com")
  })

  it("validates the event type, subject and context at runtime", async () => {
    const user = await insertUser(testDb.db)
    const base = {
      subjectType: "user" as const,
      subjectId: user.id,
      properties: { method: "github" as const },
    }

    await expect(
      track("user.signed_up", { ...base, subjectId: "not-a-uuid" }, testDb.db),
    ).rejects.toThrow(/subjectId must be a UUID/)
    await expect(
      // @ts-expect-error -- not a catalog event type
      track("user.teleported", base, testDb.db),
    ).rejects.toThrow(/Unknown event type/)
    await expect(
      track("user.signed_up", { ...base, context: { ip_country: "Spain" } }, testDb.db),
    ).rejects.toThrow()
  })
})
