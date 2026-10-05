import type { StripeCapabilityStatus } from "@/lib/db/schema"

/**
 * Payouts readiness (§7.2, §12, §19.10). Pure and client-safe.
 *
 * "Payouts ready" = `payouts_enabled` AND the `transfers` capability is `active`. It gates signing
 * an agreement ("both parties have payouts_enabled" in §12 means payouts-ready) and the payout job.
 * `charges_enabled` is irrelevant: connected accounts only receive transfers.
 */

/** The `stripe_accounts` fields readiness depends on. A full row satisfies it. */
export type PayoutsReadinessInput = {
  payoutsEnabled: boolean
  transfersCapability: StripeCapabilityStatus
}

export function isPayoutsReady(account: PayoutsReadinessInput | null | undefined): boolean {
  return account != null && account.payoutsEnabled && account.transfersCapability === "active"
}

/**
 * Where a user stands with payouts: no Stripe account yet, an account that cannot receive
 * transfers yet (onboarding unfinished, verification pending or restricted), or ready.
 */
export type PayoutsState = "none" | "pending" | "ready"

export function payoutsStateOf(account: PayoutsReadinessInput | null | undefined): PayoutsState {
  if (account == null) return "none"
  return isPayoutsReady(account) ? "ready" : "pending"
}

/** The `stripe_accounts` fields the payouts pages describe. A full row satisfies it. */
export type PayoutsStatusInput = PayoutsReadinessInput & {
  detailsSubmitted: boolean
  requirementsCurrentlyDue: readonly string[]
  disabledReason: string | null
}

/**
 * What the payouts pages show (§12 `/onboarding/payouts`, `/app/settings/payouts`):
 * - `not_started`: no connected account yet.
 * - `action_required`: Stripe needs something from the user (onboarding unfinished, or new
 *   requirements); `dueCount` is how many fields.
 * - `verifying`: everything submitted, Stripe is still checking it.
 * - `restricted`: Stripe rejected the account (`disabled_reason` `rejected.*`); only Stripe
 *   support can help.
 * - `ready`: payouts-ready. `dueCount` > 0 means Stripe will need more information soon.
 */
export type PayoutsStatus =
  | { kind: "not_started" }
  | { kind: "action_required"; dueCount: number }
  | { kind: "verifying" }
  | { kind: "restricted" }
  | { kind: "ready"; dueCount: number }

export function payoutsStatusOf(account: PayoutsStatusInput | null | undefined): PayoutsStatus {
  if (account == null) return { kind: "not_started" }
  const dueCount = account.requirementsCurrentlyDue.length
  if (isPayoutsReady(account)) return { kind: "ready", dueCount }
  if (account.disabledReason?.startsWith("rejected.")) return { kind: "restricted" }
  if (!account.detailsSubmitted || dueCount > 0) return { kind: "action_required", dueCount }
  return { kind: "verifying" }
}
