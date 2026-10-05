import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setClockForTests } from "@/lib/clock"
import {
  checkFakeAccountLink,
  completeFakeOnboarding,
  consumeFakeAccountLink,
  createFakeEvent,
  createFakeStripeGateway,
  deliverFakeWebhook,
  fakeAccountIdFor,
} from "@/lib/stripe/fake"
import { StripeGatewayError } from "@/lib/stripe/gateway"
import { stripeAccountSchema } from "@/lib/stripe/schemas"
import { verifyStripeWebhook } from "@/lib/stripe/webhooks"

const APP_URL = "http://localhost:3000"
const NOW = new Date("2026-10-05T12:00:00.000Z")
const USER_ID = "0190a000-0000-7000-8000-000000000001"

let root = ""

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fake-stripe-test-"))
  setClockForTests(NOW)
})

afterEach(async () => {
  setClockForTests(null)
  await rm(root, { recursive: true, force: true })
})

function gateway() {
  return createFakeStripeGateway({ root, appUrl: APP_URL })
}

async function createAccount(fake = gateway()) {
  return fake.createConnectedAccount(
    { country: "ES", email: "maker@example.test", userId: USER_ID },
    { idempotencyKey: `acct:${USER_ID}` },
  )
}

describe("fake Stripe gateway: connected accounts", () => {
  it("creates a Stripe-shaped account that still needs onboarding", async () => {
    const fake = gateway()
    const account = await createAccount(fake)

    expect(account).toEqual({
      id: fakeAccountIdFor(`acct:${USER_ID}`),
      object: "account",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      country: "ES",
      email: "maker@example.test",
      capabilities: { transfers: "inactive" },
      requirements: {
        currently_due: expect.arrayContaining(["external_account"]),
        past_due: expect.any(Array),
        disabled_reason: "requirements.past_due",
      },
      metadata: { user_id: USER_ID },
    })
    expect(account.id).toMatch(/^acct_fake_[0-9a-f]{16}$/)

    // Stored as a full Stripe object with the §19.10 controller properties.
    const stored: unknown = JSON.parse(
      await readFile(path.join(root, "account", `${account.id}.json`), "utf8"),
    )
    expect(stored).toMatchObject({
      controller: {
        fees: { payer: "application" },
        losses: { payments: "application" },
        requirement_collection: "stripe",
        stripe_dashboard: { type: "express" },
      },
      tos_acceptance: { service_agreement: "full" },
      created: NOW.getTime() / 1000,
    })
    expect(await fake.retrieveAccount(account.id)).toEqual(account)
  })

  it("replays the same idempotency key and rejects it with other parameters", async () => {
    const fake = gateway()
    const first = await createAccount(fake)
    expect(await createAccount(fake)).toEqual(first)
    await expect(
      fake.createConnectedAccount(
        { country: "FR", email: null, userId: USER_ID },
        { idempotencyKey: `acct:${USER_ID}` },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("throws resource_missing for unknown or malformed account ids", async () => {
    const fake = gateway()
    for (const id of ["acct_fake_missing", "../../etc/passwd", "acct_../x"]) {
      const error = await fake.retrieveAccount(id).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(StripeGatewayError)
      expect(error).toMatchObject({ code: "resource_missing" })
    }
  })

  it("writes atomically, leaving no temporary files behind", async () => {
    const fake = gateway()
    const account = await createAccount(fake)
    await completeFakeOnboarding(fake.store, account.id, "enabled")
    expect(await readdir(path.join(root, "account"))).toEqual([`${account.id}.json`])
  })
})

describe("fake Stripe gateway: links", () => {
  it("creates single-use, expiring account links for the fake onboarding page", async () => {
    const fake = gateway()
    const account = await createAccount(fake)
    const link = await fake.createAccountLink({
      accountId: account.id,
      refreshUrl: `${APP_URL}/onboarding/payouts/refresh`,
      returnUrl: `${APP_URL}/onboarding/payouts?return=1`,
    })
    expect(link.object).toBe("account_link")
    expect(link.expires_at - link.created).toBe(300)
    const url = new URL(link.url)
    expect(`${url.origin}${url.pathname}`).toBe(
      `${APP_URL}/api/dev/fake-stripe/connect/${account.id}`,
    )
    const linkId = url.searchParams.get("link") ?? ""

    const check = await checkFakeAccountLink(fake.store, account.id, linkId)
    expect(check).toMatchObject({
      ok: true,
      link: { return_url: `${APP_URL}/onboarding/payouts?return=1` },
    })
    // Wrong account or unknown link.
    expect(await checkFakeAccountLink(fake.store, "acct_fake_other", linkId)).toEqual({
      ok: false,
      reason: "missing",
    })
    expect(await checkFakeAccountLink(fake.store, account.id, "link_nope")).toEqual({
      ok: false,
      reason: "missing",
    })

    await consumeFakeAccountLink(fake.store, linkId)
    expect(await checkFakeAccountLink(fake.store, account.id, linkId)).toMatchObject({
      ok: false,
      reason: "used",
    })
  })

  it("expires account links after five minutes", async () => {
    const fake = gateway()
    const account = await createAccount(fake)
    const link = await fake.createAccountLink({
      accountId: account.id,
      refreshUrl: `${APP_URL}/r`,
      returnUrl: `${APP_URL}/ok`,
    })
    const linkId = new URL(link.url).searchParams.get("link") ?? ""
    setClockForTests(new Date(NOW.getTime() + 299_000))
    expect(await checkFakeAccountLink(fake.store, account.id, linkId)).toMatchObject({ ok: true })
    setClockForTests(new Date(NOW.getTime() + 300_000))
    expect(await checkFakeAccountLink(fake.store, account.id, linkId)).toMatchObject({
      ok: false,
      reason: "expired",
    })
  })

  it("refuses links for unknown accounts", async () => {
    await expect(
      gateway().createAccountLink({
        accountId: "acct_fake_missing",
        refreshUrl: `${APP_URL}/r`,
        returnUrl: `${APP_URL}/ok`,
      }),
    ).rejects.toMatchObject({ code: "resource_missing" })
  })

  it("creates login links only after the details were submitted", async () => {
    const fake = gateway()
    const account = await createAccount(fake)
    await expect(fake.createLoginLink(account.id)).rejects.toMatchObject({
      code: "invalid_request",
    })
    await completeFakeOnboarding(fake.store, account.id, "pending_verification")
    const login = await fake.createLoginLink(account.id)
    expect(login).toEqual({
      object: "login_link",
      created: NOW.getTime() / 1000,
      url: `${APP_URL}/api/dev/fake-stripe/dashboard/${account.id}`,
    })
  })
})

describe("fake onboarding outcomes and events", () => {
  it("enables the account, or leaves it verifying", async () => {
    const fake = gateway()
    const account = await createAccount(fake)

    const verifying = stripeAccountSchema.parse(
      await completeFakeOnboarding(fake.store, account.id, "pending_verification"),
    )
    expect(verifying).toMatchObject({
      details_submitted: true,
      payouts_enabled: false,
      capabilities: { transfers: "pending" },
      requirements: { currently_due: [], disabled_reason: "requirements.pending_verification" },
    })

    const enabled = stripeAccountSchema.parse(
      await completeFakeOnboarding(fake.store, account.id, "enabled"),
    )
    expect(enabled).toMatchObject({
      details_submitted: true,
      payouts_enabled: true,
      capabilities: { transfers: "active" },
      requirements: { currently_due: [], disabled_reason: null },
    })
    expect(await fake.retrieveAccount(account.id)).toEqual(enabled)
  })

  it("delivers events with a Stripe signature the webhook verification accepts", async () => {
    const fake = gateway()
    const account = await createAccount(fake)
    const object = await completeFakeOnboarding(fake.store, account.id, "enabled")
    const event = await createFakeEvent(fake.store, "account.updated", object, {
      account: account.id,
    })
    expect(event).toMatchObject({
      object: "event",
      type: "account.updated",
      account: account.id,
      livemode: false,
      created: NOW.getTime() / 1000,
    })
    expect(String(event.id)).toMatch(/^evt_fake_/)

    const received: { body?: string; signature?: string | null } = {}
    const result = await deliverFakeWebhook(event, {
      url: `${APP_URL}/api/webhooks/stripe`,
      secret: "whsec_connect_test",
      fetch: async (_url, init) => {
        received.body = String(init?.body)
        received.signature = new Headers(init?.headers).get("stripe-signature")
        return new Response(null, { status: 200 })
      },
    })
    expect(result).toEqual({ status: 200 })
    const { body = "", signature = null } = received

    const verified = verifyStripeWebhook(body, signature, ["whsec_platform", "whsec_connect_test"])
    expect(verified).toMatchObject({ ok: true, event: { id: event.id, type: "account.updated" } })
  })
})
