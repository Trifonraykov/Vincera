import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import {
  creatorProfiles,
  events,
  notifications,
  stripeAccounts,
  stripeEvents,
} from "@/lib/db/schema"
import { payoutsStatusOf } from "@/lib/payouts/readiness"
import {
  createDashboardLink,
  createOnboardingLink,
  ensureConnectedAccount,
  PayoutsCountryRequiredError,
  PayoutsNotStartedError,
  refreshAccountFromStripe,
} from "@/lib/stripe/connect"
import {
  completeFakeOnboarding,
  createFakeStripeGateway,
  fakeAccountIdFor,
} from "@/lib/stripe/fake"
import {
  fakeConnectPageGet,
  fakeConnectPagePost,
  fakeDashboardPageGet,
  type FakeStripePageDeps,
} from "@/lib/stripe/fake-pages"
import { PAYOUTS_PAGES } from "@/lib/stripe/paths"
import { handleStripeWebhookRequest } from "@/lib/stripe/webhooks"

import { setupTestDatabase } from "../../helpers/db"
import { insertCreator, insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"

// Fake email (payouts.ready) goes to a temporary outbox; fake Stripe gets its own directory.
const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(dataRoot.dir, ...segments) }
})

const CONNECT_SECRET = "whsec_connect_test"
const NOW = new Date("2026-10-05T12:00:00.000Z")

const testDb = setupTestDatabase()

beforeEach(async () => {
  dataRoot.dir = await mkdtemp(path.join(tmpdir(), "stripe-connect-test-"))
  stubServiceEnv()
  setClockForTests(NOW)
})

afterEach(async () => {
  setClockForTests(null)
  await rm(dataRoot.dir, { recursive: true, force: true })
})

function fakeGateway() {
  return createFakeStripeGateway({
    root: path.join(dataRoot.dir, "fake-stripe"),
    appUrl: TEST_APP_URL,
  })
}

async function newUser() {
  const user = await insertUser(testDb.db)
  return { id: user.id, email: user.email }
}

async function rowOf(userId: string) {
  const [row] = await testDb.db
    .select()
    .from(stripeAccounts)
    .where(eq(stripeAccounts.userId, userId))
  return row ?? null
}

async function eventsAbout(subjectId: string, type: string) {
  return testDb.db
    .select()
    .from(events)
    .where(and(eq(events.subjectId, subjectId), eq(events.type, type)))
}

describe("ensureConnectedAccount", () => {
  it("creates the Stripe account and its row once", async () => {
    const gateway = fakeGateway()
    const user = await newUser()

    const first = await ensureConnectedAccount(testDb.db, user, { country: "ES" }, { gateway })
    expect(first.created).toBe(true)
    expect(first.account).toMatchObject({
      userId: user.id,
      stripeAccountId: fakeAccountIdFor(`acct:${user.id}`),
      payoutsEnabled: false,
      detailsSubmitted: false,
      transfersCapability: "inactive",
      country: "ES",
      disabledReason: "requirements.past_due",
      updatedFromStripeAt: NOW,
    })
    expect(first.account.requirementsCurrentlyDue).toContain("external_account")
    const created = await eventsAbout(first.account.id, "payouts.account_created")
    expect(created).toEqual([
      expect.objectContaining({ actorUserId: user.id, properties: { country: "ES" } }),
    ])

    const again = await ensureConnectedAccount(testDb.db, user, { country: "FR" }, { gateway })
    expect(again).toEqual({ account: first.account, created: false })
  })

  it("creates one account when called concurrently", async () => {
    const gateway = fakeGateway()
    const user = await newUser()
    const results = await Promise.all(
      [1, 2, 3].map(() => ensureConnectedAccount(testDb.db, user, { country: "ES" }, { gateway })),
    )
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.account.id)).size).toBe(1)
    const row = await rowOf(user.id)
    expect(await eventsAbout(row?.id ?? "", "payouts.account_created")).toHaveLength(1)
  })

  it("needs a country, defaulting to the creator profile's", async () => {
    const gateway = fakeGateway()
    const user = await newUser()
    await expect(ensureConnectedAccount(testDb.db, user, {}, { gateway })).rejects.toBeInstanceOf(
      PayoutsCountryRequiredError,
    )
    expect(await rowOf(user.id)).toBeNull()

    const { user: creator } = await insertCreator(testDb.db)
    await testDb.db
      .update(creatorProfiles)
      .set({ country: "PT" })
      .where(eq(creatorProfiles.userId, creator.id))
    const { account } = await ensureConnectedAccount(
      testDb.db,
      { id: creator.id, email: creator.email },
      {},
      { gateway },
    )
    expect(account.country).toBe("PT")
  })
})

describe("onboarding and dashboard links", () => {
  it("returns a fresh fake onboarding link with absolute return and refresh URLs", async () => {
    const gateway = fakeGateway()
    const user = await newUser()
    const url = await createOnboardingLink(
      testDb.db,
      user,
      { ...PAYOUTS_PAGES.onboarding, country: "ES" },
      { gateway },
    )
    const accountId = fakeAccountIdFor(`acct:${user.id}`)
    expect(url).toMatch(
      new RegExp(`^${TEST_APP_URL}/api/dev/fake-stripe/connect/${accountId}\\?link=link_`),
    )
    const response = await fakeConnectPageGet(new Request(url), accountId, pageDeps(gateway))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain("Complete onboarding")
    expect(html).toContain(accountId)
  })

  it("opens the Express dashboard only after the details were submitted", async () => {
    const gateway = fakeGateway()
    const user = await newUser()
    await expect(createDashboardLink(testDb.db, user, { gateway })).rejects.toBeInstanceOf(
      PayoutsNotStartedError,
    )
    const { account } = await ensureConnectedAccount(
      testDb.db,
      user,
      { country: "ES" },
      { gateway },
    )
    await expect(createDashboardLink(testDb.db, user, { gateway })).rejects.toThrow(
      /Finish setting up payouts/,
    )

    await completeFakeOnboarding(gateway.store, account.stripeAccountId, "pending_verification")
    await refreshAccountFromStripe(testDb.db, user.id, { gateway })
    expect(await createDashboardLink(testDb.db, user, { gateway })).toBe(
      `${TEST_APP_URL}/api/dev/fake-stripe/dashboard/${account.stripeAccountId}`,
    )
    const dashboard = await fakeDashboardPageGet(account.stripeAccountId, pageDeps(gateway))
    expect(dashboard.status).toBe(200)
    expect((await fakeDashboardPageGet("acct_fake_unknown", pageDeps(gateway))).status).toBe(404)
  })
})

describe("refreshAccountFromStripe", () => {
  it("returns null without an account", async () => {
    expect(
      await refreshAccountFromStripe(testDb.db, (await newUser()).id, { gateway: fakeGateway() }),
    ).toBeNull()
  })

  it("syncs what Stripe has now (the return page)", async () => {
    const gateway = fakeGateway()
    const user = await newUser()
    const { account } = await ensureConnectedAccount(
      testDb.db,
      user,
      { country: "ES" },
      { gateway },
    )

    await completeFakeOnboarding(gateway.store, account.stripeAccountId, "pending_verification")
    const verifying = await refreshAccountFromStripe(testDb.db, user.id, { gateway })
    expect(payoutsStatusOf(verifying)).toEqual({ kind: "verifying" })

    setClockForTests(new Date(NOW.getTime() + 60_000))
    await completeFakeOnboarding(gateway.store, account.stripeAccountId, "enabled")
    const ready = await refreshAccountFromStripe(testDb.db, user.id, { gateway })
    expect(payoutsStatusOf(ready)).toEqual({ kind: "ready", dueCount: 0 })
    expect(ready?.updatedFromStripeAt).toEqual(new Date(NOW.getTime() + 60_000))
    expect(await eventsAbout(account.id, "payouts.account_updated")).toHaveLength(2)
    expect(
      await testDb.db.select().from(notifications).where(eq(notifications.userId, user.id)),
    ).toHaveLength(1)
  })
})

function pageDeps(gateway: ReturnType<typeof fakeGateway>): FakeStripePageDeps {
  return {
    store: gateway.store,
    appName: "Vincera",
    webhookUrl: `${TEST_APP_URL}/api/webhooks/stripe`,
    webhookSecret: CONNECT_SECRET,
    appUrl: TEST_APP_URL,
    // "Over HTTP" to the real webhook handler, served by this test's database.
    fetch: async (input, init) =>
      handleStripeWebhookRequest(new Request(input, init), {
        db: testDb.db,
        secrets: ["whsec_platform_test", CONNECT_SECRET],
      }),
  }
}

function post(url: string, fields: Record<string, string>): Request {
  return new Request(url, { method: "POST", body: new URLSearchParams(fields) })
}

describe("fake Connect onboarding page", () => {
  async function startOnboarding() {
    const gateway = fakeGateway()
    const user = await newUser()
    const url = await createOnboardingLink(
      testDb.db,
      user,
      { ...PAYOUTS_PAGES.settings, country: "ES" },
      { gateway },
    )
    const accountId = fakeAccountIdFor(`acct:${user.id}`)
    const link = new URL(url).searchParams.get("link") ?? ""
    return { gateway, user, url, accountId, link }
  }

  it("completes onboarding through the real webhook and returns to the app", async () => {
    const { gateway, user, url, accountId, link } = await startOnboarding()

    const response = await fakeConnectPagePost(
      post(url, { link, outcome: "enabled" }),
      accountId,
      pageDeps(gateway),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${TEST_APP_URL}/app/settings/payouts?return=1`)

    // The webhook (not a re-fetch) updated the row.
    const row = await rowOf(user.id)
    expect(payoutsStatusOf(row)).toEqual({ kind: "ready", dueCount: 0 })
    const delivered = await testDb.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.account, accountId))
    expect(delivered).toEqual([
      expect.objectContaining({ type: "account.updated", processedAt: NOW }),
    ])
    expect(delivered[0]?.payload).toMatchObject({
      data: { previous_attributes: { payouts_enabled: false, details_submitted: false } },
    })

    // Links are single-use: opening it again goes to the refresh URL.
    const reopened = await fakeConnectPageGet(new Request(url), accountId, pageDeps(gateway))
    expect(reopened.status).toBe(303)
    expect(reopened.headers.get("location")).toBe(`${TEST_APP_URL}/app/settings/payouts/refresh`)
  })

  it("can end with verification pending", async () => {
    const { gateway, user, url, accountId, link } = await startOnboarding()
    await fakeConnectPagePost(
      post(url, { link, outcome: "pending_verification" }),
      accountId,
      pageDeps(gateway),
    )
    expect(payoutsStatusOf(await rowOf(user.id))).toEqual({ kind: "verifying" })
  })

  it("returns without changes when the user leaves", async () => {
    const { gateway, user, url, accountId, link } = await startOnboarding()
    const response = await fakeConnectPagePost(
      post(url, { link, outcome: "exit" }),
      accountId,
      pageDeps(gateway),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${TEST_APP_URL}/app/settings/payouts?return=1`)
    expect(payoutsStatusOf(await rowOf(user.id))).toMatchObject({ kind: "action_required" })
  })

  it("rejects unknown links and actions", async () => {
    const { gateway, url, accountId, link } = await startOnboarding()
    const unknown = await fakeConnectPageGet(
      new Request(`${TEST_APP_URL}/api/dev/fake-stripe/connect/${accountId}?link=link_nope`),
      accountId,
      pageDeps(gateway),
    )
    expect(unknown.status).toBe(404)
    const otherAccount = await fakeConnectPagePost(
      post(url, { link, outcome: "enabled" }),
      "acct_fake_someoneelse",
      pageDeps(gateway),
    )
    expect(otherAccount.status).toBe(404)
    const badAction = await fakeConnectPagePost(
      post(url, { link, outcome: "approve_everything" }),
      accountId,
      pageDeps(gateway),
    )
    expect(badAction.status).toBe(400)
  })

  it("still returns to the app when the webhook delivery fails", async () => {
    const { gateway, user, url, accountId, link } = await startOnboarding()
    const deps = { ...pageDeps(gateway), fetch: async () => new Response(null, { status: 500 }) }
    const response = await fakeConnectPagePost(
      post(url, { link, outcome: "enabled" }),
      accountId,
      deps,
    )
    expect(response.status).toBe(303)
    // The row is still pending; the return page's re-fetch fixes it.
    expect(payoutsStatusOf(await rowOf(user.id))).toMatchObject({ kind: "action_required" })
    const refreshed = await refreshAccountFromStripe(testDb.db, user.id, { gateway })
    expect(payoutsStatusOf(refreshed)).toEqual({ kind: "ready", dueCount: 0 })
  })
})
