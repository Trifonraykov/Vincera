import "server-only"

import { and, eq, isNull, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { accessGrants, collabMembers, launches, licenseKeys, orders } from "@/lib/db/schema"
import type { DeliveryType } from "@/lib/db/schema/enums"

/** The order with its launch, for emails and the success page. */
export type OrderSummary = {
  id: string
  launchId: string
  collabId: string
  slug: string
  launchTitle: string
  deliveryType: DeliveryType | null
  buyerEmail: string
  amountGrossCents: number
  taxCents: number
  discountCents: number
  currency: string
  status: (typeof orders.$inferSelect)["status"]
  paidAt: Date
  trackedLinkId: string | null
  attribution: (typeof orders.$inferSelect)["attribution"]
  /** The working access token, or null when access was revoked (refund, lost chargeback). */
  accessToken: string | null
}

const summaryColumns = {
  id: orders.id,
  launchId: orders.launchId,
  collabId: launches.collabId,
  slug: launches.slug,
  launchTitle: launches.title,
  deliveryType: launches.deliveryType,
  buyerEmail: orders.buyerEmail,
  amountGrossCents: orders.amountGrossCents,
  taxCents: orders.taxCents,
  discountCents: orders.discountCents,
  currency: orders.currency,
  status: orders.status,
  paidAt: orders.paidAt,
  trackedLinkId: orders.trackedLinkId,
  attribution: orders.attribution,
  accessToken: accessGrants.token,
}

export async function loadOrderSummary(
  database: DbOrTx,
  orderId: string,
): Promise<OrderSummary | null> {
  const [row] = await database
    .select(summaryColumns)
    .from(orders)
    .innerJoin(launches, eq(launches.id, orders.launchId))
    .leftJoin(
      accessGrants,
      and(eq(accessGrants.orderId, orders.id), isNull(accessGrants.revokedAt)),
    )
    .where(eq(orders.id, orderId))
  return row ?? null
}

/** The order a Checkout Session created (the success page), or null while it is not there yet. */
export async function findOrderBySession(
  database: DbOrTx,
  sessionId: string,
): Promise<OrderSummary | null> {
  const [row] = await database
    .select(summaryColumns)
    .from(orders)
    .innerJoin(launches, eq(launches.id, orders.launchId))
    .leftJoin(
      accessGrants,
      and(eq(accessGrants.orderId, orders.id), isNull(accessGrants.revokedAt)),
    )
    .where(eq(orders.stripeCheckoutSessionId, sessionId))
  return row ?? null
}

/** The members' signed splits (for the sale notice). */
export async function loadMemberSplits(
  database: DbOrTx,
  collabId: string,
): Promise<Map<string, number>> {
  const rows = await database
    .select({ userId: collabMembers.userId, splitPct: collabMembers.splitPct })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, collabId))
  return new Map(rows.map((row) => [row.userId, row.splitPct]))
}

/** Whether the order holds a license key. */
export async function orderHasLicenseKey(database: DbOrTx, orderId: string): Promise<boolean> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(licenseKeys)
    .where(eq(licenseKeys.orderId, orderId))
  return (row?.n ?? 0) > 0
}

/**
 * A short reference buyers can quote to support: the order id's last 8 hex characters (a UUIDv7
 * starts with its timestamp, so the start would repeat for orders made the same minute).
 */
export function orderReference(orderId: string): string {
  return orderId.replaceAll("-", "").slice(-8).toUpperCase()
}
