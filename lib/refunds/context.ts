import "server-only"

import { asc, eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { collabMembers, launches, orders } from "@/lib/db/schema"

/**
 * What the money notices about an order need (CLAUDE.md §19.31 "Emails"): the launch, its collab
 * and the members (who get `order.refunded` / `order.disputed`). Never the buyer's email for
 * members.
 */
export type OrderContext = {
  orderId: string
  launchId: string
  launchTitle: string
  collabId: string
  memberUserIds: string[]
}

export async function loadOrderContext(db: DbOrTx, orderId: string): Promise<OrderContext> {
  const [row] = await db
    .select({
      orderId: orders.id,
      launchId: launches.id,
      launchTitle: launches.title,
      collabId: launches.collabId,
    })
    .from(orders)
    .innerJoin(launches, eq(launches.id, orders.launchId))
    .where(eq(orders.id, orderId))
  if (!row) throw new Error(`order ${orderId} not found`)
  const members = await db
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, row.collabId))
    .orderBy(asc(collabMembers.userId))
  return { ...row, memberUserIds: members.map((member) => member.userId) }
}

/** The notification payload of an order notice (`orderPayload` in lib/notifications/types.ts). */
export function orderNoticePayload(
  context: OrderContext,
  money: { amountCents: number; currency: string },
) {
  return {
    collab_id: context.collabId,
    launch_id: context.launchId,
    launch_title: context.launchTitle.slice(0, 200),
    order_id: context.orderId,
    amount_cents: money.amountCents,
    currency: money.currency,
  }
}
