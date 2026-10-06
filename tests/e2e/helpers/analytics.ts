import { randomBytes } from "node:crypto"

import { newId } from "@/lib/ids"

import { withE2eDb } from "./db"

/**
 * Analytics, links and refund requests in the browser (CLAUDE.md §19.41): a paid order with an
 * access grant written straight to the database (the purchase itself has its own spec), and reads
 * of what the pages wrote.
 */

/** The member emails `insertLiveKeyLaunch` uses (from its slug's tag). */
export function memberEmails(slug: string): { creator: string; builder: string } {
  const tag = slug.split("-").at(-1) ?? ""
  return { creator: `e2e-creator-${tag}@example.com`, builder: `e2e-builder-${tag}@example.com` }
}

/** A paid €19 order of the launch (paid an hour ago) with a working access grant. */
export async function insertPaidOrder(
  launchId: string,
): Promise<{ orderId: string; token: string }> {
  const orderId = newId()
  const token = randomBytes(32).toString("base64url")
  const buyer = `e2e-buyer-${randomBytes(4).toString("hex")}@example.com`
  await withE2eDb(async (pool) => {
    await pool.query(
      `INSERT INTO orders (id, launch_id, buyer_email, stripe_checkout_session_id,
         amount_gross_cents, tax_cents, currency, status, paid_at)
       VALUES ($1, $2, $3, $4, 1900, 330, 'eur', 'paid', now() - interval '1 hour')`,
      [orderId, launchId, buyer, `cs_e2e_${randomBytes(6).toString("hex")}`],
    )
    await pool.query("INSERT INTO access_grants (id, order_id, token) VALUES ($1, $2, $3)", [
      newId(),
      orderId,
      token,
    ])
  })
  return { orderId, token }
}

export async function refundRequestOf(
  orderId: string,
): Promise<{ status: string; reason: string; amount_cents: number } | null> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ status: string; reason: string; amount_cents: number }>(
      "SELECT status::text, reason::text, amount_cents FROM refund_requests WHERE order_id = $1",
      [orderId],
    )
    return rows[0] ?? null
  })
}

export async function linksOf(
  launchId: string,
): Promise<{ label: string | null; discount_code: string | null; disabled: boolean }[]> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<{
      label: string | null
      discount_code: string | null
      disabled: boolean
    }>(
      `SELECT label, discount_code, disabled_at IS NOT NULL AS disabled
       FROM tracked_links WHERE launch_id = $1 ORDER BY created_at`,
      [launchId],
    )
    return rows
  })
}
