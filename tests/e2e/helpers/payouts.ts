import { randomBytes } from "node:crypto"

import { newId } from "@/lib/ids"

import { withE2eDb } from "./db"
import { insertBuildingCollab } from "./launches"

/**
 * Earnings and payouts in the browser (CLAUDE.md §19.35): a live launch with one paid order whose
 * ledger is already posted, written straight to the database (checkout and the ledger have their
 * own specs and tests). €50 sale, no VAT, Stripe fee €1: platform €4.90, creator (60 %) €26.46,
 * builder (40 %) €17.64, available 14 days after `paidAt` (HOLD_DAYS).
 */

export const SALE = {
  grossCents: 5000,
  creatorCents: 2646,
  builderCents: 1764,
  buyerEmail: "e2e-buyer@example.com",
} as const

const HOLD_MS = 14 * 24 * 60 * 60 * 1000

export async function insertPaidSale(input: {
  creatorUserId: string
  builderUserId: string
  paidAt: Date
}): Promise<{ orderId: string; launchId: string }> {
  const collabId = await insertBuildingCollab(
    input.creatorUserId,
    input.builderUserId,
    "Budget planner",
  )
  return withE2eDb(async (pool) => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const launchId = newId()
      const orderId = newId()
      const tag = randomBytes(6).toString("hex")
      await client.query("UPDATE collabs SET stage = 'live' WHERE id = $1", [collabId])
      await client.query(
        `INSERT INTO launches (id, collab_id, slug, title, price_cents, delivery_type,
           delivery_config, status, submitted_at, went_live_at)
         VALUES ($1, $2, $3, 'Budget planner', $4, 'url',
           '{"type":"url","url":"https://example.com/app"}', 'live', $5, $5)`,
        [launchId, collabId, `budget-planner-${tag}`, SALE.grossCents, input.paidAt],
      )
      await client.query(
        `INSERT INTO orders (id, launch_id, buyer_email, stripe_checkout_session_id,
           stripe_payment_intent_id, stripe_charge_id, stripe_balance_transaction_id,
           amount_gross_cents, tax_cents, stripe_fee_cents, paid_at, ledger_posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 100, $9, $9)`,
        [
          orderId,
          launchId,
          SALE.buyerEmail,
          `cs_e2e_${tag}`,
          `pi_e2e_${tag}`,
          `ch_e2e_${tag}`,
          `txn_e2e_${tag}`,
          SALE.grossCents,
          input.paidAt,
        ],
      )
      const availableAt = new Date(input.paidAt.getTime() + HOLD_MS)
      const lines: [string, string | null, number][] = [
        ["stripe_fee", null, 100],
        ["platform_fee", null, 490],
        ["creator_share", input.creatorUserId, SALE.creatorCents],
        ["builder_share", input.builderUserId, SALE.builderCents],
      ]
      for (const [account, userId, cents] of lines) {
        await client.query(
          `INSERT INTO ledger_entries (id, order_id, user_id, account, amount_cents, currency, available_at)
           VALUES ($1, $2, $3, $4, $5, 'eur', $6)`,
          [newId(), orderId, userId, account, cents, availableAt],
        )
      }
      await client.query("COMMIT")
      return { orderId, launchId }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  })
}

export type TransferState = { amount_cents: number; status: string; stripe_transfer_id: string }

export async function transfersOf(userId: string): Promise<TransferState[]> {
  return withE2eDb(async (pool) => {
    const { rows } = await pool.query<TransferState>(
      `SELECT amount_cents, status, stripe_transfer_id FROM transfers WHERE user_id = $1
       ORDER BY created_at`,
      [userId],
    )
    return rows
  })
}
