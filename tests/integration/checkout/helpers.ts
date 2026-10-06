import { and, asc, eq, isNull } from "drizzle-orm"

import { deliverDirectly, fakePurchase, type FakePurchaseInput } from "@/lib/checkout/fake-purchase"
import type { Db } from "@/lib/db/client"
import {
  accessGrants,
  events,
  launches,
  ledgerEntries,
  licenseKeys,
  notifications,
  orders,
} from "@/lib/db/schema"
import { createFakeStripeGateway } from "@/lib/stripe/fake"

import { insertLiveLaunch, insertTrackedLink } from "../../helpers/db-fixtures"
import { TEST_APP_URL } from "../../helpers/service-env"

/** Shared setup for the checkout integration tests (CLAUDE.md §19.34). */

export function fakeGateway(root: string) {
  return createFakeStripeGateway({ root, appUrl: TEST_APP_URL })
}

export type LiveLaunch = Awaited<ReturnType<typeof insertLiveLaunch>>

/** A live €19 URL launch (60/40) with the creator's default tracked link. */
export async function liveLaunchWithLink(db: Db) {
  const live = await insertLiveLaunch(db)
  const link = await insertTrackedLink(db, live.launch.id, live.creator.user.id, {
    isDefault: true,
  })
  return { ...live, link }
}

/** Turn the fixture launch into a license-key launch with `keys` in stock. */
export async function makeLicenseKeyLaunch(db: Db, launchId: string, keys: readonly string[]) {
  await db
    .update(launches)
    .set({
      deliveryType: "license_key",
      deliveryConfig: { type: "license_key", instructions: "Paste it in Settings." },
    })
    .where(eq(launches.id, launchId))
  if (keys.length > 0) {
    await db.insert(licenseKeys).values(keys.map((key) => ({ launchId, key })))
  }
}

export function launchInput(live: LiveLaunch): FakePurchaseInput["launch"] {
  return {
    id: live.launch.id,
    slug: live.launch.slug,
    title: live.launch.title,
    priceCents: live.launch.priceCents ?? 1900,
    currency: live.launch.currency,
    deliveryType: live.launch.deliveryType ?? "url",
  }
}

export async function purchase(
  db: Db,
  root: string,
  live: LiveLaunch,
  input: Partial<Omit<FakePurchaseInput, "launch" | "appUrl">> = {},
) {
  const gateway = fakeGateway(root)
  return fakePurchase(
    gateway.store,
    gateway,
    {
      launch: launchInput(live),
      appUrl: TEST_APP_URL,
      email: input.email ?? `buyer-${Math.random().toString(36).slice(2, 8)}@example.test`,
      ...input,
    },
    deliverDirectly(db),
  )
}

export async function orderRow(db: Db, id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id))
  return row ?? null
}

export async function ordersOfLaunch(db: Db, launchId: string) {
  return db.select().from(orders).where(eq(orders.launchId, launchId)).orderBy(asc(orders.paidAt))
}

export async function activeGrant(db: Db, orderId: string) {
  const [row] = await db
    .select()
    .from(accessGrants)
    .where(and(eq(accessGrants.orderId, orderId), isNull(accessGrants.revokedAt)))
  return row ?? null
}

export async function entriesOf(db: Db, orderId: string) {
  return db.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId))
}

export async function eventsOf(db: Db, subjectId: string, type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.subjectId, subjectId), eq(events.type, type)))
}

export async function notificationsOf(db: Db, userId: string, type: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)))
}

export function sum(rows: readonly { amountCents: number }[]): number {
  return rows.reduce((total, row) => total + row.amountCents, 0)
}
