import type Stripe from "stripe"

import type { PayoutCountry } from "./countries"

/**
 * Pieces of the Stripe gateway (`./gateway.ts`) that both implementations use. Kept apart from
 * `gateway.ts` so `./live.ts` and `./fake.ts` do not import the module that imports them.
 */

export type CreateConnectedAccountInput = {
  /** The account's country; it cannot change later. */
  country: PayoutCountry
  /** Prefills Stripe's onboarding form; null when the user has no email. */
  email: string | null
  /** Our user id, stored as `metadata.user_id` (lets a webhook find the user). */
  userId: string
}

export type CreateAccountLinkInput = {
  accountId: string
  /** Absolute URL Stripe sends the user to when the link expired or was already used. */
  refreshUrl: string
  /** Absolute URL Stripe sends the user to when they leave onboarding (finished or not). */
  returnUrl: string
}

/**
 * `resource_missing` / `invalid_request` (Phase 1); Phase 5 adds the money failures callers act on:
 * `balance_insufficient` (platform balance too low for a transfer, or connected balance too low
 * for a reversal) and `charge_already_refunded`.
 */
export type StripeGatewayErrorCode =
  "resource_missing" | "invalid_request" | "balance_insufficient" | "charge_already_refunded"

/** A Stripe request failed in a way callers may handle (the fake throws it like the API would). */
export class StripeGatewayError extends Error {
  readonly code: StripeGatewayErrorCode

  constructor(code: StripeGatewayErrorCode, message: string) {
    super(message)
    this.name = "StripeGatewayError"
    this.code = code
  }
}

/**
 * A gateway method a later builder still has to write (CLAUDE.md §19.31 lists the owner of each
 * topic file). Thrown by the Phase 4–5 stubs so a premature call fails loudly instead of returning
 * made-up data.
 */
export class StripeGatewayNotBuiltError extends Error {
  constructor(method: string, owner: "launch" | "checkout" | "ledger") {
    super(
      `StripeGateway.${method} is not built yet (owner: the ${owner} builder, CLAUDE.md §19.31)`,
    )
    this.name = "StripeGatewayNotBuiltError"
  }
}

/** Account link lifetime: Stripe's links expire after a few minutes; the fake uses five. */
export const ACCOUNT_LINK_TTL_SECONDS = 300

/**
 * The `accounts.create` parameters for a creator or builder (§19.10,
 * docs/integrations/stripe.md): a v1 account with controller properties (Express Dashboard, the
 * platform pays Stripe's fees and covers losses, Stripe collects the requirements), requesting
 * only `transfers`, under the full service agreement. Shared by the live gateway and the fake so
 * both describe the same account.
 *
 * `business_type` is left to Stripe's onboarding form, because creators and builders may be
 * individuals or companies.
 */
export function connectedAccountParams(input: CreateConnectedAccountInput) {
  return {
    country: input.country,
    ...(input.email ? { email: input.email } : {}),
    controller: {
      fees: { payer: "application" },
      losses: { payments: "application" },
      requirement_collection: "stripe",
      stripe_dashboard: { type: "express" },
    },
    // Transfers only: the platform is the merchant of every sale (§7.2), so no `card_payments`.
    capabilities: { transfers: { requested: true } },
    // The full agreement allows cross-border transfers; the `recipient` agreement blocks them.
    tos_acceptance: { service_agreement: "full" },
    metadata: { user_id: input.userId },
  } satisfies Stripe.AccountCreateParams
}
