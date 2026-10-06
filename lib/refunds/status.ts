import type { OrderStatus } from "@/lib/db/schema/enums"

/**
 * Order and refund status rules shared by refunds and chargebacks (§9; CLAUDE.md §19.31, §19.35).
 * Pure and client-safe.
 */

/** Our `refund_status` for Stripe's refund `status` (unknown future values stay `pending`). */
export type MappedRefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled"

export function mapStripeRefundStatus(status: string | null | undefined): MappedRefundStatus {
  switch (status) {
    case "requires_action":
    case "succeeded":
    case "failed":
    case "canceled":
      return status
    default:
      return "pending"
  }
}

/** Failed or canceled: the money stayed with the platform. */
export function isFailedRefundStatus(status: MappedRefundStatus): boolean {
  return status === "failed" || status === "canceled"
}

/**
 * Whether a stored status may move to `next`. Stripe sends events out of order, so an older
 * `pending` must not undo `succeeded` / `failed`; a succeeded refund can still fail later (card
 * refunds can fail days after), and a failed one never comes back.
 */
export function refundStatusMayMove(
  current: MappedRefundStatus,
  next: MappedRefundStatus,
): boolean {
  if (current === next) return false
  if (next === "pending" || next === "requires_action") {
    return current === "pending" || current === "requires_action"
  }
  if (isFailedRefundStatus(current)) return false
  return true
}

/** The order's status from its refunded amount (`orders_refunded_status` check), unless disputed. */
export function orderStatusFor(input: {
  grossCents: number
  refundedCents: number
  disputed: boolean
}): OrderStatus {
  if (input.disputed) return "disputed"
  if (input.refundedCents <= 0) return "paid"
  if (input.refundedCents >= input.grossCents) return "refunded"
  return "partially_refunded"
}

/** A chargeback's state for Stripe's dispute `status` (§19.35). */
export function chargebackOutcome(status: string): "open" | "won" | "lost" {
  switch (status) {
    case "won":
    // An inquiry (`warning_*`) that closed without becoming a chargeback, or a prevented one.
    case "warning_closed":
    case "prevented":
      return "won"
    case "lost":
      return "lost"
    default:
      return "open"
  }
}
