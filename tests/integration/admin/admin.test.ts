import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import {
  cancelStuckRefundAction,
  grantAdminAction,
  resolveDisputeAction,
  reviewDisputeAction,
  revokeAdminAction,
  startImpersonationAction,
  startPayoutRunAction,
  stopImpersonation,
  suspendUserAction,
  unsuspendUserAction,
} from "@/lib/admin/actions"
import { resolveDispute } from "@/lib/admin/disputes"
import { validateAdjustmentLines } from "@/lib/admin/ledger-adjustments"
import { retryStuckRefund } from "@/lib/admin/payouts"
import { ACTION_MESSAGES } from "@/lib/actions/result"
import { IMPERSONATION_COOKIE, IMPERSONATION_READ_ONLY_MESSAGE } from "@/lib/auth/impersonation"
import { verifyImpersonationCookie } from "@/lib/auth/impersonation-cookie"
import { parseAuthUser, type AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb, type Db } from "@/lib/db/client"
import {
  adminAuditLog,
  mobileSessions,
  collabs,
  disputes,
  events,
  ideas,
  impersonationSessions,
  launches,
  ledgerAdjustments,
  ledgerEntries,
  notifications,
  payoutBatches,
  refunds,
  sessions,
  users,
} from "@/lib/db/schema"
import { createMobileSession, findMobileSessionUser } from "@/lib/mobile-api/sessions"
import { resetEnvCache } from "@/lib/env"
import { checkLedger } from "@/lib/ledger/check"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { createFakeStripeGateway } from "@/lib/stripe/fake"

import { setupTestDatabase } from "../../helpers/db"
import { insertCollab, insertDispute, insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"
import { PAID_AT, postedSale, type FakeGateway } from "../payouts/helpers"

/**
 * The admin area against Postgres (Phase 6; CLAUDE.md §19.38–§19.39): every admin action is
 * audited (before/after) in its own transaction, non-admins are refused, suspension deletes the
 * user's sessions, read-only "view as" refuses every mutation and is audited, disputes go
 * open → in_review → resolved with an adjustment that keeps `ledger:check` clean.
 */

const mocks = vi.hoisted(() => ({
  dir: "",
  db: null as unknown,
  user: null as AuthUser | null,
  realUser: null as AuthUser | null,
  cookies: new Map<string, string>(),
}))
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
  getRealUser: async () => mocks.realUser ?? mocks.user,
}))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mocks.cookies.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: (name: string, value: string) => {
      mocks.cookies.set(name, value)
    },
    delete: (name: string) => {
      mocks.cookies.delete(name)
    },
  }),
  headers: async () => new Headers(),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
const reportError = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability", () => ({ reportError }))

const testDb = setupTestDatabase()
const NOW = new Date(PAID_AT.getTime() + 2 * 24 * 60 * 60 * 1000)
let gateway: FakeGateway

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "admin-test-"))
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.user = null
  mocks.realUser = null
  mocks.cookies.clear()
  reportError.mockReset()
  resetMemoryRateLimits()
  stubServiceEnv()
  gateway = createFakeStripeGateway({
    root: path.join(mocks.dir, "fake-stripe"),
    appUrl: TEST_APP_URL,
  })
  setClockForTests(NOW)
})
afterEach(async () => {
  setClockForTests(null)
  vi.unstubAllEnvs()
  resetEnvCache()
  await closeDb()
})

function auth(row: typeof users.$inferSelect): AuthUser {
  const parsed = parseAuthUser(row)
  if (!parsed) throw new Error("user did not parse")
  return parsed
}

async function newAdmin(): Promise<AuthUser> {
  return auth(await insertUser(testDb.db, { roles: ["admin"], onboardingCompletedAt: NOW }))
}

async function newCreator(): Promise<AuthUser> {
  return auth(
    await insertUser(testDb.db, {
      roles: ["creator"],
      activeRole: "creator",
      onboardingCompletedAt: NOW,
    }),
  )
}

async function auditOf(targetId: string) {
  return testDb.db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.targetId, targetId))
    .orderBy(adminAuditLog.createdAt)
}

async function eventTypes(subjectId: string): Promise<string[]> {
  const rows = await testDb.db
    .select({ type: events.type })
    .from(events)
    .where(eq(events.subjectId, subjectId))
  return rows.map((row) => row.type)
}

async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2] ?? ""
    }
    throw error
  }
  throw new Error("expected a redirect")
}

describe("users", () => {
  it("refuses non-admins and writes nothing", async () => {
    const target = await newCreator()
    mocks.user = await newCreator()
    for (const action of [suspendUserAction, grantAdminAction, unsuspendUserAction]) {
      const result = await action({ userId: target.id })
      expect(result).toEqual({ ok: false, error: ACTION_MESSAGES.forbidden })
    }
    expect(await auditOf(target.id)).toEqual([])
  })

  it("suspends (deleting every session) and lifts the suspension, audited", async () => {
    const admin = await newAdmin()
    const target = await newCreator()
    const future = new Date(NOW.getTime() + 86_400_000)
    await testDb.db.insert(sessions).values([
      { sessionToken: `a-${target.id}`, userId: target.id, expires: future },
      { sessionToken: `b-${target.id}`, userId: target.id, expires: future },
    ])
    // The iPhone app's bearer session is signed out too (CLAUDE.md §19.44).
    const phone = await createMobileSession(testDb.db, { userId: target.id, deviceName: "iPhone" })
    mocks.user = admin

    const result = await suspendUserAction({ userId: target.id })
    expect(result).toEqual({ ok: true, data: { sessionsDeleted: 3 } })
    expect(await findMobileSessionUser(testDb.db, phone.token)).toBeNull()
    expect(
      await testDb.db.select().from(mobileSessions).where(eq(mobileSessions.userId, target.id)),
    ).toEqual([])
    const [row] = await testDb.db.select().from(users).where(eq(users.id, target.id))
    expect(row?.status).toBe("suspended")
    expect(await testDb.db.select().from(sessions).where(eq(sessions.userId, target.id))).toEqual(
      [],
    )

    expect(await unsuspendUserAction({ userId: target.id })).toMatchObject({ ok: true })
    const audit = await auditOf(target.id)
    expect(audit.map((entry) => [entry.action, entry.adminUserId])).toEqual([
      ["user.suspended", admin.id],
      ["user.unsuspended", admin.id],
    ])
    expect(audit[0]?.before).toEqual({ status: "active" })
    expect(audit[0]?.after).toEqual({ status: "suspended", sessions_deleted: 3 })
    expect(await eventTypes(target.id)).toEqual(
      expect.arrayContaining(["user.suspended", "user.unsuspended"]),
    )
  })

  it("never suspends yourself or another admin", async () => {
    const admin = await newAdmin()
    const other = await newAdmin()
    mocks.user = admin
    expect(await suspendUserAction({ userId: admin.id })).toMatchObject({ ok: false })
    expect(await suspendUserAction({ userId: other.id })).toMatchObject({ ok: false })
  })

  it("grants and revokes the admin role, audited", async () => {
    const admin = await newAdmin()
    const target = await newCreator()
    mocks.user = admin
    expect(await grantAdminAction({ userId: target.id })).toEqual({
      ok: true,
      data: { granted: true },
    })
    let [row] = await testDb.db.select().from(users).where(eq(users.id, target.id))
    expect(row?.roles).toEqual(expect.arrayContaining(["creator", "admin"]))

    expect(await revokeAdminAction({ userId: target.id })).toEqual({
      ok: true,
      data: { revoked: true },
    })
    ;[row] = await testDb.db.select().from(users).where(eq(users.id, target.id))
    expect(row?.roles).toEqual(["creator"])
    expect(row?.activeRole).toBe("creator")
    const audit = await auditOf(target.id)
    expect(audit.map((entry) => entry.action)).toEqual(["user.role_granted", "user.role_revoked"])
    expect(audit.every((entry) => entry.adminUserId === admin.id)).toBe(true)
    expect(await eventTypes(target.id)).toEqual(
      expect.arrayContaining(["user.role_added", "user.role_removed"]),
    )
    // Never from yourself.
    expect(await revokeAdminAction({ userId: admin.id })).toEqual({
      ok: false,
      error: ACTION_MESSAGES.forbidden,
    })
  })
})

describe("read-only impersonation", () => {
  it("starts (audited, signed cookie), refuses every mutation, and stops (audited)", async () => {
    const admin = await newAdmin()
    const target = await newCreator()
    const bystander = await newCreator()
    mocks.user = admin

    const to = await redirectTarget(
      startImpersonationAction({ userId: target.id, reason: "Support request #12" }),
    )
    expect(to).toBe("/app")
    const [session] = await testDb.db
      .select()
      .from(impersonationSessions)
      .where(eq(impersonationSessions.adminUserId, admin.id))
    expect(session).toMatchObject({ targetUserId: target.id, endedAt: null })
    const claim = verifyImpersonationCookie(
      mocks.cookies.get(IMPERSONATION_COOKIE),
      process.env.AUTH_SECRET ?? "",
      NOW,
    )
    expect(claim).toMatchObject({ adminUserId: admin.id, targetUserId: target.id })
    const started = await auditOf(session?.id ?? "")
    expect(started[0]).toMatchObject({
      action: "impersonation.started",
      after: expect.objectContaining({ target_user_id: target.id, reason: "Support request #12" }),
    })

    // While viewing: the request's user is the target, and every action is refused before
    // its rule runs, admin actions included.
    mocks.user = target
    mocks.realUser = admin
    expect(await suspendUserAction({ userId: bystander.id })).toEqual({
      ok: false,
      error: IMPERSONATION_READ_ONLY_MESSAGE,
    })
    expect(await startPayoutRunAction({})).toEqual({
      ok: false,
      error: IMPERSONATION_READ_ONLY_MESSAGE,
    })
    const [still] = await testDb.db.select().from(users).where(eq(users.id, bystander.id))
    expect(still?.status).toBe("active")

    // "Stop viewing" works during the view (a plain server action on the real user).
    expect(await redirectTarget(stopImpersonation())).toBe(`/admin/users/${target.id}`)
    expect(mocks.cookies.has(IMPERSONATION_COOKIE)).toBe(false)
    const [ended] = await testDb.db
      .select()
      .from(impersonationSessions)
      .where(eq(impersonationSessions.id, session?.id ?? ""))
    expect(ended).toMatchObject({ endReason: "stopped" })
    expect((await auditOf(session?.id ?? "")).map((entry) => entry.action)).toEqual([
      "impersonation.started",
      "impersonation.stopped",
    ])
  })

  it("replaces an open session and never views an admin", async () => {
    const admin = await newAdmin()
    const first = await newCreator()
    const second = await newCreator()
    const otherAdmin = await newAdmin()
    mocks.user = admin
    await redirectTarget(startImpersonationAction({ userId: first.id, reason: "Check payouts" }))
    mocks.cookies.clear()
    await redirectTarget(startImpersonationAction({ userId: second.id, reason: "Check payouts" }))
    const rows = await testDb.db
      .select()
      .from(impersonationSessions)
      .where(eq(impersonationSessions.adminUserId, admin.id))
    expect(rows.map((row) => [row.targetUserId, row.endReason])).toEqual(
      expect.arrayContaining([
        [first.id, "replaced"],
        [second.id, null],
      ]),
    )
    mocks.cookies.clear()
    expect(
      await startImpersonationAction({ userId: otherAdmin.id, reason: "Curious" }),
    ).toMatchObject({ ok: false })
    // A reason with an email address is refused before anything is written (audit-log rule).
    const refused = await startImpersonationAction({
      userId: first.id,
      reason: "Asked by someone@example.com",
    })
    expect(refused).toMatchObject({ ok: false, fieldErrors: { reason: [expect.any(String)] } })
  })
})

describe("disputes", () => {
  async function disputeOnSale() {
    const sale = await postedSale(testDb.db as Db, gateway)
    const dispute = await insertDispute(testDb.db, sale.collab.id, sale.creator.user.id)
    return { sale, dispute }
  }

  it("goes open → in_review → resolved with an audited adjustment; ledger:check stays clean", async () => {
    const admin = await newAdmin()
    const { sale, dispute } = await disputeOnSale()
    const creatorId = sale.creator.user.id
    const builderId = sale.builder.user.id
    mocks.user = admin

    // Resolving needs the review first.
    expect(
      await resolveDisputeAction({ disputeId: dispute.id, outcome: "no_action", note: "Fine." }),
    ).toMatchObject({ ok: false })

    expect(await reviewDisputeAction({ disputeId: dispute.id })).toMatchObject({ ok: true })
    const [inReview] = await testDb.db.select().from(disputes).where(eq(disputes.id, dispute.id))
    expect(inReview).toMatchObject({ status: "in_review", inReviewByUserId: admin.id })
    for (const userId of [creatorId, builderId]) {
      const rows = await testDb.db
        .select({ type: notifications.type })
        .from(notifications)
        .where(eq(notifications.userId, userId))
      expect(rows.map((row) => row.type)).toContain("dispute.in_review")
    }

    // Unbalanced lines are refused; nothing is written.
    const unbalanced = await resolveDisputeAction({
      disputeId: dispute.id,
      outcome: "adjusted",
      note: "Moving €5 to the builder.",
      adjustment: {
        orderId: sale.order.id,
        reason: "Builder did the extra work",
        lines: [
          { party: creatorId, amount: "-5" },
          { party: builderId, amount: "4" },
        ],
      },
    })
    expect(unbalanced).toMatchObject({ ok: false })
    expect(await testDb.db.select().from(ledgerAdjustments)).toEqual([])

    const result = await resolveDisputeAction({
      disputeId: dispute.id,
      outcome: "adjusted",
      note: "Moving €5 to the builder.",
      adjustment: {
        orderId: sale.order.id,
        reason: "Builder did the extra work",
        lines: [
          { party: creatorId, amount: "-5" },
          { party: builderId, amount: "5,00" },
        ],
      },
    })
    expect(result).toMatchObject({ ok: true })
    const [adjustment] = await testDb.db
      .select()
      .from(ledgerAdjustments)
      .where(eq(ledgerAdjustments.disputeId, dispute.id))
    expect(adjustment).toMatchObject({ adminUserId: admin.id, orderId: sale.order.id })
    const entries = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.adjustmentId, adjustment?.id ?? ""))
    expect(entries.map((entry) => [entry.userId, entry.amountCents, entry.account])).toEqual(
      expect.arrayContaining([
        [creatorId, -500, "adjustment"],
        [builderId, 500, "adjustment"],
      ]),
    )

    const [resolved] = await testDb.db.select().from(disputes).where(eq(disputes.id, dispute.id))
    expect(resolved).toMatchObject({
      status: "resolved",
      outcome: "adjusted",
      resolvedBy: admin.id,
      resolutionNote: "Moving €5 to the builder.",
    })
    expect((await auditOf(dispute.id)).map((entry) => entry.action)).toEqual([
      "dispute.in_review",
      "dispute.resolved",
    ])
    expect((await auditOf(adjustment?.id ?? ""))[0]).toMatchObject({
      action: "ledger.adjusted",
      after: expect.objectContaining({
        lines: [
          { user_id: creatorId, amount_cents: -500 },
          { user_id: builderId, amount_cents: 500 },
        ],
      }),
    })
    expect(await eventTypes(dispute.id)).toEqual(
      expect.arrayContaining(["dispute.in_review", "dispute.resolved"]),
    )
    expect(await eventTypes(adjustment?.id ?? "")).toEqual(["ledger.adjusted"])

    const report = await checkLedger(testDb.db, { at: NOW })
    expect(report.mismatches).toEqual([])
  })

  it("refuses lines for people outside the collab", async () => {
    const admin = await newAdmin()
    const stranger = await newCreator()
    const { sale, dispute } = await disputeOnSale()
    await testDb.db
      .update(disputes)
      .set({ status: "in_review", inReviewAt: NOW, inReviewByUserId: admin.id })
      .where(eq(disputes.id, dispute.id))
    await expect(
      resolveDispute(testDb.db, admin, {
        disputeId: dispute.id,
        outcome: "adjusted",
        note: "No.",
        adjustment: {
          reason: "Test",
          lines: [
            { userId: sale.creator.user.id, amountCents: -100 },
            { userId: stranger.id, amountCents: 100 },
          ],
        },
      }),
    ).rejects.toThrow(/members of this collab/)
    const [still] = await testDb.db.select().from(disputes).where(eq(disputes.id, dispute.id))
    expect(still?.status).toBe("in_review")
  })

  it("ends the collab and its live launch with `collab_ended`", async () => {
    const admin = await newAdmin()
    const { sale, dispute } = await disputeOnSale()
    await testDb.db
      .update(disputes)
      .set({ status: "in_review", inReviewAt: NOW, inReviewByUserId: admin.id })
      .where(eq(disputes.id, dispute.id))
    const result = await resolveDispute(testDb.db, admin, {
      disputeId: dispute.id,
      outcome: "collab_ended",
      note: "The collab ends here.",
    })
    expect(result.launchEnded).toBe(true)
    const [collab] = await testDb.db.select().from(collabs).where(eq(collabs.id, sale.collab.id))
    expect(collab).toMatchObject({ stage: "ended", endedReason: "dispute" })
    const [launch] = await testDb.db.select().from(launches).where(eq(launches.id, sale.launch.id))
    expect(launch?.status).toBe("ended")
    expect(await eventTypes(sale.launch.id)).toContain("launch.ended")
  })

  it("puts an idea that never launched back on offer", async () => {
    const admin = await newAdmin()
    const { collab, idea, creator } = await insertCollab(testDb.db, { stage: "building" })
    const dispute = await insertDispute(testDb.db, collab.id, creator.user.id, {
      status: "in_review",
      inReviewAt: NOW,
      inReviewByUserId: admin.id,
    })
    await testDb.db
      .update(ideas)
      .set({ publishedAt: NOW })
      .where(and(eq(ideas.id, idea.id)))
    await resolveDispute(testDb.db, admin, {
      disputeId: dispute.id,
      outcome: "collab_ended",
      note: "Ending it.",
    })
    const [row] = await testDb.db.select().from(ideas).where(eq(ideas.id, idea.id))
    expect(row?.status).toBe("open")
  })
})

describe("ledger adjustments", () => {
  it("validates lines: two or more, non-zero cents, each party once, sum zero", () => {
    expect(validateAdjustmentLines([{ userId: null, amountCents: 0 }])).not.toBeNull()
    expect(
      validateAdjustmentLines([
        { userId: "a", amountCents: 100 },
        { userId: "a", amountCents: -100 },
      ]),
    ).not.toBeNull()
    expect(
      validateAdjustmentLines([
        { userId: "a", amountCents: 100 },
        { userId: null, amountCents: -100 },
      ]),
    ).toBeNull()
  })

  it("ledger:check flags an adjustment whose entries do not sum to zero", async () => {
    const admin = await newAdmin()
    const [adjustment] = await testDb.db
      .insert(ledgerAdjustments)
      .values({ adminUserId: admin.id, reason: "Broken by hand" })
      .returning()
    await testDb.db.insert(ledgerEntries).values({
      userId: admin.id,
      account: "adjustment",
      amountCents: 100,
      availableAt: NOW,
      adjustmentId: adjustment?.id,
    })
    const report = await checkLedger(testDb.db, { at: NOW })
    expect(report.mismatches).toContainEqual(
      expect.objectContaining({ kind: "adjustment_sum", adjustmentId: adjustment?.id }),
    )
  })
})

describe("payouts", () => {
  it("starts a manual payout run, audited", async () => {
    const admin = await newAdmin()
    mocks.user = admin
    const result = await startPayoutRunAction({})
    expect(result.ok).toBe(true)
    const runKey = result.ok ? result.data.runKey : ""
    expect(runKey).toMatch(/^manual:/)
    const audit = await testDb.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, "payouts.run_started"))
    expect(audit.some((entry) => (entry.after as { run_key?: string })?.run_key === runKey)).toBe(
      true,
    )
    const batches = await testDb.db
      .select()
      .from(payoutBatches)
      .where(eq(payoutBatches.runKey, runKey))
    expect(batches).toHaveLength(1)
  })

  it("cancels or retries a stuck refund", async () => {
    const admin = await newAdmin()
    const sale = await postedSale(testDb.db as Db, gateway)
    const old = new Date(NOW.getTime() - 60 * 60 * 1000)
    const [stuck] = await testDb.db
      .insert(refunds)
      .values({
        orderId: sale.order.id,
        amountCents: 300,
        currency: "eur",
        requestedByUserId: admin.id,
        createdAt: old,
      })
      .returning()
    mocks.user = admin
    expect(await cancelStuckRefundAction({ refundId: stuck?.id ?? "" })).toMatchObject({
      ok: true,
    })
    const [canceled] = await testDb.db
      .select()
      .from(refunds)
      .where(eq(refunds.id, stuck?.id ?? ""))
    expect(canceled?.status).toBe("canceled")
    expect((await auditOf(stuck?.id ?? ""))[0]?.action).toBe("refund.canceled")

    const [again] = await testDb.db
      .insert(refunds)
      .values({
        orderId: sale.order.id,
        amountCents: 300,
        currency: "eur",
        requestedByUserId: admin.id,
        createdAt: old,
      })
      .returning()
    const retried = await retryStuckRefund(
      testDb.db,
      admin,
      { refundId: again?.id ?? "" },
      { gateway },
    )
    expect(retried.status).toBe("applied")
    const [done] = await testDb.db
      .select()
      .from(refunds)
      .where(eq(refunds.id, again?.id ?? ""))
    expect(done?.status).toBe("succeeded")
    expect(done?.stripeRefundId).toMatch(/^re_fake_/)
    expect((await auditOf(again?.id ?? ""))[0]?.action).toBe("refund.requested")
  })
})
