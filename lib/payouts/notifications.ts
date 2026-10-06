import "server-only"

import { eq, sql } from "drizzle-orm"
import { createElement } from "react"

import type { DbOrTx } from "@/lib/db/client"
import { ledgerEntries, transfers } from "@/lib/db/schema"
import NotificationEmail from "@/lib/email/templates/notification"
import PayoutSentEmail, { payoutSentSubject } from "@/lib/email/templates/payout-sent"
import { env } from "@/lib/env"
import { formatMoney } from "@/lib/money"
import { notify } from "@/lib/notifications/notify"
import { absoluteUrl } from "@/lib/urls"

import { payoutFailureMessage } from "./failure-codes"

/**
 * The payout notices (CLAUDE.md §19.31 "Emails"): `payout.sent` (payout-sent.tsx) and
 * `payout.failed` (notification.tsx), both required emails, sent by the payout job in its own step
 * after the transfer's outcome committed. Dedupe keys `payout.sent:<transferId>` /
 * `payout.failed:<transferId>` make a retried step send nothing twice.
 */
export async function notifyPayoutOutcome(
  db: DbOrTx,
  transferId: string,
): Promise<{ notified: "sent" | "failed" | "none" }> {
  const [transfer] = await db.select().from(transfers).where(eq(transfers.id, transferId))
  if (!transfer) throw new Error(`transfer ${transferId} not found`)
  const money = { amount_cents: transfer.amountCents, currency: transfer.currency }

  if (transfer.status === "failed") {
    await notify(
      {
        userId: transfer.userId,
        type: "payout.failed",
        payload: { transfer_id: transfer.id, ...money },
        dedupeKey: `payout.failed:${transfer.id}`,
        email: {
          required: true,
          subject: "We couldn't send your payout",
          react: createElement(NotificationEmail, {
            appName: env.APP_NAME,
            heading: "We couldn't send your payout",
            paragraphs: [
              `Stripe refused a payout of ${formatMoney(transfer.amountCents, transfer.currency)} to your account. ${payoutFailureMessage(transfer.failureCode)}`,
              "The money is safe: it stays in your balance and goes out with the next daily payout once the problem is fixed.",
            ],
            action: {
              label: "Check your payout settings",
              url: absoluteUrl("/app/settings/payouts"),
            },
          }),
        },
      },
      db,
    )
    return { notified: "failed" }
  }

  if (transfer.status === "pending") return { notified: "none" }

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transferId, transfer.id))
  await notify(
    {
      userId: transfer.userId,
      type: "payout.sent",
      payload: { transfer_id: transfer.id, ...money },
      dedupeKey: `payout.sent:${transfer.id}`,
      email: {
        required: true,
        subject: payoutSentSubject(transfer.amountCents, transfer.currency),
        react: createElement(PayoutSentEmail, {
          appName: env.APP_NAME,
          amountCents: transfer.amountCents,
          currency: transfer.currency,
          entryCount: count?.n ?? 0,
          payoutsUrl: absoluteUrl("/app/earnings/payouts"),
        }),
      },
    },
    db,
  )
  return { notified: "sent" }
}
