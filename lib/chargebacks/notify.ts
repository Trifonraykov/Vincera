import "server-only"

import { eq } from "drizzle-orm"
import { createElement } from "react"

import type { DbOrTx } from "@/lib/db/client"
import { chargebacks } from "@/lib/db/schema"
import DisputeOpenedEmail, { disputeOpenedSubject } from "@/lib/email/templates/dispute-opened"
import NotificationEmail from "@/lib/email/templates/notification"
import { env } from "@/lib/env"
import { adminUserIds } from "@/lib/launches/queries"
import { formatMoney } from "@/lib/money"
import { notify } from "@/lib/notifications/notify"
import { reportError } from "@/lib/observability"
import { loadOrderContext, orderNoticePayload } from "@/lib/refunds/context"
import { absoluteUrl } from "@/lib/urls"

/**
 * The notices when a chargeback opens (§9 "notify admin"; CLAUDE.md §19.31 "Emails"): each member
 * gets `order.disputed` (a required email, dedupe `order.disputed:<chargebackId>:<userId>`), each
 * active admin `admin.chargeback_opened` (dispute-opened.tsx, dedupe
 * `admin.chargeback_opened:<chargebackId>:<adminId>`). Runs after the webhook's commit; one
 * recipient's failure is reported and does not stop the others.
 */
export async function notifyChargebackOpened(
  db: DbOrTx,
  chargebackId: string,
): Promise<{ members: number; admins: number }> {
  const [chargeback] = await db.select().from(chargebacks).where(eq(chargebacks.id, chargebackId))
  if (!chargeback) throw new Error(`chargeback ${chargebackId} not found`)
  const context = await loadOrderContext(db, chargeback.orderId)
  const payload = orderNoticePayload(context, {
    amountCents: chargeback.amountCents,
    currency: chargeback.currency,
  })
  const amount = formatMoney(chargeback.amountCents, chargeback.currency)
  let members = 0
  let admins = 0

  for (const userId of context.memberUserIds) {
    try {
      await notify(
        {
          userId,
          type: "order.disputed",
          payload,
          dedupeKey: `order.disputed:${chargebackId}:${userId}`,
          email: {
            required: true,
            subject: `A buyer disputed an order of “${context.launchTitle}”`,
            react: createElement(NotificationEmail, {
              appName: env.APP_NAME,
              heading: "A buyer opened a chargeback",
              paragraphs: [
                `A buyer's bank disputed ${amount} paid for “${context.launchTitle}”.`,
                "Your share of this order is held back from payouts until the dispute closes. If the platform wins it, the money is released; if not, your share of the order is taken back.",
              ],
              action: { label: "See your earnings", url: absoluteUrl("/app/earnings") },
            }),
          },
        },
        db,
      )
      members += 1
    } catch (error) {
      reportError(error, { tags: { area: "chargebacks", notice: "order.disputed" } })
    }
  }

  for (const adminId of await adminUserIds(db)) {
    try {
      await notify(
        {
          userId: adminId,
          type: "admin.chargeback_opened",
          payload: { ...payload, chargeback_id: chargebackId },
          dedupeKey: `admin.chargeback_opened:${chargebackId}:${adminId}`,
          email: {
            subject: disputeOpenedSubject(context.launchTitle),
            react: createElement(DisputeOpenedEmail, {
              appName: env.APP_NAME,
              productTitle: context.launchTitle,
              amountCents: chargeback.amountCents,
              currency: chargeback.currency,
              reason: chargeback.reason,
              adminUrl: absoluteUrl("/admin/payouts"),
            }),
          },
        },
        db,
      )
      admins += 1
    } catch (error) {
      reportError(error, { tags: { area: "chargebacks", notice: "admin.chargeback_opened" } })
    }
  }
  return { members, admins }
}
