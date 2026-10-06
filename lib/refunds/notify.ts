import "server-only"

import { eq } from "drizzle-orm"
import { createElement } from "react"

import type { DbOrTx } from "@/lib/db/client"
import { orders, refunds } from "@/lib/db/schema"
import { sendEmail } from "@/lib/email/send"
import NotificationEmail from "@/lib/email/templates/notification"
import RefundConfirmationEmail, {
  refundConfirmationSubject,
} from "@/lib/email/templates/refund-confirmation"
import { env } from "@/lib/env"
import { formatMoney } from "@/lib/money"
import { notify } from "@/lib/notifications/notify"
import type { StepRunner } from "@/lib/payouts/steps"
import { absoluteUrl } from "@/lib/urls"

import { loadOrderContext, orderNoticePayload } from "./context"

/**
 * The `refunds-notify` job's work (CLAUDE.md §19.31 "Emails"), after a refund succeeded:
 * - `buyer`: the buyer's refund confirmation (refund-confirmation.tsx), a required email with the
 *   idempotency key `refund-confirmation:<refundId>`; a failure throws so the step is retried.
 * - `member:<userId>`: `order.refunded` to each collab member (required email, dedupe
 *   `order.refunded:<refundId>:<userId>`).
 * A refund that is no longer `succeeded` when the job runs (it failed in between) sends nothing.
 */
export async function sendRefundNotices(
  db: DbOrTx,
  refundId: string,
  step: StepRunner,
): Promise<{ sent: boolean; members: number }> {
  const state = await step.run("load", async () => {
    const [row] = await db
      .select({
        status: refunds.status,
        orderId: refunds.orderId,
        amountCents: refunds.amountCents,
        currency: refunds.currency,
      })
      .from(refunds)
      .where(eq(refunds.id, refundId))
    if (!row) return null
    const context = await loadOrderContext(db, row.orderId)
    return { ...row, ...context }
  })
  if (!state || state.status !== "succeeded") return { sent: false, members: 0 }

  await step.run("buyer", async () => {
    const [order] = await db
      .select({
        buyerEmail: orders.buyerEmail,
        gross: orders.amountGrossCents,
        refunded: orders.amountRefundedCents,
      })
      .from(orders)
      .where(eq(orders.id, state.orderId))
    if (!order) return
    await sendEmail({
      to: order.buyerEmail,
      subject: refundConfirmationSubject(state.launchTitle),
      react: createElement(RefundConfirmationEmail, {
        appName: env.APP_NAME,
        productTitle: state.launchTitle,
        amountCents: state.amountCents,
        currency: state.currency,
        full: order.refunded >= order.gross,
      }),
      tags: { template: "refund_confirmation" },
      idempotencyKey: `refund-confirmation:${refundId}`,
    })
  })

  const amount = formatMoney(state.amountCents, state.currency)
  for (const userId of state.memberUserIds) {
    await step.run(`member:${userId}`, async () => {
      await notify(
        {
          userId,
          type: "order.refunded",
          payload: orderNoticePayload(state, {
            amountCents: state.amountCents,
            currency: state.currency,
          }),
          dedupeKey: `order.refunded:${refundId}:${userId}`,
          email: {
            required: true,
            subject: `An order of “${state.launchTitle}” was refunded`,
            react: createElement(NotificationEmail, {
              appName: env.APP_NAME,
              heading: "An order was refunded",
              paragraphs: [
                `${amount} of an order of “${state.launchTitle}” was refunded to the buyer.`,
                "Your share of that amount comes off your earnings. If it was already paid out, it's taken back from your Stripe account or from your next payout.",
              ],
              action: { label: "See your earnings", url: absoluteUrl("/app/earnings") },
            }),
          },
        },
        db,
      )
    })
  }
  return { sent: true, members: state.memberUserIds.length }
}
