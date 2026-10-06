import "server-only"

import { isMutationBlockedByImpersonation } from "@/lib/auth/impersonation"
import { getDb } from "@/lib/db/client"
import { reportError } from "@/lib/observability"
import { isPayoutsReady } from "@/lib/payouts/readiness"

import {
  defaultPayoutCountry,
  findStripeAccountByUser,
  refreshAccountFromStripe,
  type StripeAccountRow,
} from "./connect"
import type { PayoutCountry } from "./countries"

export type PayoutsPageState = {
  account: StripeAccountRow | null
  /** Preselected country for the picker (only while there is no account). */
  defaultCountry: PayoutCountry | null
  /** Re-fetching from Stripe failed; the stored status is shown. */
  refreshFailed: boolean
}

/**
 * What the payouts pages show. Reaching Stripe's `return_url` does not mean onboarding finished,
 * so the account is re-fetched from Stripe on return (`returned`), and on every visit while it is
 * not payouts-ready in case a webhook is late. A failed re-fetch never breaks the page.
 */
export async function loadPayoutsPageState(
  userId: string,
  options: { returned: boolean },
): Promise<PayoutsPageState> {
  const db = getDb()
  const stored = await findStripeAccountByUser(db, userId)
  if (!stored) {
    return {
      account: null,
      defaultCountry: await defaultPayoutCountry(db, userId),
      refreshFailed: false,
    }
  }
  // No Stripe re-fetch (it writes) during an admin's read-only "view as" (CLAUDE.md §19.38).
  if (
    (!options.returned && isPayoutsReady(stored)) ||
    (await isMutationBlockedByImpersonation({ id: userId }))
  ) {
    return { account: stored, defaultCountry: null, refreshFailed: false }
  }
  try {
    const account = (await refreshAccountFromStripe(db, userId)) ?? stored
    return { account, defaultCountry: null, refreshFailed: false }
  } catch (error) {
    reportError(error, { tags: { page: "payouts", step: "refresh_account" } })
    return { account: stored, defaultCountry: null, refreshFailed: true }
  }
}
