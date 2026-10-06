import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq, isNull } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { handleCheckoutRequest } from "@/lib/checkout/start"
import { fakeCheckoutPageGet, fakeCheckoutPagePost } from "@/lib/checkout/fake-page"
import { deliverDirectly } from "@/lib/checkout/fake-purchase"
import { loadSuccessState } from "@/lib/checkout/success"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import {
  events,
  launchFiles,
  launches,
  licenseKeys,
  orders,
  stripeEvents,
  trackedLinks,
} from "@/lib/db/schema"
import { accessFileUrl, loadAccessView } from "@/lib/delivery/access"
import { listOutbox } from "@/lib/email/outbox"
import { resetEnvCache } from "@/lib/env"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { createLocalStorage } from "@/lib/storage/local"
import { completeFakeCheckoutSession, readFakeCheckoutSession } from "@/lib/stripe/fake-checkout"
import { createFakeEvent } from "@/lib/stripe/fake"
import { handleStripeWebhookRequest } from "@/lib/stripe/webhooks"

import { setupTestDatabase } from "../../helpers/db"
import { insertLiveLaunch } from "../../helpers/db-fixtures"
import { stubServiceEnv, TEST_APP_URL } from "../../helpers/service-env"
import {
  activeGrant,
  entriesOf,
  eventsOf,
  fakeGateway,
  liveLaunchWithLink,
  makeLicenseKeyLaunch,
  notificationsOf,
  orderRow,
  ordersOfLaunch,
  purchase,
  sum,
} from "./helpers"

/**
 * Checkout, fulfilment, delivery and access (§7.2, §9, §10, §12; CLAUDE.md §19.31, §19.34). The
 * Stripe side is the fake gateway against a temporary store; webhook events go through the real
 * processing (`processStripeEvent`: `stripe_events`, the handlers, the after-commit job), and the
 * `orders-fulfilled` job runs inline (fake jobs) against this test database.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown, reported: [] as unknown[] }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/observability", () => ({
  reportError: (error: unknown) => {
    mocks.reported.push(error)
  },
}))

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
const WEBHOOK_SECRET = "whsec_unit_test"

let root = ""

beforeAll(async () => {
  mocks.dir = await mkdtemp(path.join(tmpdir(), "checkout-test-"))
  root = path.join(mocks.dir, "fake-stripe")
})
afterAll(async () => {
  await rm(mocks.dir, { recursive: true, force: true })
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.reported = []
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(async () => {
  setClockForTests(null)
  vi.unstubAllEnvs()
  resetEnvCache()
  await closeDb()
})

function checkoutRequest(
  slug: string,
  options: { query?: string; cookie?: string; ip?: string } = {},
) {
  return new Request(`${TEST_APP_URL}/p/${slug}/checkout${options.query ?? ""}`, {
    method: "POST",
    headers: {
      "user-agent": BROWSER,
      "x-forwarded-for": options.ip ?? "203.0.113.20",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
  })
}

async function startCheckout(slug: string, options: Parameters<typeof checkoutRequest>[1] = {}) {
  return handleCheckoutRequest(checkoutRequest(slug, options), slug, {
    db: testDb.db,
    gateway: fakeGateway(root),
  })
}

function sessionIdOf(response: Response): string {
  const location = response.headers.get("location") ?? ""
  const id = location.split("/").pop()
  if (!id) throw new Error("no session id in the redirect")
  return id
}

// --- POST /p/<slug>/checkout ------------------------------------------------------------------

describe("starting a checkout", () => {
  it("creates a Checkout Session with the contract's parameters and records checkout.started", async () => {
    const live = await liveLaunchWithLink(testDb.db)
    const response = await startCheckout(live.launch.slug)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toMatch(
      /^http:\/\/localhost:3000\/api\/dev\/fake-stripe\/checkout\/cs_fake_/,
    )
    const stored = await readFakeCheckoutSession(fakeGateway(root).store, sessionIdOf(response))
    expect(stored?.session).toMatchObject({
      status: "open",
      payment_status: "unpaid",
      amount_subtotal: 1900,
      amount_total: 1900,
      currency: "eur",
      metadata: { launch_id: live.launch.id },
    })
    expect(stored?.session.metadata?.tracked_link_id).toBeUndefined()
    expect(stored?.session.client_reference_id).toBe(stored?.session.metadata?.order_ref)
    expect(stored?.extras.success_url).toBe(
      `${TEST_APP_URL}/p/${live.launch.slug}/success?session_id={CHECKOUT_SESSION_ID}`,
    )
    expect(stored?.extras.fake_line.tax_code).toBe("txcd_10103000")
    const started = await eventsOf(testDb.db, live.launch.id, "checkout.started")
    expect(started).toHaveLength(1)
    expect(started[0]?.actorUserId).toBeNull()
    expect(started[0]?.properties).toEqual({
      tracked_link_id: null,
      price_cents: 1900,
      currency: "eur",
    })
  })

  it("attributes from the attr cookie, else ?ref=, and ignores links of other launches", async () => {
    const live = await liveLaunchWithLink(testDb.db)
    const other = await liveLaunchWithLink(testDb.db)
    const store = fakeGateway(root).store

    const byCookie = await startCheckout(live.launch.slug, { cookie: `attr=${live.link.id}` })
    expect(
      (await readFakeCheckoutSession(store, sessionIdOf(byCookie)))?.session.metadata,
    ).toMatchObject({
      tracked_link_id: live.link.id,
      attribution: "cookie",
    })

    const byRef = await startCheckout(live.launch.slug, {
      cookie: `attr=${other.link.id}`,
      query: `?ref=${live.link.code}`,
    })
    expect(
      (await readFakeCheckoutSession(store, sessionIdOf(byRef)))?.session.metadata,
    ).toMatchObject({
      tracked_link_id: live.link.id,
      attribution: "ref",
    })

    const none = await startCheckout(live.launch.slug, { query: `?ref=${other.link.code}` })
    expect(
      (await readFakeCheckoutSession(store, sessionIdOf(none)))?.session.metadata?.tracked_link_id,
    ).toBeUndefined()
  })

  it("pre-applies the promotion code of a discount link given as ?code=", async () => {
    const live = await liveLaunchWithLink(testDb.db)
    const gateway = fakeGateway(root)
    const promo = await gateway.createPromotionCode(
      { code: "ADA20", percentOff: 20, metadata: { launch_id: live.launch.id } },
      { idempotencyKey: `promo:${live.link.id}` },
    )
    await testDb.db
      .update(trackedLinks)
      .set({ discountCode: "ADA20", discountPercentOff: 20, stripePromotionCodeId: promo.id })
      .where(eq(trackedLinks.id, live.link.id))
    const response = await startCheckout(live.launch.slug, { query: "?code=ada20" })
    const stored = await readFakeCheckoutSession(gateway.store, sessionIdOf(response))
    expect(stored?.session.amount_total).toBe(1520)
    expect(stored?.session.total_details?.amount_discount).toBe(380)
    expect(stored?.extras.allow_promotion_codes).toBe(false)
  })

  it("refuses launches that are not live, sold-out key launches, and too many attempts", async () => {
    const live = await insertLiveLaunch(testDb.db)
    await testDb.db
      .update(launches)
      .set({ status: "paused", pausedAt: NOW, pausedBy: "member" })
      .where(eq(launches.id, live.launch.id))
    const paused = await startCheckout(live.launch.slug)
    expect(paused.status).toBe(409)
    expect(await paused.text()).toContain("Not available right now")

    const keys = await insertLiveLaunch(testDb.db)
    await makeLicenseKeyLaunch(testDb.db, keys.launch.id, [])
    const soldOut = await startCheckout(keys.launch.slug)
    expect(soldOut.status).toBe(409)
    expect(await soldOut.text()).toContain("Sold out")

    expect((await startCheckout("no-such-product")).status).toBe(404)

    const open = await insertLiveLaunch(testDb.db)
    const statuses: number[] = []
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await startCheckout(open.launch.slug, { ip: "203.0.113.99" })).status)
    }
    expect(statuses.slice(0, 10).every((status) => status === 303)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})

// --- Fulfilment -------------------------------------------------------------------------------

describe("fulfilment (checkout.session.completed)", () => {
  it("creates the paid order, access grant, ledger, event and emails in one go", async () => {
    const live = await liveLaunchWithLink(testDb.db)
    const result = await purchase(testDb.db, root, live, {
      email: "Buyer@Example.test",
      country: "ES",
      trackedLinkId: live.link.id,
      attribution: "ref",
    })

    const order = await orderRow(testDb.db, result.orderRef)
    expect(order).toMatchObject({
      launchId: live.launch.id,
      buyerEmail: "buyer@example.test",
      stripeCheckoutSessionId: result.sessionId,
      stripePaymentIntentId: result.paymentIntentId,
      stripeChargeId: result.chargeId,
      amountGrossCents: 1900,
      taxCents: 330,
      discountCents: 0,
      stripeFeeCents: 54,
      currency: "eur",
      buyerCountry: "ES",
      trackedLinkId: live.link.id,
      attribution: "ref",
      status: "paid",
      paidAt: NOW,
    })
    expect(order?.ledgerPostedAt).not.toBeNull()

    const grant = await activeGrant(testDb.db, result.orderRef)
    expect(grant?.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const entries = await entriesOf(testDb.db, result.orderRef)
    expect(sum(entries)).toBe(1900)
    expect(entries.find((e) => e.account === "tax")?.amountCents).toBe(330)
    expect(entries.find((e) => e.account === "stripe_fee")?.amountCents).toBe(54)

    const paid = await eventsOf(testDb.db, result.orderRef, "order.paid")
    expect(paid).toHaveLength(1)
    expect(paid[0]?.properties).toEqual({
      launch_id: live.launch.id,
      tracked_link_id: live.link.id,
      amount_gross_cents: 1900,
      tax_cents: 330,
      stripe_fee_cents: 54,
      currency: "eur",
    })
    expect(JSON.stringify(paid[0])).not.toContain("example.test")
    expect(JSON.stringify(paid[0])).not.toContain(grant?.token ?? "-")

    const outbox = await listOutbox()
    const receipt = outbox.find((email) => email.to.includes("buyer@example.test"))
    expect(receipt?.subject).toBe(`Your purchase: ${live.launch.title}`)
    expect(receipt?.text).toContain(`/access/${grant?.token}`)
    for (const member of [live.creator.user, live.builder.user]) {
      expect(await notificationsOf(testDb.db, member.id, "sale.made")).toHaveLength(1)
    }
  })

  it("is a no-op for replayed and duplicate events", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const result = await purchase(testDb.db, root, live)
    const completed = result.events[0]
    if (!completed) throw new Error("no event")

    // The same event again (Stripe's retry): recorded once, processed once.
    await deliverDirectly(testDb.db)(completed)
    const [row] = await testDb.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, String(completed.id)))
    expect(row?.processedAt).not.toBeNull()

    // A second event for the same session (a duplicate delivery with a new id).
    const store = fakeGateway(root).store
    const data = completed.data as { object: Record<string, never> }
    const again = await createFakeEvent(store, "checkout.session.completed", data.object)
    await deliverDirectly(testDb.db)(again)

    expect(await ordersOfLaunch(testDb.db, live.launch.id)).toHaveLength(1)
    expect(sum(await entriesOf(testDb.db, result.orderRef))).toBe(1900)
    expect(await eventsOf(testDb.db, result.orderRef, "order.paid")).toHaveLength(1)
    const receipts = (await listOutbox()).filter(
      (email) =>
        email.subject.startsWith("Your purchase") &&
        email.text.includes(result.orderRef.replaceAll("-", "").slice(-8).toUpperCase()),
    )
    expect(receipts).toHaveLength(1)
  })

  it("does not fulfil an unpaid session; async success fulfils it, async failure never does", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const delayed = await purchase(testDb.db, root, live, { method: "delayed" })
    expect(delayed.events.map((event) => event.type)).toEqual([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ])
    const order = await orderRow(testDb.db, delayed.orderRef)
    expect(order?.status).toBe("paid")
    expect(order?.ledgerPostedAt).not.toBeNull()

    const failed = await purchase(testDb.db, root, live, { method: "delayed_fail" })
    expect(await orderRow(testDb.db, failed.orderRef)).toBeNull()
    expect(await ordersOfLaunch(testDb.db, live.launch.id)).toHaveLength(1)
  })

  it("stops after an unpaid completion (nothing written until the payment clears)", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const gateway = fakeGateway(root)
    const response = await startCheckout(live.launch.slug)
    const sessionId = sessionIdOf(response)
    const paid = await completeFakeCheckoutSession(gateway.store, sessionId, {
      method: "delayed",
      email: "slow@example.test",
      country: "NL",
    })
    if (!paid.ok) throw new Error("not paid")
    await deliverDirectly(testDb.db)(
      await createFakeEvent(gateway.store, "checkout.session.completed", paid.session),
    )
    expect(await ordersOfLaunch(testDb.db, live.launch.id)).toHaveLength(0)
    const state = await loadSuccessState(testDb.db, gateway, { slug: live.launch.slug, sessionId })
    expect(state.kind).toBe("processing")
  })

  it("posts the ledger on charge.updated when the fee was pending, once", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const gateway = fakeGateway(root)
    const response = await startCheckout(live.launch.slug)
    const sessionId = sessionIdOf(response)
    const paid = await completeFakeCheckoutSession(gateway.store, sessionId, {
      method: "card_fee_pending",
      email: "fee@example.test",
      country: "DE",
    })
    if (!paid.ok || !paid.chargeId) throw new Error("not paid")
    await deliverDirectly(testDb.db)(
      await createFakeEvent(gateway.store, "checkout.session.completed", paid.session),
    )
    const [pending] = await ordersOfLaunch(testDb.db, live.launch.id)
    expect(pending?.ledgerPostedAt).toBeNull()
    expect(pending?.stripeFeeCents).toBe(0)
    expect(pending?.taxCents).toBe(303)
    expect(await entriesOf(testDb.db, pending?.id ?? "")).toHaveLength(0)
    expect(
      (await eventsOf(testDb.db, pending?.id ?? "", "order.paid"))[0]?.properties,
    ).toMatchObject({
      stripe_fee_cents: 0,
    })

    const { settleFakeChargeFee } = await import("@/lib/stripe/fake-checkout")
    const charge = await settleFakeChargeFee(gateway.store, paid.chargeId)
    const updated = await createFakeEvent(gateway.store, "charge.updated", charge)
    await deliverDirectly(testDb.db)(updated)
    await deliverDirectly(testDb.db)(await createFakeEvent(gateway.store, "charge.updated", charge))

    const posted = await orderRow(testDb.db, pending?.id ?? "")
    expect(posted?.ledgerPostedAt).not.toBeNull()
    expect(posted?.stripeFeeCents).toBe(54)
    expect(sum(await entriesOf(testDb.db, pending?.id ?? ""))).toBe(1900)
    expect(await eventsOf(testDb.db, pending?.id ?? "", "order.ledger_posted")).toHaveLength(1)
  })
})

describe("attribution at completion", () => {
  it("re-checks the metadata link: a link disabled meanwhile does not attribute", async () => {
    const live = await liveLaunchWithLink(testDb.db)
    const response = await startCheckout(live.launch.slug, { cookie: `attr=${live.link.id}` })
    await testDb.db
      .update(trackedLinks)
      .set({ disabledAt: NOW })
      .where(eq(trackedLinks.id, live.link.id))
    const gateway = fakeGateway(root)
    const paid = await completeFakeCheckoutSession(gateway.store, sessionIdOf(response), {
      method: "card",
      email: "late@example.test",
      country: "ES",
    })
    if (!paid.ok) throw new Error("not paid")
    await deliverDirectly(testDb.db)(
      await createFakeEvent(gateway.store, "checkout.session.completed", paid.session),
    )
    const [order] = await ordersOfLaunch(testDb.db, live.launch.id)
    expect(order).toMatchObject({ trackedLinkId: null, attribution: null })
  })

  it("a promotion code of the launch's link wins over the cookie (discount_code)", async () => {
    const live = await liveLaunchWithLink(testDb.db)
    const other = await testDb.db
      .insert(trackedLinks)
      .values({ launchId: live.launch.id, ownerUserId: live.builder.user.id, code: "Zz9Yy8Xx" })
      .returning()
    const gateway = fakeGateway(root)
    const promo = await gateway.createPromotionCode(
      { code: "SAVE10", percentOff: 10, metadata: { launch_id: live.launch.id } },
      { idempotencyKey: `promo:${live.link.id}` },
    )
    await testDb.db
      .update(trackedLinks)
      .set({ discountCode: "SAVE10", discountPercentOff: 10, stripePromotionCodeId: promo.id })
      .where(eq(trackedLinks.id, live.link.id))
    const result = await purchase(testDb.db, root, live, {
      trackedLinkId: other[0]?.id ?? null,
      attribution: "cookie",
      promotionCode: "save10",
    })
    const order = await orderRow(testDb.db, result.orderRef)
    expect(order).toMatchObject({
      trackedLinkId: live.link.id,
      attribution: "discount_code",
      amountGrossCents: 1710,
      discountCents: 190,
    })
    expect(sum(await entriesOf(testDb.db, result.orderRef))).toBe(1710)
  })
})

// --- License keys ------------------------------------------------------------------------------

describe("license keys", () => {
  it("never gives one key to two orders paid at once; the second waits for a restock", async () => {
    const live = await insertLiveLaunch(testDb.db)
    await makeLicenseKeyLaunch(testDb.db, live.launch.id, ["KEY-ONLY-ONE"])
    const keyLive = { ...live, launch: { ...live.launch, deliveryType: "license_key" as const } }
    const [a, b] = await Promise.all([
      purchase(testDb.db, root, keyLive, { email: "a@example.test" }),
      purchase(testDb.db, root, keyLive, { email: "b@example.test" }),
    ])
    const assigned = await testDb.db
      .select()
      .from(licenseKeys)
      .where(eq(licenseKeys.launchId, live.launch.id))
    expect(assigned).toHaveLength(1)
    const winner = assigned[0]?.orderId
    expect([a.orderRef, b.orderRef]).toContain(winner)
    const loser = winner === a.orderRef ? b.orderRef : a.orderRef
    expect(await orderRow(testDb.db, loser)).toMatchObject({ status: "paid" })

    // Members hear they are out of keys (remaining 0, once), and the out-of-stock order is alerted.
    for (const member of [live.creator.user, live.builder.user]) {
      const low = await notificationsOf(testDb.db, member.id, "launch.license_keys_low")
      expect(low).toHaveLength(1)
      expect(low[0]?.payload).toMatchObject({ remaining: 0 })
    }
    expect(mocks.reported.some((error) => String(error).includes("License keys ran out"))).toBe(
      true,
    )

    // The buyer without a key sees it is on its way, and gets the next key once one is added.
    const grant = await activeGrant(testDb.db, loser)
    const waiting = await loadAccessView(testDb.db, grant?.token ?? "")
    expect(waiting).toMatchObject({ status: "active", licenseKey: null })
    await testDb.db.insert(licenseKeys).values({ launchId: live.launch.id, key: "KEY-RESTOCK" })
    const [first, second] = await Promise.all([
      loadAccessView(testDb.db, grant?.token ?? ""),
      loadAccessView(testDb.db, grant?.token ?? ""),
    ])
    expect(first).toMatchObject({
      licenseKey: "KEY-RESTOCK",
      instructions: "Paste it in Settings.",
    })
    expect(second).toMatchObject({ licenseKey: "KEY-RESTOCK" })
    const unassigned = await testDb.db
      .select()
      .from(licenseKeys)
      .where(and(eq(licenseKeys.launchId, live.launch.id), isNull(licenseKeys.orderId)))
    expect(unassigned).toHaveLength(0)
  })
})

// --- Access and success pages ------------------------------------------------------------------

describe("buyer access", () => {
  it("serves files through 5-minute signed URLs, url targets, and plain refusals", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const storage = createLocalStorage(path.join(mocks.dir, "storage"))
    await storage.putObject(
      `launch-files/${live.launch.id}/guide.pdf`,
      "%PDF-1.4",
      "application/pdf",
    )
    await testDb.db
      .update(launches)
      .set({ deliveryType: "file", deliveryConfig: { type: "file" } })
      .where(eq(launches.id, live.launch.id))
    const [file] = await testDb.db
      .insert(launchFiles)
      .values({
        launchId: live.launch.id,
        storageKey: `launch-files/${live.launch.id}/guide.pdf`,
        filename: "guide.pdf",
        sizeBytes: 8,
        contentType: "application/pdf",
      })
      .returning()
    const fileLive = { ...live, launch: { ...live.launch, deliveryType: "file" as const } }
    const result = await purchase(testDb.db, root, fileLive)
    const grant = await activeGrant(testDb.db, result.orderRef)
    const token = grant?.token ?? ""

    const view = await loadAccessView(testDb.db, token)
    expect(view).toMatchObject({
      status: "active",
      deliveryType: "file",
      files: [{ filename: "guide.pdf" }],
    })
    const url = await accessFileUrl(testDb.db, token, file?.id ?? "", storage)
    expect(url).toContain("exp=")
    const expiry = Number(new URL(url ?? "http://x").searchParams.get("exp"))
    expect(expiry * 1000 - NOW.getTime()).toBeLessThanOrEqual(5 * 60 * 1000)

    // Another launch's file, a malformed id, an unknown token: nothing.
    const other = await insertLiveLaunch(testDb.db)
    const [foreign] = await testDb.db
      .insert(launchFiles)
      .values({
        launchId: other.launch.id,
        storageKey: `launch-files/${other.launch.id}/x.pdf`,
        filename: "x.pdf",
        sizeBytes: 1,
      })
      .returning()
    expect(await accessFileUrl(testDb.db, token, foreign?.id ?? "", storage)).toBeNull()
    expect(await accessFileUrl(testDb.db, token, "not-a-uuid", storage)).toBeNull()
    expect(await loadAccessView(testDb.db, "x".repeat(43))).toBeNull()
    expect(await loadAccessView(testDb.db, "short")).toBeNull()

    // Revoked (a full refund): a plain "no longer available".
    await testDb.db
      .update(orders)
      .set({ status: "refunded", amountRefundedCents: 1900 })
      .where(eq(orders.id, result.orderRef))
    const { accessGrants } = await import("@/lib/db/schema")
    await testDb.db
      .update(accessGrants)
      .set({ revokedAt: NOW })
      .where(eq(accessGrants.token, token))
    expect(await loadAccessView(testDb.db, token)).toMatchObject({ status: "revoked" })
    expect(await accessFileUrl(testDb.db, token, file?.id ?? "", storage)).toBeNull()
  })

  it("url deliveries expose their target", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const result = await purchase(testDb.db, root, live)
    const grant = await activeGrant(testDb.db, result.orderRef)
    expect(await loadAccessView(testDb.db, grant?.token ?? "")).toMatchObject({
      status: "active",
      deliveryType: "url",
      url: "https://example.test/app",
    })
  })

  it("the success page shows only the order of its own session and launch", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const other = await insertLiveLaunch(testDb.db)
    const gateway = fakeGateway(root)
    const result = await purchase(testDb.db, root, live)
    const paid = await loadSuccessState(testDb.db, gateway, {
      slug: live.launch.slug,
      sessionId: result.sessionId,
    })
    expect(paid).toMatchObject({ kind: "paid" })
    expect(paid.kind === "paid" && paid.accessHref).toMatch(/^\/access\/[A-Za-z0-9_-]{43}$/)
    expect(
      await loadSuccessState(testDb.db, gateway, {
        slug: other.launch.slug,
        sessionId: result.sessionId,
      }),
    ).toEqual({ kind: "not_found" })
    expect(
      await loadSuccessState(testDb.db, gateway, { slug: live.launch.slug, sessionId: "nope" }),
    ).toEqual({ kind: "not_found" })
    expect(
      await loadSuccessState(testDb.db, gateway, {
        slug: live.launch.slug,
        sessionId: "cs_fake_unknown",
      }),
    ).toEqual({ kind: "not_found" })

    const open = sessionIdOf(await startCheckout(live.launch.slug))
    expect(
      await loadSuccessState(testDb.db, gateway, { slug: live.launch.slug, sessionId: open }),
    ).toMatchObject({ kind: "unpaid" })

    // Paid at Stripe, webhook not processed yet: "finishing".
    const pending = sessionIdOf(await startCheckout(live.launch.slug))
    await completeFakeCheckoutSession(gateway.store, pending, {
      method: "card",
      email: "x@example.test",
      country: "ES",
    })
    expect(
      await loadSuccessState(testDb.db, gateway, { slug: live.launch.slug, sessionId: pending }),
    ).toMatchObject({ kind: "finishing" })
  })

  it("asks Stripe only within the per-IP limit, and never when the order exists", async () => {
    const live = await insertLiveLaunch(testDb.db)
    const gateway = fakeGateway(root)
    const retrieve = vi.spyOn(gateway, "retrieveCheckoutSession")
    const paid = await purchase(testDb.db, root, live)
    const refuse = vi.fn(async () => false)
    // The order exists: no Stripe read and no limit consumed.
    expect(
      await loadSuccessState(
        testDb.db,
        gateway,
        { slug: live.launch.slug, sessionId: paid.sessionId },
        { allowStripeLookup: refuse },
      ),
    ).toMatchObject({ kind: "paid" })
    expect(refuse).not.toHaveBeenCalled()
    // Any other well-formed id over the limit: no Stripe call at all.
    expect(
      await loadSuccessState(
        testDb.db,
        gateway,
        { slug: live.launch.slug, sessionId: "cs_fake_guess123" },
        { allowStripeLookup: refuse },
      ),
    ).toMatchObject({ kind: "finishing" })
    expect(refuse).toHaveBeenCalledTimes(1)
    expect(retrieve).not.toHaveBeenCalled()
  })
})

// --- The fake checkout page over the real webhook route ---------------------------------------

describe("fake checkout page", () => {
  it("shows the product and VAT, then pays and delivers signed events to the webhook", async () => {
    const live = await liveLaunchWithLink(testDb.db)
    const gateway = fakeGateway(root)
    const sessionId = sessionIdOf(
      await startCheckout(live.launch.slug, { cookie: `attr=${live.link.id}` }),
    )
    const deps = {
      store: gateway.store,
      appName: "Vincera",
      webhookUrl: `${TEST_APP_URL}/api/webhooks/stripe`,
      webhookSecret: WEBHOOK_SECRET,
      settleDelayMs: 0,
      // The real webhook handler, called in-process instead of over the network.
      fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
        handleStripeWebhookRequest(new Request(`${TEST_APP_URL}/api/webhooks/stripe`, init), {
          db: testDb.db,
          secrets: [WEBHOOK_SECRET],
        })) as typeof fetch,
    }
    const page = await fakeCheckoutPageGet(sessionId, deps)
    const html = await page.text()
    expect(html).toContain(live.launch.title)
    expect(html).toContain("VAT included")
    expect(html).toContain("Pay with test card 4242")

    const form = new FormData()
    form.set("method", "card")
    form.set("email", "page@example.test")
    form.set("country", "IT")
    const paid = await fakeCheckoutPagePost(
      new Request(`${TEST_APP_URL}/api/dev/fake-stripe/checkout/${sessionId}`, {
        method: "POST",
        body: form,
      }),
      sessionId,
      deps,
    )
    expect(paid.status).toBe(303)
    expect(paid.headers.get("location")).toBe(
      `${TEST_APP_URL}/p/${live.launch.slug}/success?session_id=${sessionId}`,
    )
    const [order] = await ordersOfLaunch(testDb.db, live.launch.id)
    expect(order).toMatchObject({
      buyerCountry: "IT",
      taxCents: 343,
      trackedLinkId: live.link.id,
      attribution: "cookie",
    })
    expect(order?.ledgerPostedAt).not.toBeNull()
    expect(mocks.reported).toEqual([])

    // The page is used up: paying again does nothing more.
    const again = await fakeCheckoutPageGet(sessionId, deps)
    expect(again.status).toBe(410)
    const recorded = await testDb.db.select().from(events).where(eq(events.type, "order.paid"))
    expect(recorded.filter((event) => event.subjectId === order?.id)).toHaveLength(1)
  })
})
