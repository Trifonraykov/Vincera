import "server-only"

import { and, asc, eq, isNull, sql } from "drizzle-orm"

import type { DbOrTx, Tx } from "@/lib/db/client"
import { licenseKeys } from "@/lib/db/schema"

/**
 * Small order helpers shared by fulfilment (`fulfil.ts`), the buyer's access page and the success
 * page. They live apart from `fulfil.ts` on purpose: that module enqueues jobs, so importing it
 * pulls the whole job registry (every job's code, PDF and email rendering included) into a page's
 * module graph (CLAUDE.md §19.36). Pages import from here.
 */

/** Payment states that are fulfilled: paid, or nothing to pay (a 100% discount). */
export function isFulfillable(paymentStatus: string): boolean {
  return paymentStatus === "paid" || paymentStatus === "no_payment_required"
}

/**
 * Give the order the oldest unassigned key of the launch. `FOR UPDATE SKIP LOCKED`: two orders
 * completing at once never take the same key (the second skips the locked row and takes the next,
 * or finds none). False when the launch is out of keys.
 */
export async function assignLicenseKey(
  tx: Tx,
  launchId: string,
  orderId: string,
  at: Date,
): Promise<boolean> {
  const [key] = await tx
    .select({ id: licenseKeys.id })
    .from(licenseKeys)
    .where(and(eq(licenseKeys.launchId, launchId), isNull(licenseKeys.orderId)))
    .orderBy(asc(licenseKeys.createdAt), asc(licenseKeys.id))
    .limit(1)
    .for("update", { skipLocked: true })
  if (!key) return false
  const updated = await tx
    .update(licenseKeys)
    .set({ orderId, assignedAt: at })
    .where(and(eq(licenseKeys.id, key.id), isNull(licenseKeys.orderId)))
    .returning({ id: licenseKeys.id })
  return updated.length > 0
}

/** Unassigned keys left for a launch. */
export async function remainingLicenseKeys(database: DbOrTx, launchId: string): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(licenseKeys)
    .where(and(eq(licenseKeys.launchId, launchId), isNull(licenseKeys.orderId)))
  return row?.n ?? 0
}
