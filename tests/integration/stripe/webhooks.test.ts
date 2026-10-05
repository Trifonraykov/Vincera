import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import Stripe from "stripe"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { events, notifications, stripeAccounts, stripeEvents, users } from "@/lib/db/schema"
import { listOutbox } from "@/lib/email/outbox"
import * as connect from "@/lib/stripe/connect"
import { handleStripeWebhookRequest } from "@/lib/stripe/webhooks"

import accountUpdatedFixture from "../../fixtures/stripe/account.updated.json"
import capabilityUpdatedFixture from "../../fixtures/stripe/capability.updated.json"
import checkoutCompletedFixture from "../../fixtures/stripe/checkout.session.completed.json"
import { setupTestDatabase } from "../../helpers/db"
import {
  insertBuilder,
  insertPortfolioItem,
  insertStripeAccount,
  insertUser,
} from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"

// The fake email transport (payouts.ready email) writes to a temporary outbox.
const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(dataRoot.dir, ...segments) }
})

const PLATFORM_SECRET = "whsec_platform_test"
const CONNECT_SECRET = "whsec_connect_test"
const SECRETS = [PLATFORM_SECRET, CONNECT_SECRET]
const NOW = new Date("2026-10-05T12:00:00.000Z")
const FIXTURE_CREATED = new Date(accountUpdatedFixture.created * 1000)

const testDb = setupTestDatabase()

beforeEach(async () => {
  dataRoot.dir = await mkdtemp(path.join(tmpdir(), "stripe-webhooks-test-"))
  stubServiceEnv()
  setClockForTests(NOW)
})

afterEach(async () => {
  setClockForTests(null)
  await rm(dataRoot.dir, { recursive: true, force: true })
})

let counter = 0
function uniqueId(prefix: string): string {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter}`
}

type Fixture = typeof accountUpdatedFixture

/** The account.updated fixture for `stripeAccountId`, with a fresh event id. */
function accountUpdated(
  stripeAccountId: string,
  overrides: { object?: Record<string, unknown>; created?: number; id?: string } = {},
) {
  const fixture: Fixture = structuredClone(accountUpdatedFixture)
  return {
    ...fixture,
    id: overrides.id ?? uniqueId("evt_test_"),
    account: stripeAccountId,
    created: overrides.created ?? fixture.created,
    data: {
      ...fixture.data,
      object: { ...fixture.data.object, id: stripeAccountId, ...overrides.object },
    },
  }
}

function signedRequest(event: unknown, secret = CONNECT_SECRET, signature?: string): Request {
  const payload = JSON.stringify(event)
  return new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature":
        signature ?? Stripe.webhooks.generateTestHeaderString({ payload, secret }),
    },
    body: payload,
  })
}

async function deliver(event: unknown, secret = CONNECT_SECRET) {
  const response = await handleStripeWebhookRequest(signedRequest(event, secret), {
    db: testDb.db,
    secrets: SECRETS,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function stripeEventRow(id: string) {
  const [row] = await testDb.db.select().from(stripeEvents).where(eq(stripeEvents.id, id))
  return row ?? null
}

async function accountRow(stripeAccountId: string) {
  const [row] = await testDb.db
    .select()
    .from(stripeAccounts)
    .where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
  if (!row) throw new Error("no stripe_accounts row")
  return row
}

async function eventsAbout(subjectId: string, type: string) {
  return testDb.db
    .select()
    .from(events)
    .where(and(eq(events.subjectId, subjectId), eq(events.type, type)))
}

/** A builder whose only missing onboarding step is payouts, with a Stripe account row. */
async function builderAwaitingPayouts() {
  const { user, profile } = await insertBuilder(testDb.db)
  await insertPortfolioItem(testDb.db, profile.id)
  const account = await insertStripeAccount(testDb.db, user.id, {
    stripeAccountId: uniqueId("acct_test_"),
    transfersCapability: "inactive",
    requirementsCurrentlyDue: ["external_account"],
    disabledReason: "requirements.past_due",
    country: "ES",
  })
  return { user, account }
}

describe("POST /api/webhooks/stripe: verification", () => {
  it("accepts events signed with the platform secret", async () => {
    const event = { ...structuredClone(checkoutCompletedFixture), id: uniqueId("evt_test_") }
    const result = await deliver(event, PLATFORM_SECRET)
    expect(result).toEqual({ status: 200, body: { received: true, status: "ignored" } })
  })

  it("accepts events signed with the Connect secret", async () => {
    const { account } = await builderAwaitingPayouts()
    const result = await deliver(accountUpdated(account.stripeAccountId), CONNECT_SECRET)
    expect(result).toEqual({ status: 200, body: { received: true, status: "processed" } })
  })

  it("rejects a bad or missing signature with 400 and records nothing", async () => {
    const event = accountUpdated("acct_test_badsig")
    const wrongSecret = await handleStripeWebhookRequest(signedRequest(event, "whsec_other"), {
      db: testDb.db,
      secrets: SECRETS,
    })
    expect(wrongSecret.status).toBe(400)
    expect(await wrongSecret.json()).toEqual({ received: false, error: "invalid_signature" })

    // Signed for one body, delivered with another.
    const tampered = signedRequest(
      { ...event, type: "account.application.deauthorized" },
      CONNECT_SECRET,
      Stripe.webhooks.generateTestHeaderString({
        payload: JSON.stringify(event),
        secret: CONNECT_SECRET,
      }),
    )
    const tamperedResponse = await handleStripeWebhookRequest(tampered, {
      db: testDb.db,
      secrets: SECRETS,
    })
    expect(tamperedResponse.status).toBe(400)

    const unsigned = new Request("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      body: JSON.stringify(event),
    })
    const missing = await handleStripeWebhookRequest(unsigned, { db: testDb.db, secrets: SECRETS })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ received: false, error: "missing_signature" })

    expect(await stripeEventRow(event.id)).toBeNull()
  })

  it("rejects an old signature (replay outside Stripe's tolerance)", async () => {
    const event = accountUpdated("acct_test_replay")
    const payload = JSON.stringify(event)
    const old = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: CONNECT_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    })
    const response = await handleStripeWebhookRequest(signedRequest(event, CONNECT_SECRET, old), {
      db: testDb.db,
      secrets: SECRETS,
    })
    expect(response.status).toBe(400)
  })

  it("rejects a validly signed body that is not a Stripe event", async () => {
    const response = await handleStripeWebhookRequest(
      signedRequest({ hello: "world" }, CONNECT_SECRET),
      { db: testDb.db, secrets: SECRETS },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ received: false, error: "invalid_payload" })
  })
})

describe("POST /api/webhooks/stripe: processing", () => {
  it("applies account.updated to stripe_accounts, finishes onboarding and notifies once", async () => {
    const { user, account } = await builderAwaitingPayouts()
    const event = accountUpdated(account.stripeAccountId)

    expect((await deliver(event)).body).toEqual({ received: true, status: "processed" })

    const row = await accountRow(account.stripeAccountId)
    expect(row).toMatchObject({
      chargesEnabled: false,
      payoutsEnabled: true,
      detailsSubmitted: true,
      transfersCapability: "active",
      requirementsCurrentlyDue: [],
      disabledReason: null,
      country: "ES",
      updatedFromStripeAt: FIXTURE_CREATED,
    })

    const stored = await stripeEventRow(event.id)
    expect(stored).toMatchObject({
      type: "account.updated",
      account: account.stripeAccountId,
      processedAt: NOW,
    })
    expect(stored?.payload).toMatchObject({ id: event.id, type: "account.updated" })

    const updatedEvents = await eventsAbout(account.id, "payouts.account_updated")
    expect(updatedEvents).toHaveLength(1)
    expect(updatedEvents[0]).toMatchObject({
      actorUserId: null,
      subjectType: "stripe_account",
      properties: {
        charges_enabled: false,
        payouts_enabled: true,
        details_submitted: true,
        transfers_capability: "active",
        ready: true,
        requirements_due_count: 0,
      },
    })

    // Payouts was the last step: onboarding finishes now.
    const [userRow] = await testDb.db.select().from(users).where(eq(users.id, user.id))
    expect(userRow?.onboardingCompletedAt).toEqual(NOW)
    expect(await eventsAbout(user.id, "onboarding.completed")).toHaveLength(1)

    const notes = await testDb.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.id))
    expect(notes).toEqual([
      expect.objectContaining({
        type: "payouts.ready",
        payload: { stripe_account_id: account.stripeAccountId },
        dedupeKey: `payouts.ready:${account.stripeAccountId}`,
      }),
    ])
    const emails = await listOutbox()
    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({ to: [user.email], subject: "Your payouts are set up" })
    expect(emails[0]?.text).toContain("http://localhost:3000/app/settings/payouts")
  })

  it("treats a duplicate delivery as a no-op", async () => {
    const { user, account } = await builderAwaitingPayouts()
    const event = accountUpdated(account.stripeAccountId)

    expect((await deliver(event)).body).toEqual({ received: true, status: "processed" })
    expect(await deliver(event)).toEqual({
      status: 200,
      body: { received: true, status: "duplicate" },
    })

    expect(await eventsAbout(account.id, "payouts.account_updated")).toHaveLength(1)
    expect(
      await testDb.db.select().from(notifications).where(eq(notifications.userId, user.id)),
    ).toHaveLength(1)
    expect(await listOutbox()).toHaveLength(1)
  })

  it("answers 500 when the handler fails, keeps the event unprocessed, and a retry succeeds", async () => {
    const { account } = await builderAwaitingPayouts()
    const event = accountUpdated(account.stripeAccountId)
    vi.spyOn(connect, "syncAccountFromStripe").mockRejectedValueOnce(
      new Error("connection terminated"),
    )

    expect(await deliver(event)).toEqual({
      status: 500,
      body: { received: false, error: "processing_failed" },
    })
    expect(await stripeEventRow(event.id)).toMatchObject({ processedAt: null })
    expect((await accountRow(account.stripeAccountId)).payoutsEnabled).toBe(false)

    // Stripe retries the same event.
    expect((await deliver(event)).body).toEqual({ received: true, status: "processed" })
    expect(await stripeEventRow(event.id)).toMatchObject({ processedAt: NOW })
    expect((await accountRow(account.stripeAccountId)).payoutsEnabled).toBe(true)
  })

  it("rolls back everything a failing handler wrote", async () => {
    const { account } = await builderAwaitingPayouts()
    // A payload whose object does not parse: the handler throws before writing.
    const broken = accountUpdated(account.stripeAccountId, { object: { payouts_enabled: "yes" } })
    expect((await deliver(broken)).status).toBe(500)
    expect(await stripeEventRow(broken.id)).toMatchObject({ processedAt: null })
    expect(await eventsAbout(account.id, "payouts.account_updated")).toHaveLength(0)
  })

  it("skips events older than the data already stored", async () => {
    const { account } = await builderAwaitingPayouts()
    await deliver(accountUpdated(account.stripeAccountId))

    const older = accountUpdated(account.stripeAccountId, {
      created: accountUpdatedFixture.created - 60,
      object: { payouts_enabled: false, capabilities: { transfers: "inactive" } },
    })
    expect((await deliver(older)).body).toEqual({ received: true, status: "processed" })
    expect(await accountRow(account.stripeAccountId)).toMatchObject({
      payoutsEnabled: true,
      transfersCapability: "active",
      updatedFromStripeAt: FIXTURE_CREATED,
    })
  })

  it("notifies about readiness only the first time", async () => {
    const { user, account } = await builderAwaitingPayouts()
    const created = accountUpdatedFixture.created
    await deliver(accountUpdated(account.stripeAccountId, { created }))
    await deliver(
      accountUpdated(account.stripeAccountId, {
        created: created + 60,
        object: { payouts_enabled: false },
      }),
    )
    await deliver(accountUpdated(account.stripeAccountId, { created: created + 120 }))

    expect(await eventsAbout(account.id, "payouts.account_updated")).toHaveLength(3)
    expect(
      await testDb.db.select().from(notifications).where(eq(notifications.userId, user.id)),
    ).toHaveLength(1)
    expect(await listOutbox()).toHaveLength(1)
  })

  it("records an unchanged account without an event", async () => {
    const { account } = await builderAwaitingPayouts()
    await deliver(accountUpdated(account.stripeAccountId))
    await deliver(
      accountUpdated(account.stripeAccountId, { created: accountUpdatedFixture.created + 5 }),
    )
    expect(await eventsAbout(account.id, "payouts.account_updated")).toHaveLength(1)
    expect((await accountRow(account.stripeAccountId)).updatedFromStripeAt).toEqual(
      new Date((accountUpdatedFixture.created + 5) * 1000),
    )
  })

  it("applies capability.updated for transfers and ignores other capabilities", async () => {
    const user = await insertUser(testDb.db)
    const account = await insertStripeAccount(testDb.db, user.id, {
      stripeAccountId: uniqueId("acct_test_"),
      payoutsEnabled: true,
      transfersCapability: "pending",
    })
    const event = structuredClone(capabilityUpdatedFixture)
    const transfers = {
      ...event,
      id: uniqueId("evt_test_"),
      account: account.stripeAccountId,
      data: { ...event.data, object: { ...event.data.object, account: account.stripeAccountId } },
    }
    expect((await deliver(transfers)).body).toEqual({ received: true, status: "processed" })
    expect(await accountRow(account.stripeAccountId)).toMatchObject({
      transfersCapability: "active",
      updatedFromStripeAt: FIXTURE_CREATED,
    })
    // Became ready through the capability alone: notified.
    expect(
      await testDb.db.select().from(notifications).where(eq(notifications.userId, user.id)),
    ).toHaveLength(1)

    const cardPayments = {
      ...transfers,
      id: uniqueId("evt_test_"),
      created: transfers.created + 10,
      data: {
        ...transfers.data,
        object: { ...transfers.data.object, id: "card_payments", status: "inactive" },
      },
    }
    expect((await deliver(cardPayments)).body).toEqual({ received: true, status: "processed" })
    expect((await accountRow(account.stripeAccountId)).transfersCapability).toBe("active")
  })

  it("adopts an account it has no row for when metadata names the user", async () => {
    const user = await insertUser(testDb.db)
    const stripeAccountId = uniqueId("acct_test_")
    const event = accountUpdated(stripeAccountId, { object: { metadata: { user_id: user.id } } })

    expect((await deliver(event)).body).toEqual({ received: true, status: "processed" })
    const row = await accountRow(stripeAccountId)
    expect(row).toMatchObject({
      userId: user.id,
      payoutsEnabled: true,
      transfersCapability: "active",
    })
    expect(await eventsAbout(row.id, "payouts.account_created")).toHaveLength(1)
    // It became ready on that first sync, so the user hears about it.
    expect(
      await testDb.db.select().from(notifications).where(eq(notifications.userId, user.id)),
    ).toHaveLength(1)
  })

  it("acknowledges accounts that are not ours without writing anything", async () => {
    const stripeAccountId = uniqueId("acct_test_")
    const event = accountUpdated(stripeAccountId, {
      object: { metadata: { user_id: "0190a000-0000-7000-8000-00000000beef" } },
    })
    expect((await deliver(event)).body).toEqual({ received: true, status: "processed" })
    const rows = await testDb.db
      .select()
      .from(stripeAccounts)
      .where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
    expect(rows).toEqual([])

    // A user who already has a different account does not get this one.
    const { user } = await builderAwaitingPayouts()
    const other = accountUpdated(uniqueId("acct_test_"), {
      object: { metadata: { user_id: user.id } },
    })
    expect((await deliver(other)).body).toEqual({ received: true, status: "processed" })
    expect(
      await testDb.db.select().from(stripeAccounts).where(eq(stripeAccounts.userId, user.id)),
    ).toHaveLength(1)
  })

  it("acknowledges and records event types without a handler", async () => {
    const event = { ...structuredClone(checkoutCompletedFixture), id: uniqueId("evt_test_") }
    expect((await deliver(event, PLATFORM_SECRET)).body).toEqual({
      received: true,
      status: "ignored",
    })
    expect(await stripeEventRow(event.id)).toMatchObject({
      type: "checkout.session.completed",
      account: null,
      processedAt: NOW,
    })
    expect((await deliver(event, PLATFORM_SECRET)).body).toEqual({
      received: true,
      status: "duplicate",
    })
  })
})
