import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { events, stripeAccounts, users } from "@/lib/db/schema"
import {
  advanceOnboarding,
  completeOnboardingStep,
  OnboardingStepError,
} from "@/lib/onboarding/complete-step"
import { resolveOnboardingRedirect } from "@/lib/onboarding/gate"
import { loadOnboardingSnapshot } from "@/lib/onboarding/snapshot"

import { setupTestDatabase } from "../../helpers/db"
import {
  insertBuilder,
  insertCreator,
  insertPortfolioItem,
  insertSocialConnection,
  insertStripeAccount,
  insertUser,
} from "../../helpers/db-fixtures"

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeEach(() => setClockForTests(NOW))
afterEach(() => setClockForTests(null))

async function eventsOf(userId: string, type: string) {
  return testDb.db
    .select()
    .from(events)
    .where(and(eq(events.subjectId, userId), eq(events.type, type)))
}

async function userRow(userId: string) {
  const [row] = await testDb.db.select().from(users).where(eq(users.id, userId))
  if (!row) throw new Error("no user")
  return row
}

function asAuthUser(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email ?? "x@example.test",
    name: row.name,
    image: row.image,
    roles: row.roles,
    activeRole: row.activeRole,
    status: row.status,
    onboardingCompletedAt: row.onboardingCompletedAt,
  }
}

describe("loadOnboardingSnapshot", () => {
  it("returns null for an unknown user and defaults for a new one", async () => {
    expect(await loadOnboardingSnapshot(testDb.db, "0190a000-0000-7000-8000-00000000dead")).toBe(
      null,
    )
    const user = await insertUser(testDb.db)
    expect(await loadOnboardingSnapshot(testDb.db, user.id)).toEqual({
      roles: [],
      onboardingCompletedAt: null,
      steps: {},
      hasCreatorProfile: false,
      hasBuilderProfile: false,
      creatorConnectionCount: 0,
      githubConnectionCount: 0,
      portfolioItemCount: 0,
      payouts: "none",
    })
  })

  it("counts profiles, non-revoked connections per kind, portfolio items and payouts", async () => {
    const { user } = await insertCreator(testDb.db)
    const other = await insertBuilder(testDb.db)
    await insertSocialConnection(testDb.db, user.id, { provider: "youtube" })
    await insertSocialConnection(testDb.db, user.id, { provider: "tiktok", status: "expired" })
    await insertSocialConnection(testDb.db, user.id, { provider: "instagram", status: "revoked" })
    await insertSocialConnection(testDb.db, user.id, { provider: "github" })
    // Another user's rows never count.
    await insertSocialConnection(testDb.db, other.user.id, { provider: "github" })
    await insertPortfolioItem(testDb.db, other.profile.id)
    await insertStripeAccount(testDb.db, user.id, { payoutsEnabled: true })

    expect(await loadOnboardingSnapshot(testDb.db, user.id)).toMatchObject({
      roles: ["creator"],
      hasCreatorProfile: true,
      hasBuilderProfile: false,
      creatorConnectionCount: 2,
      githubConnectionCount: 1,
      portfolioItemCount: 0,
      // payouts_enabled without an active transfers capability is not ready.
      payouts: "pending",
    })
    expect(await loadOnboardingSnapshot(testDb.db, other.user.id)).toMatchObject({
      hasBuilderProfile: true,
      githubConnectionCount: 1,
      portfolioItemCount: 1,
      payouts: "none",
    })
  })

  it("reports payouts ready only with payouts enabled and an active transfers capability", async () => {
    const user = await insertUser(testDb.db, { roles: ["builder"] })
    await insertStripeAccount(testDb.db, user.id, {
      payoutsEnabled: true,
      transfersCapability: "active",
    })
    expect((await loadOnboardingSnapshot(testDb.db, user.id))?.payouts).toBe("ready")
  })

  it("drops malformed onboarding_steps entries", async () => {
    const user = await insertUser(testDb.db, {
      roles: ["creator"],
      onboardingSteps: {
        "creator.connect": { status: "skipped", at: "2026-10-01T00:00:00.000Z" },
        payouts: { status: "done", at: "not a date" },
      },
    })
    expect((await loadOnboardingSnapshot(testDb.db, user.id))?.steps).toEqual({
      "creator.connect": { status: "skipped", at: "2026-10-01T00:00:00.000Z" },
    })
  })
})

describe("completeOnboardingStep", () => {
  it("refuses to skip a step that can't be skipped, or a step off the user's path", async () => {
    const { user } = await insertCreator(testDb.db)
    await expect(
      completeOnboardingStep(testDb.db, {
        userId: user.id,
        step: "creator.review",
        status: "skipped",
      }),
    ).rejects.toThrow(OnboardingStepError)
    await expect(
      completeOnboardingStep(testDb.db, {
        userId: user.id,
        step: "builder.portfolio",
        status: "done",
      }),
    ).rejects.toThrow("This step isn't part of your onboarding.")
    expect((await userRow(user.id)).onboardingSteps).toEqual({})
  })

  it("records a step once, upgrades a skip to done, never downgrades, and keeps other keys", async () => {
    const { user } = await insertCreator(testDb.db)
    const first = await completeOnboardingStep(testDb.db, {
      userId: user.id,
      step: "creator.connect",
      status: "skipped",
    })
    expect(first).toEqual({
      recorded: true,
      nextStep: "/onboarding/creator/review",
      completedNow: false,
    })

    const again = await completeOnboardingStep(testDb.db, {
      userId: user.id,
      step: "creator.connect",
      status: "skipped",
    })
    expect(again.recorded).toBe(false)

    setClockForTests(new Date("2026-10-05T13:00:00.000Z"))
    expect(
      (
        await completeOnboardingStep(testDb.db, {
          userId: user.id,
          step: "creator.connect",
          status: "done",
        })
      ).recorded,
    ).toBe(true)
    expect(
      (
        await completeOnboardingStep(testDb.db, {
          userId: user.id,
          step: "creator.connect",
          status: "skipped",
        })
      ).recorded,
    ).toBe(false)

    expect((await userRow(user.id)).onboardingSteps).toEqual({
      "creator.connect": { status: "done", at: "2026-10-05T13:00:00.000Z" },
    })
    const stepEvents = await eventsOf(user.id, "onboarding.step_completed")
    expect(stepEvents.map((e) => e.properties)).toEqual([
      { step: "creator.connect", status: "skipped" },
      { step: "creator.connect", status: "done" },
    ])
    expect(stepEvents[0]).toMatchObject({ actorUserId: user.id, subjectType: "user" })
  })

  it("finishes onboarding exactly once when the last step is recorded", async () => {
    const { user } = await insertCreator(testDb.db)
    await completeOnboardingStep(testDb.db, {
      userId: user.id,
      step: "creator.connect",
      status: "skipped",
    })
    await completeOnboardingStep(testDb.db, {
      userId: user.id,
      step: "creator.review",
      status: "done",
    })
    const last = await completeOnboardingStep(testDb.db, {
      userId: user.id,
      step: "payouts",
      status: "skipped",
    })
    expect(last).toEqual({ recorded: true, nextStep: null, completedNow: true })
    expect((await userRow(user.id)).onboardingCompletedAt).toEqual(NOW)

    const completed = await eventsOf(user.id, "onboarding.completed")
    expect(completed).toHaveLength(1)
    expect(completed[0]?.properties).toEqual({
      roles: ["creator"],
      skipped_steps: ["creator.connect", "payouts"],
    })

    // Recording again (or advancing) changes nothing.
    setClockForTests(new Date("2026-10-06T00:00:00.000Z"))
    const repeat = await completeOnboardingStep(testDb.db, {
      userId: user.id,
      step: "payouts",
      status: "done",
    })
    expect(repeat).toEqual({ recorded: true, nextStep: null, completedNow: false })
    expect(await advanceOnboarding(testDb.db, user.id)).toEqual({
      nextStep: null,
      completedNow: false,
    })
    expect((await userRow(user.id)).onboardingCompletedAt).toEqual(NOW)
    expect(await eventsOf(user.id, "onboarding.completed")).toHaveLength(1)
  })

  it("walks a finished user through the steps of a role added later", async () => {
    const { user, profile } = await insertBuilder(testDb.db)
    await insertPortfolioItem(testDb.db, profile.id)
    await completeOnboardingStep(testDb.db, { userId: user.id, step: "payouts", status: "skipped" })
    expect((await userRow(user.id)).onboardingCompletedAt).toEqual(NOW)

    await testDb.db
      .update(users)
      .set({ roles: ["creator", "builder"] })
      .where(eq(users.id, user.id))
    expect(await advanceOnboarding(testDb.db, user.id)).toEqual({
      nextStep: "/onboarding/creator/profile",
      completedNow: false,
    })
  })
})

describe("resolveOnboardingRedirect (the /app gate)", () => {
  it("sends users without an app role to the role step", async () => {
    const user = await insertUser(testDb.db, { roles: ["admin"] })
    expect(await resolveOnboardingRedirect(asAuthUser(user), testDb.db)).toBe("/onboarding/role")
  })

  it("sends unfinished users to their next step", async () => {
    const { user } = await insertBuilder(testDb.db)
    expect(await resolveOnboardingRedirect(asAuthUser(user), testDb.db)).toBe(
      "/onboarding/builder/portfolio",
    )
  })

  it("lets finished users in without looking at their steps", async () => {
    const user = await insertUser(testDb.db, { roles: ["builder"], onboardingCompletedAt: NOW })
    expect(await resolveOnboardingRedirect(asAuthUser(user), testDb.db)).toBeNull()
  })

  it("finishes a path completed by facts alone (payouts became ready) on the next visit", async () => {
    const { user, profile } = await insertBuilder(testDb.db)
    await insertPortfolioItem(testDb.db, profile.id)
    const account = await insertStripeAccount(testDb.db, user.id)
    expect(await resolveOnboardingRedirect(asAuthUser(user), testDb.db)).toBe("/onboarding/payouts")

    // e.g. the account.updated webhook after the user left the payouts page.
    await testDb.db
      .update(stripeAccounts)
      .set({ payoutsEnabled: true, transfersCapability: "active" })
      .where(eq(stripeAccounts.id, account.id))

    expect(await resolveOnboardingRedirect(asAuthUser(user), testDb.db)).toBeNull()
    expect((await userRow(user.id)).onboardingCompletedAt).toEqual(NOW)
    expect((await eventsOf(user.id, "onboarding.completed"))[0]?.properties).toEqual({
      roles: ["builder"],
      skipped_steps: [],
    })
  })
})
