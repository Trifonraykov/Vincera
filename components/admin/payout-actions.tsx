"use client"

import { Ban, Play, RotateCcw } from "lucide-react"

import {
  cancelStuckRefundAction,
  retryStuckRefundAction,
  startPayoutRunAction,
} from "@/lib/admin/actions"

import { ActionButton, ConfirmButton } from "./action-kit"

/** /admin/payouts actions (Phase 6; CLAUDE.md §19.39). */

export function RunPayoutsButton() {
  return (
    <ConfirmButton
      run={() => startPayoutRunAction({})}
      label="Run payouts now"
      icon={<Play aria-hidden="true" />}
      title="Run a payout batch now?"
      description="Everyone with an available balance of at least the minimum is paid, including balances whose last transfer failed. Nothing is paid twice: entries already in a transfer are skipped."
      confirmLabel="Run payouts"
      variant="default"
      success="Payout run started."
    />
  )
}

export function RetryRefundButton({ refundId }: { refundId: string }) {
  return (
    <ActionButton
      run={() => retryStuckRefundAction({ refundId })}
      label="Retry at Stripe"
      icon={<RotateCcw aria-hidden="true" />}
      success="Sent to Stripe again."
      variant="outline"
    />
  )
}

export function CancelRefundButton({ refundId }: { refundId: string }) {
  return (
    <ConfirmButton
      run={() => cancelStuckRefundAction({ refundId })}
      label="Cancel"
      icon={<Ban aria-hidden="true" />}
      title="Cancel this refund?"
      description="Only cancel it when Stripe's dashboard shows no refund for this payment: the order stays as it is and the buyer gets nothing back."
      confirmLabel="Cancel the refund"
      confirmVariant="destructive"
      success="The refund is cancelled."
    />
  )
}
