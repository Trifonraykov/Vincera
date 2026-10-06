import { z } from "zod"

import type { RefundRequestReason, RefundRequestStatus } from "@/lib/db/schema/enums"
import { REFUND_REQUEST_WINDOW_DAYS, type RefundRequestRefusal } from "@/lib/auth/authz"

/** Buyer refund requests (client-safe; `/access/[token]/refund`, CLAUDE.md §19.38). */

export const REFUND_REQUEST_REASONS = [
  "not_as_described",
  "not_working",
  "not_received",
  "accidental",
  "other",
] as const satisfies readonly RefundRequestReason[]

export const REFUND_REASON_LABELS: Record<RefundRequestReason, string> = {
  not_as_described: "It isn't what the page described",
  not_working: "It doesn't work",
  not_received: "I didn't get it",
  accidental: "I bought it by mistake",
  other: "Something else",
}

export const REFUND_STATUS_LABELS: Record<RefundRequestStatus, string> = {
  pending: "Waiting for a decision",
  approved: "Approved",
  declined: "Declined",
}

export const REFUND_MESSAGE_MAX = 1000
export const DECISION_NOTE_MAX = 500

const optionalText = (max: number, tooLong: string) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") return value
      const text = value.replace(/\r\n?/g, "\n").trim()
      return text === "" ? undefined : text
    },
    z.string().max(max, { error: tooLong }).optional(),
  )

export const refundRequestFormSchema = z.object({
  reason: z.enum(REFUND_REQUEST_REASONS, { error: "Pick the reason that fits best." }),
  message: optionalText(
    REFUND_MESSAGE_MAX,
    `Keep it under ${REFUND_MESSAGE_MAX.toLocaleString("en-US")} characters.`,
  ),
})

export type RefundRequestForm = z.output<typeof refundRequestFormSchema>

export const approveRefundRequestSchema = z.object({
  requestId: z.uuid({ error: "That request is not valid." }),
  note: optionalText(DECISION_NOTE_MAX, `Keep the note under ${DECISION_NOTE_MAX} characters.`),
})

export const declineRefundRequestSchema = z.object({
  requestId: z.uuid({ error: "That request is not valid." }),
  note: z.preprocess(
    (value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : value),
    z
      .string({ error: "Tell the buyer why (they get this note by email)." })
      .min(1, { error: "Tell the buyer why (they get this note by email)." })
      .max(DECISION_NOTE_MAX, { error: `Keep the note under ${DECISION_NOTE_MAX} characters.` }),
  ),
})

/** Plain-language reasons a buyer cannot ask (`refundRequestRefusal`). */
export const REFUND_REFUSAL_MESSAGES: Record<RefundRequestRefusal, string> = {
  already_requested: "You've already asked for a refund for this purchase.",
  revoked: "This purchase was already refunded or reversed.",
  disputed:
    "There's an open payment dispute with your bank for this purchase, so we can't take a refund request now.",
  nothing_to_refund: "This purchase was already refunded in full.",
  window_closed: `Refund requests are possible for ${REFUND_REQUEST_WINDOW_DAYS} days after the purchase, and that time has passed.`,
}

export function refundRequestPath(token: string): string {
  return `/access/${token}/refund`
}
