/**
 * Plain-language text for a failed payout's or reversal's `failure_code` (Stripe's error codes, or
 * our own). Client-safe: the earnings pages and the payout-failed email share it.
 */
export function payoutFailureMessage(code: string | null | undefined): string {
  switch (code) {
    case "balance_insufficient":
      return "The platform's Stripe balance was too low at the time. We'll retry with the next payout; you don't need to do anything."
    case "resource_missing":
      return "Your Stripe account could not be found. Open your payout settings to set it up again."
    case "invalid_request":
      return "Your Stripe account can't receive transfers right now. Open your payout settings to see what Stripe needs."
    default:
      return "Open your payout settings to see whether Stripe needs anything from you."
  }
}

/** Short status labels for a transfer row. */
export const TRANSFER_STATUS_LABELS = {
  pending: "Sending",
  created: "Sent",
  failed: "Failed",
  reversed: "Reversed",
  partially_reversed: "Partly reversed",
} as const
