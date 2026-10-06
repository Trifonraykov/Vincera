import "server-only"

import { createElement } from "react"

import type { JobStep } from "@/inngest/define"
import { agreementDate } from "@/lib/agreements/template-v1"
import type { DbOrTx } from "@/lib/db/client"
import type { DeliveryType } from "@/lib/db/schema/enums"
import { accessPath } from "@/lib/delivery/token"
import BuyerReceiptEmail, { buyerReceiptSubject } from "@/lib/email/templates/buyer-receipt"
import NotificationEmail from "@/lib/email/templates/notification"
import SaleMadeEmail, { saleMadeSubject } from "@/lib/email/templates/sale-made"
import { sendEmail } from "@/lib/email/send"
import { env } from "@/lib/env"
import { loadLaunchMembers } from "@/lib/launches/queries"
import { formatMoney } from "@/lib/money"
import { notify } from "@/lib/notifications/notify"
import { reportError } from "@/lib/observability"
import { clip } from "@/lib/proposals/queries"
import { absoluteUrl } from "@/lib/urls"

import { remainingLicenseKeys } from "./fulfil"
import {
  loadMemberSplits,
  loadOrderSummary,
  orderHasLicenseKey,
  orderReference,
  type OrderSummary,
} from "./queries"

/**
 * `orders-fulfilled` (CLAUDE.md §19.31 "Emails", §19.34), after the order commits:
 *
 * 1. `buyer-receipt`: the buyer's receipt with the access link (required: a failure throws so the
 *    job retries; idempotency key `buyer-receipt:<orderId>` at Resend);
 * 2. `sale-made`: `sale.made` to each member (dedupe `sale.made:<orderId>:<userId>`);
 * 3. `license-keys`: for license-key launches, `launch.license_keys_low` to both members when 5 or
 *    fewer keys are left (dedupe per remaining count), and an alert (Sentry) when the order got no
 *    key because the launch ran out.
 *
 * Each part is a job step, so a retry repeats only what failed.
 */

export const LICENSE_KEYS_LOW_THRESHOLD = 5

const DELIVERY_TEXT: Record<DeliveryType, string> = {
  file: "Download your files from your access page.",
  license_key: "Your license key is on your access page.",
  url: "Open it from your access page.",
}

export type OrderEmailsResult =
  | { skipped: "not_found" }
  | { receipt: true; saleNotices: number; keysLow: number | null; outOfStock: boolean }

export async function sendOrderEmails(
  database: DbOrTx,
  orderId: string,
  step: JobStep,
): Promise<OrderEmailsResult> {
  const order = await loadOrderSummary(database, orderId)
  if (!order) return { skipped: "not_found" }
  const members = await loadLaunchMembers(database, order.collabId)

  await step.run("buyer-receipt", async () => {
    await sendBuyerReceipt(order, members)
    return true
  })

  const saleNotices = await step.run("sale-made", async () => notifySale(database, order, members))

  const keys = await step.run("license-keys", async () => {
    if (order.deliveryType !== "license_key") return { keysLow: null, outOfStock: false }
    const outOfStock = !(await orderHasLicenseKey(database, order.id))
    if (outOfStock) {
      // The admin alert (§19.31): the buyer paid but there was no key to give them.
      reportError(new Error("License keys ran out: an order has no key"), {
        tags: { area: "checkout", alert: "license_keys_out" },
        extra: { orderId: order.id, launchId: order.launchId },
      })
    }
    const remaining = await remainingLicenseKeys(database, order.launchId)
    if (remaining > LICENSE_KEYS_LOW_THRESHOLD) return { keysLow: null, outOfStock }
    for (const member of members) {
      await notify(
        {
          userId: member.userId,
          type: "launch.license_keys_low",
          payload: {
            collab_id: order.collabId,
            launch_id: order.launchId,
            launch_title: clip(order.launchTitle, 200),
            remaining,
          },
          dedupeKey: `launch.license_keys_low:${order.launchId}:${remaining}`,
          email: {
            subject:
              remaining === 0
                ? `“${clip(order.launchTitle, 200)}” is out of license keys`
                : `Only ${remaining} license ${remaining === 1 ? "key" : "keys"} left for “${clip(order.launchTitle, 200)}”`,
            react: createElement(NotificationEmail, {
              appName: env.APP_NAME,
              heading:
                remaining === 0
                  ? "You're out of license keys"
                  : "You're running out of license keys",
              paragraphs: [
                remaining === 0
                  ? outOfStock
                    ? `A buyer paid for “${order.launchTitle}” but there was no key left to give them. Add keys now: they get one as soon as they open their access page.`
                    : `The last license key for “${order.launchTitle}” was just sold. New buyers see “Sold out” until you add more.`
                  : `${remaining} license ${remaining === 1 ? "key is" : "keys are"} left for “${order.launchTitle}”. Add more so buyers don't see “Sold out”.`,
              ],
              action: {
                label: "Add license keys",
                url: absoluteUrl(`/app/collabs/${order.collabId}/launch`),
              },
            }),
          },
        },
        database,
      )
    }
    return { keysLow: remaining, outOfStock }
  })

  return { receipt: true, saleNotices, keysLow: keys.keysLow, outOfStock: keys.outOfStock }
}

type Member = Awaited<ReturnType<typeof loadLaunchMembers>>[number]

function byLine(members: readonly Member[]): string | null {
  const names = members.map((member) => member.name)
  return names.length > 0 ? `by ${names.join(" × ")}` : null
}

async function sendBuyerReceipt(order: OrderSummary, members: readonly Member[]): Promise<void> {
  const total = formatMoney(order.amountGrossCents, order.currency)
  await sendEmail({
    to: order.buyerEmail,
    subject: buyerReceiptSubject(order.launchTitle),
    react: createElement(BuyerReceiptEmail, {
      appName: env.APP_NAME,
      productTitle: order.launchTitle,
      byLine: byLine(members),
      total,
      vat: order.taxCents > 0 ? formatMoney(order.taxCents, order.currency) : null,
      discount:
        order.discountCents > 0 ? `−${formatMoney(order.discountCents, order.currency)}` : null,
      paidOn: agreementDate(order.paidAt),
      reference: orderReference(order.id),
      deliveryText: order.deliveryType ? DELIVERY_TEXT[order.deliveryType] : "",
      accessUrl: order.accessToken ? absoluteUrl(accessPath(order.accessToken)) : null,
    }),
    tags: { template: "buyer_receipt" },
    idempotencyKey: `buyer-receipt:${order.id}`,
  })
}

async function notifySale(
  database: DbOrTx,
  order: OrderSummary,
  members: readonly Member[],
): Promise<number> {
  const splits = await loadMemberSplits(database, order.collabId)
  const total = formatMoney(order.amountGrossCents, order.currency)
  const creator = members.find((member) => member.role === "creator")
  let sent = 0
  for (const member of members) {
    const attributionText = order.trackedLinkId
      ? member.role === "creator"
        ? "through your tracked link"
        : `through ${creator?.name ?? "the creator"}'s link`
      : null
    const result = await notify(
      {
        userId: member.userId,
        type: "sale.made",
        payload: {
          collab_id: order.collabId,
          launch_id: order.launchId,
          launch_title: clip(order.launchTitle, 200),
          order_id: order.id,
          amount_cents: order.amountGrossCents,
          currency: order.currency,
        },
        dedupeKey: `sale.made:${order.id}:${member.userId}`,
        email: {
          subject: saleMadeSubject(clip(order.launchTitle, 200), total),
          react: createElement(SaleMadeEmail, {
            appName: env.APP_NAME,
            productTitle: order.launchTitle,
            total,
            splitPct: splits.get(member.userId) ?? 0,
            attributionText,
            holdDays: env.HOLD_DAYS,
            earningsUrl: absoluteUrl("/app/earnings"),
          }),
        },
      },
      database,
    )
    if (!result.duplicate) sent += 1
  }
  return sent
}
