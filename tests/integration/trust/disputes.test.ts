import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { disputes, events, notifications, users } from "@/lib/db/schema"
import {
  DISPUTE_MESSAGES,
  listCollabDisputes,
  notifyDisputeOpened,
  raiseDispute,
} from "@/lib/disputes/service"
import { resetMemoryRateLimits } from "@/lib/ratelimit"

import { insertCollab, insertUser } from "../../helpers/db-fixtures"
import { setupTestDatabase } from "../../helpers/db"
import { stubServiceEnv } from "../../helpers/service-env"
import { authUserOf, makeTempDataDir, removeTempDataDir } from "../proposals/helpers"

/**
 * Collab disputes raised by members (CLAUDE.md §19.38, §19.40): the row and `dispute.opened`, one
 * unresolved dispute per member and collab, members only, the notices to the other member and the
 * admins, and the server action (authorization, field errors, rate limit).
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown, user: null as AuthUser | null }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => {
    if (!mocks.user) throw new Error("no user")
    return mocks.user
  },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const { raiseDisputeAction } = await import("@/lib/disputes/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-06T12:00:00.000Z")
const DESCRIPTION = "The builder stopped answering and the agreed files were never delivered."

beforeAll(async () => {
  mocks.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dir)
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.user = null
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(async () => {
  setClockForTests(null)
  await closeDb()
})

async function insertAdmin() {
  return insertUser(testDb.db, { roles: ["admin"], name: "Admin" })
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}

/** Resolve a dispute directly (the admin area's job), so the member may raise another. */
async function resolveDirectly(disputeId: string, adminId: string) {
  await testDb.db
    .update(disputes)
    .set({
      status: "resolved",
      inReviewAt: NOW,
      inReviewByUserId: adminId,
      resolvedAt: NOW,
      resolvedBy: adminId,
      outcome: "no_action",
      resolutionNote: "Settled in the messages.",
    })
    .where(eq(disputes.id, disputeId))
}

describe("raiseDispute", () => {
  it("opens a dispute with its event, once per member until resolved", async () => {
    const { collab, creator, builder } = await insertCollab(testDb.db, { stage: "building" })
    const { disputeId } = await raiseDispute(testDb.db, {
      collabId: collab.id,
      userId: creator.user.id,
      kind: "non_delivery",
      description: DESCRIPTION,
    })
    const [row] = await testDb.db.select().from(disputes).where(eq(disputes.id, disputeId))
    expect(row).toMatchObject({
      status: "open",
      kind: "non_delivery",
      raisedByUserId: creator.user.id,
    })

    const [event] = await testDb.db
      .select()
      .from(events)
      .where(and(eq(events.subjectId, disputeId), eq(events.type, "dispute.opened")))
    expect(event).toMatchObject({
      actorUserId: creator.user.id,
      properties: { collab_id: collab.id, kind: "non_delivery" },
    })

    await expect(
      raiseDispute(testDb.db, {
        collabId: collab.id,
        userId: creator.user.id,
        kind: "split",
        description: DESCRIPTION,
      }),
    ).rejects.toThrow(DISPUTE_MESSAGES.alreadyOpen)

    // The other member may raise their own.
    await raiseDispute(testDb.db, {
      collabId: collab.id,
      userId: builder.user.id,
      kind: "split",
      description: DESCRIPTION,
    })
    const list = await listCollabDisputes(testDb.db, collab.id)
    expect(list).toHaveLength(2)
  })

  it("refuses non-members and unknown collabs", async () => {
    const { collab } = await insertCollab(testDb.db)
    const stranger = await insertUser(testDb.db, { roles: ["creator"] })
    await expect(
      raiseDispute(testDb.db, {
        collabId: collab.id,
        userId: stranger.id,
        kind: "other",
        description: DESCRIPTION,
      }),
    ).rejects.toThrow(DISPUTE_MESSAGES.notMember)
    await expect(
      raiseDispute(testDb.db, {
        collabId: "0190f5e4-0000-7000-8000-000000000000",
        userId: stranger.id,
        kind: "other",
        description: DESCRIPTION,
      }),
    ).rejects.toThrow(DISPUTE_MESSAGES.notFound)
  })

  it("lists unresolved disputes first", async () => {
    const admin = await insertAdmin()
    const { collab, creator } = await insertCollab(testDb.db, { stage: "building" })
    const first = await raiseDispute(testDb.db, {
      collabId: collab.id,
      userId: creator.user.id,
      kind: "split",
      description: DESCRIPTION,
    })
    await resolveDirectly(first.disputeId, admin.id)
    const second = await raiseDispute(testDb.db, {
      collabId: collab.id,
      userId: creator.user.id,
      kind: "exit",
      description: DESCRIPTION,
    })
    const list = await listCollabDisputes(testDb.db, collab.id)
    expect(list.map((item) => item.id)).toEqual([second.disputeId, first.disputeId])
    expect(list[1]).toMatchObject({
      outcome: "no_action",
      resolutionNote: "Settled in the messages.",
    })
  })
})

describe("notifyDisputeOpened", () => {
  it("notifies the other member and every active admin, once", async () => {
    const admin = await insertAdmin()
    const suspendedAdmin = await insertUser(testDb.db, { roles: ["admin"], status: "suspended" })
    const { collab, creator, builder } = await insertCollab(testDb.db, { stage: "building" })
    const { disputeId } = await raiseDispute(testDb.db, {
      collabId: collab.id,
      userId: creator.user.id,
      kind: "split",
      description: DESCRIPTION,
    })
    const first = await notifyDisputeOpened(testDb.db, disputeId)
    expect(first.members).toBe(1)
    expect(first.admins).toBeGreaterThanOrEqual(1)
    await notifyDisputeOpened(testDb.db, disputeId)

    const toBuilder = await testDb.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, builder.user.id))
    expect(toBuilder).toHaveLength(1)
    expect(toBuilder[0]).toMatchObject({
      type: "dispute.opened",
      payload: { dispute_id: disputeId, collab_id: collab.id, kind: "split" },
    })
    const toCreator = await testDb.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, creator.user.id))
    expect(toCreator).toHaveLength(0)
    const toAdmin = await testDb.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, admin.id))
    expect(toAdmin.map((row) => row.type)).toEqual(["admin.dispute_opened"])
    const toSuspended = await testDb.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, suspendedAdmin.id))
    expect(toSuspended).toHaveLength(0)
  })
})

describe("raiseDisputeAction", () => {
  it("lets a member raise one and refuses strangers", async () => {
    const { collab, creator } = await insertCollab(testDb.db, { stage: "live" })
    const stranger = await insertUser(testDb.db, { roles: ["builder"] })
    mocks.user = authUserOf(stranger)
    const refused = await raiseDisputeAction(
      form({ collabId: collab.id, kind: "split", description: DESCRIPTION }),
    )
    expect(refused.ok).toBe(false)

    mocks.user = authUserOf(creator.user)
    const short = await raiseDisputeAction(
      form({ collabId: collab.id, kind: "split", description: "bad" }),
    )
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.fieldErrors?.description?.[0]).toMatch(/at least 20/)
    const noKind = await raiseDisputeAction(form({ collabId: collab.id, description: DESCRIPTION }))
    expect(noKind.ok).toBe(false)
    if (!noKind.ok) expect(noKind.fieldErrors?.kind).toBeDefined()

    const ok = await raiseDisputeAction(
      form({ collabId: collab.id, kind: "split", description: `${DESCRIPTION}\r\nThanks.` }),
    )
    expect(ok.ok).toBe(true)
    const again = await raiseDisputeAction(
      form({ collabId: collab.id, kind: "split", description: DESCRIPTION }),
    )
    expect(again).toEqual({ ok: false, error: DISPUTE_MESSAGES.alreadyOpen })

    const [stored] = await testDb.db.select().from(disputes).where(eq(disputes.collabId, collab.id))
    expect(stored?.description).toBe(`${DESCRIPTION}\nThanks.`)
  })

  it("refuses a suspended member", async () => {
    const { collab, creator } = await insertCollab(testDb.db, { stage: "building" })
    const [suspended] = await testDb.db
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.id, creator.user.id))
      .returning()
    if (!suspended) throw new Error("no user")
    mocks.user = authUserOf(suspended)
    const result = await raiseDisputeAction(
      form({ collabId: collab.id, kind: "split", description: DESCRIPTION }),
    )
    expect(result.ok).toBe(false)
  })

  it("limits a member to 5 disputes a day", async () => {
    const admin = await insertAdmin()
    const { collab, creator } = await insertCollab(testDb.db, { stage: "building" })
    mocks.user = authUserOf(creator.user)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await raiseDisputeAction(
        form({ collabId: collab.id, kind: "other", description: DESCRIPTION }),
      )
      expect(result.ok).toBe(true)
      if (result.ok) await resolveDirectly(result.data.disputeId, admin.id)
    }
    const sixth = await raiseDisputeAction(
      form({ collabId: collab.id, kind: "other", description: DESCRIPTION }),
    )
    expect(sixth.ok).toBe(false)
    if (!sixth.ok) expect(sixth.error).toMatch(/several disputes today/)
  })
})
