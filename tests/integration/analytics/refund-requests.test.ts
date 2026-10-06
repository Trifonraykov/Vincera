import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import {
  accessGrants,
  adminAuditLog,
  events,
  notifications,
  orders,
  refundRequests,
  refunds,
  users,
} from "@/lib/db/schema"
import { listOutbox } from "@/lib/email/outbox"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import {
  approveRefundRequest,
  declineRefundRequest,
  loadBuyerRefundContext,
  notifyRefundRequested,
  submitRefundRequest,
} from "@/lib/refund-requests/service"
import { createFakeStripeGateway } from "@/lib/stripe/fake"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"
import { DAY_MS, PAID_AT, postedSale, type FakeGateway } from "../payouts/helpers"

/**
 * Buyer refund requests (`/access/[token]/refund`; CLAUDE.md §19.38): the window, one request per
 * order, revoked and disputed orders, the notices to buyer, members and admins, and the admin's
 * approval (through the real refund path against the fake gateway) or decline, with the rule
 * `canDecideRefundRequest` enforced by the actions.
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
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
  cookies: async () => ({ get: () => undefined }),
}))
const reportError = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability", () => ({ reportError }))

const { approveRefundRequestAction, declineRefundRequestAction, submitRefundRequestAction } =
  await import("@/lib/refund-requests/actions")

const testDb = setupTestDatabase()
let gateway: FakeGateway
let admin: typeof users.$inferSelect

function authUser(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email ?? "x@example.test",
    name: row.name,
    image: null,
    roles: row.roles,
    activeRole: row.activeRole,
    status: row.status,
    onboardingCompletedAt: row.onboardingCompletedAt,
  }
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "refund-requests-test-"))
  mocks.db = testDb.db
  admin = await insertUser(testDb.db, { roles: ["admin"], activeRole: "admin" })
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.user = null
  reportError.mockReset()
  stubServiceEnv()
  resetMemoryRateLimits()
  gateway = createFakeStripeGateway({
    root: path.join(mocks.dir, "fake-stripe"),
    appUrl: TEST_APP_URL,
  })
  setClockForTests(new Date(PAID_AT.getTime() + 3 * DAY_MS))
})
afterEach(async () => {
  setClockForTests(null)
  vi.unstubAllEnvs()
  await closeDb()
})

async function requestOf(orderId: string) {
  const [row] = await testDb.db
    .select()
    .from(refundRequests)
    .where(eq(refundRequests.orderId, orderId))
  return row ?? null
}

describe("asking for a refund", () => {
  it("records the request once, with its event, and tells buyer, members and admins", async () => {
    const sale = await postedSale(testDb.db, gateway, { ready: false })
    const token = sale.grant!.token
    const context = await loadBuyerRefundContext(testDb.db, token)
    expect(context).toMatchObject({ refusal: null, amountLeftCents: 1900, request: null })

    const result = await submitRefundRequestAction(
      token,
      null,
      form({ reason: "not_working", message: "It crashes on start.\r\n" }),
    )
    expect(result).toEqual({ ok: true, data: { submitted: true } })
    const request = await requestOf(sale.order.id)
    expect(request).toMatchObject({
      status: "pending",
      reason: "not_working",
      message: "It crashes on start.",
      amountCents: 1900,
      accessGrantId: sale.grant!.id,
    })
    const [event] = await testDb.db
      .select()
      .from(events)
      .where(and(eq(events.subjectId, request!.id), eq(events.type, "refund_request.created")))
    expect(event?.actorUserId).toBeNull()
    expect(event?.properties).toMatchObject({ days_after_purchase: 3, amount_cents: 1900 })
    expect(JSON.stringify(event?.properties)).not.toContain("@")

    const emails = await listOutbox()
    expect(emails.some((email) => email.to.includes(sale.order.buyerEmail))).toBe(true)
    for (const userId of [sale.creator.user.id, sale.builder.user.id]) {
      const rows = await testDb.db
        .select({ type: notifications.type })
        .from(notifications)
        .where(eq(notifications.userId, userId))
      expect(rows.map((row) => row.type)).toContain("refund.requested")
    }
    const adminRows = await testDb.db
      .select({ type: notifications.type })
      .from(notifications)
      .where(eq(notifications.userId, admin.id))
    expect(adminRows.map((row) => row.type)).toContain("admin.refund_requested")
    // Member and admin notices are deduplicated: running them again adds none.
    const count = async () => (await testDb.db.select().from(notifications)).length
    const before = await count()
    await notifyRefundRequested(testDb.db, request!.id)
    expect(await count()).toBe(before)

    // One request per order, ever.
    const again = await submitRefundRequestAction(token, null, form({ reason: "other" }))
    expect(again).toMatchObject({ ok: false })
    expect((await loadBuyerRefundContext(testDb.db, token))?.request?.status).toBe("pending")
  })

  it("refuses after the window, for revoked access, disputed orders, and bad input", async () => {
    const sale = await postedSale(testDb.db, gateway, { ready: false })
    const missing = await submitRefundRequestAction(sale.grant!.token, null, form({}))
    expect(missing).toMatchObject({ ok: false, fieldErrors: { reason: [expect.any(String)] } })

    setClockForTests(new Date(PAID_AT.getTime() + 15 * DAY_MS))
    expect(
      await submitRefundRequest(testDb.db, { token: sale.grant!.token, reason: "other" }),
    ).toEqual({ status: "refused", refusal: "window_closed" })

    setClockForTests(new Date(PAID_AT.getTime() + DAY_MS))
    await testDb.db.update(orders).set({ status: "disputed" }).where(eq(orders.id, sale.order.id))
    expect(
      await submitRefundRequest(testDb.db, { token: sale.grant!.token, reason: "other" }),
    ).toEqual({ status: "refused", refusal: "disputed" })

    const revoked = await postedSale(testDb.db, gateway, { ready: false })
    await testDb.db
      .update(accessGrants)
      .set({ revokedAt: PAID_AT })
      .where(eq(accessGrants.id, revoked.grant!.id))
    expect(
      await submitRefundRequest(testDb.db, { token: revoked.grant!.token, reason: "other" }),
    ).toEqual({ status: "refused", refusal: "revoked" })

    expect(
      await submitRefundRequest(testDb.db, { token: "x".repeat(43), reason: "other" }),
    ).toEqual({ status: "not_found" })
    expect(await loadBuyerRefundContext(testDb.db, "not-a-token")).toBeNull()
  })

  it("limits requests per token", async () => {
    const sale = await postedSale(testDb.db, gateway, { ready: false })
    const results = []
    for (let i = 0; i < 4; i += 1) {
      results.push(await submitRefundRequestAction(sale.grant!.token, null, form({})))
    }
    // Field errors are refused before the limit; valid submissions after a refusal count.
    const valid = []
    for (let i = 0; i < 4; i += 1) {
      valid.push(
        await submitRefundRequestAction(sale.grant!.token, null, form({ reason: "other" })),
      )
    }
    expect(valid[0]).toMatchObject({ ok: true })
    expect(valid.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/Too many/) })
    expect(results.every((result) => result?.ok === false)).toBe(true)
  })
})

describe("deciding a refund request", () => {
  it("approves through the refund path, once", async () => {
    const sale = await postedSale(testDb.db, gateway, { ready: false })
    const submitted = await submitRefundRequest(testDb.db, {
      token: sale.grant!.token,
      reason: "not_as_described",
    })
    if (submitted.status !== "created") throw new Error("not created")

    mocks.user = authUser(sale.creator.user)
    expect(await approveRefundRequestAction({ requestId: submitted.requestId })).toMatchObject({
      ok: false,
    })
    expect((await requestOf(sale.order.id))?.status).toBe("pending")

    const approved = await approveRefundRequest(
      testDb.db,
      { requestId: submitted.requestId, admin: authUser(admin), note: "Fair enough." },
      { gateway },
    )
    expect(approved.amountCents).toBe(1900)
    const request = await requestOf(sale.order.id)
    expect(request).toMatchObject({
      status: "approved",
      refundId: approved.refundId,
      decidedByUserId: admin.id,
      decisionNote: "Fair enough.",
    })
    const [refund] = await testDb.db.select().from(refunds).where(eq(refunds.id, approved.refundId))
    expect(refund).toMatchObject({
      status: "succeeded",
      amountCents: 1900,
      requestedByUserId: admin.id,
    })
    const [order] = await testDb.db.select().from(orders).where(eq(orders.id, sale.order.id))
    expect(order).toMatchObject({ status: "refunded", amountRefundedCents: 1900 })
    const audit = await testDb.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.targetId, submitted.requestId))
    expect(audit.map((row) => row.action)).toEqual(["refund_request.approved"])

    mocks.user = authUser(admin)
    expect(await approveRefundRequestAction({ requestId: submitted.requestId })).toMatchObject({
      ok: false,
      error: "This request was already decided.",
    })
    expect(
      await testDb.db.select().from(refunds).where(eq(refunds.orderId, sale.order.id)),
    ).toHaveLength(1)
  })

  it("declines with a note the buyer receives", async () => {
    const sale = await postedSale(testDb.db, gateway, { ready: false })
    const submitted = await submitRefundRequest(testDb.db, {
      token: sale.grant!.token,
      reason: "accidental",
    })
    if (submitted.status !== "created") throw new Error("not created")
    mocks.user = authUser(admin)
    expect(
      await declineRefundRequestAction({ requestId: submitted.requestId, note: "" }),
    ).toMatchObject({ ok: false, fieldErrors: { note: [expect.any(String)] } })
    expect(
      await declineRefundRequestAction({
        requestId: submitted.requestId,
        note: "The files were downloaded.",
      }),
    ).toEqual({ ok: true, data: { declined: true } })
    expect(await requestOf(sale.order.id)).toMatchObject({
      status: "declined",
      refundId: null,
      decisionNote: "The files were downloaded.",
    })
    const email = (await listOutbox()).find(
      (item) =>
        item.to.includes(sale.order.buyerEmail) && item.text.includes("files were downloaded"),
    )
    expect(email).toBeDefined()
    await expect(
      declineRefundRequest(testDb.db, {
        requestId: submitted.requestId,
        admin: authUser(admin),
        note: "Again",
      }),
    ).rejects.toThrow("already decided")
  })
})
