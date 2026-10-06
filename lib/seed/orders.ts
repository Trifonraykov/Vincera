import "server-only"

import { and, eq, inArray } from "drizzle-orm"

import { deliverDirectly, fakePurchase } from "@/lib/checkout/fake-purchase"
import { collabMembers, launches, orders, refunds, trackedLinks, users } from "@/lib/db/schema"
import { env } from "@/lib/env"
import { requestRefund } from "@/lib/refunds/request"
import { dataDir } from "@/lib/services"
import { isStripeFake } from "@/lib/stripe/client"
import { createFakeStripeGateway } from "@/lib/stripe/fake"
import type { FakePaymentMethod } from "@/lib/stripe/fake-checkout"

import { SEED_ADMIN_EMAIL } from "./launches"
import type { SeedStep } from "./types"

/**
 * `orders` (Phase 4–5, owner: checkout; CLAUDE.md §19.31 "Seed", §19.34): three paid orders of
 * the seeded live launch (creator 03's), each through the real path: a Checkout Session from the
 * fake gateway, paid like the fake page pays it, and its Stripe events processed by the real
 * webhook code (`processStripeEvent`), so the orders, access grants, ledger entries, events and
 * emails are exactly what a purchase writes. One is attributed to the default tracked link, one
 * is unattributed, and one has its Stripe fee arrive later (`charge.updated`).
 *
 * Then the seeded admin refunds €5 of the second order through the app's own refund path
 * (`requestRefund`: the refund row, the fake Stripe refund, `applyStripeRefund` with its ledger
 * mirror, the refund jobs), so the seed holds a partially refunded order too (CLAUDE.md §19.36).
 *
 * Idempotent per buyer email (`seed-buyer-01@example.com` …) and per refunded order. Skipped when
 * Stripe is live (the seed never talks to real Stripe) or the launch is missing.
 */

const PARTIAL_REFUND = { email: "seed-buyer-02@example.com", amountCents: 500 }

type SeedPurchase = {
  email: string
  country: string
  method: FakePaymentMethod
  attributed: boolean
}

const PURCHASES: readonly SeedPurchase[] = [
  { email: "seed-buyer-01@example.com", country: "ES", method: "card", attributed: true },
  { email: "seed-buyer-02@example.com", country: "DE", method: "card", attributed: false },
  {
    email: "seed-buyer-03@example.com",
    country: "FR",
    method: "card_fee_pending",
    attributed: true,
  },
]

export const seedOrders: SeedStep = {
  name: "orders",
  owner: "checkout",
  run: async ({ db }) => {
    if (!isStripeFake()) return { skipped: "Stripe is live: the seed only uses fake Stripe" }
    const [creator] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "seed-creator-03@example.com"))
    if (!creator) return { skipped: "creator 03 missing" }
    const [launch] = await db
      .select({
        id: launches.id,
        slug: launches.slug,
        title: launches.title,
        priceCents: launches.priceCents,
        currency: launches.currency,
        deliveryType: launches.deliveryType,
      })
      .from(launches)
      .innerJoin(collabMembers, eq(collabMembers.collabId, launches.collabId))
      .where(and(eq(collabMembers.userId, creator.id), eq(launches.status, "live")))
    if (!launch || launch.priceCents === null || launch.deliveryType === null) {
      return { skipped: "no live launch for creator 03" }
    }
    const [link] = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(and(eq(trackedLinks.launchId, launch.id), eq(trackedLinks.isDefault, true)))

    const existing = await db
      .select({ email: orders.buyerEmail })
      .from(orders)
      .where(
        and(
          eq(orders.launchId, launch.id),
          inArray(
            orders.buyerEmail,
            PURCHASES.map((purchase) => purchase.email),
          ),
        ),
      )
    const done = new Set(existing.map((row) => row.email))

    const gateway = createFakeStripeGateway({
      root: dataDir("fake-stripe"),
      appUrl: env.NEXT_PUBLIC_APP_URL,
    })
    let created = 0
    for (const purchase of PURCHASES) {
      if (done.has(purchase.email)) continue
      await fakePurchase(
        gateway.store,
        gateway,
        {
          launch: {
            id: launch.id,
            slug: launch.slug,
            title: launch.title,
            priceCents: launch.priceCents,
            currency: launch.currency,
            deliveryType: launch.deliveryType,
          },
          appUrl: env.NEXT_PUBLIC_APP_URL,
          email: purchase.email,
          country: purchase.country,
          method: purchase.method,
          trackedLinkId: purchase.attributed && link ? link.id : null,
          attribution: "ref",
        },
        deliverDirectly(db),
      )
      created += 1
    }

    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, SEED_ADMIN_EMAIL))
    const [toRefund] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.launchId, launch.id), eq(orders.buyerEmail, PARTIAL_REFUND.email)))
    if (admin && toRefund) {
      const [refunded] = await db
        .select({ id: refunds.id })
        .from(refunds)
        .where(eq(refunds.orderId, toRefund.id))
      if (!refunded) {
        await requestRefund(
          db,
          {
            orderId: toRefund.id,
            amountCents: PARTIAL_REFUND.amountCents,
            requestedByUserId: admin.id,
            reason: "requested_by_customer",
          },
          { gateway },
        )
        created += 1
      }
    }
    return { created }
  },
}
