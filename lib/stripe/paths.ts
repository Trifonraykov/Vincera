/**
 * The two pages where users set up payouts (§7.2, §12), and the URLs Stripe sends them back to
 * from hosted onboarding. Client-safe.
 *
 * - `returnPath`: Stripe's `return_url`. Reaching it does not mean onboarding is complete, so
 *   the page re-fetches the account (`?return=1`).
 * - `refreshPath`: Stripe's `refresh_url`, opened when a link expired or was already used; a
 *   route handler there creates a fresh link and redirects to it.
 */
export const PAYOUTS_PAGES = {
  onboarding: {
    page: "/onboarding/payouts",
    returnPath: "/onboarding/payouts?return=1",
    refreshPath: "/onboarding/payouts/refresh",
  },
  settings: {
    page: "/app/settings/payouts",
    returnPath: "/app/settings/payouts?return=1",
    refreshPath: "/app/settings/payouts/refresh",
  },
} as const

export type PayoutsPage = keyof typeof PAYOUTS_PAGES

export const PAYOUTS_PAGE_KINDS = Object.keys(PAYOUTS_PAGES) as PayoutsPage[]

/** `?error=` codes the payouts pages explain. */
export const PAYOUTS_ERROR_MESSAGES = {
  link: "We couldn't open Stripe just now. Please try again in a moment.",
} as const

export type PayoutsErrorCode = keyof typeof PAYOUTS_ERROR_MESSAGES

export function payoutsErrorMessage(code: string | string[] | undefined): string | null {
  return typeof code === "string" && Object.hasOwn(PAYOUTS_ERROR_MESSAGES, code)
    ? PAYOUTS_ERROR_MESSAGES[code as PayoutsErrorCode]
    : null
}
