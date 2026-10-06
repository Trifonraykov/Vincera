import "server-only"

import Stripe from "stripe"

import { getStripe } from "./client"
import type { ConnectGateway, StripeGateway } from "./gateway"
import { createLiveCheckoutGateway } from "./live-checkout"
import { createLiveMoneyGateway } from "./live-money"
import { createLivePromotionsGateway } from "./live-promotions"
import { stripeAccountLinkSchema, stripeAccountSchema, stripeLoginLinkSchema } from "./schemas"
import { connectedAccountParams, StripeGatewayError } from "./shared"

/**
 * Live Stripe gateway: the SDK client from `./client.ts` (API version pinned to the SDK's default,
 * two network retries). Responses are parsed with the Zod schemas in `./schemas.ts`. Each topic
 * (CLAUDE.md §19.31) lives in its own `./live-<topic>.ts`; this file holds Connect (Phase 1).
 */
export function createLiveStripeGateway(stripe: Stripe = getStripe()): StripeGateway {
  return {
    mode: "live",
    ...createLiveConnectGateway(stripe),
    ...createLiveCheckoutGateway(stripe),
    ...createLiveMoneyGateway(stripe),
    ...createLivePromotionsGateway(stripe),
  }
}

/** Connect onboarding (Phase 1). */
export function createLiveConnectGateway(stripe: Stripe): ConnectGateway {
  return {
    async createConnectedAccount(input, { idempotencyKey }) {
      const account = await stripe.accounts.create(connectedAccountParams(input), {
        idempotencyKey,
      })
      return stripeAccountSchema.parse(account)
    },

    async retrieveAccount(accountId) {
      try {
        return stripeAccountSchema.parse(await stripe.accounts.retrieve(accountId))
      } catch (error) {
        if (isResourceMissing(error)) {
          throw new StripeGatewayError("resource_missing", `No such account: ${accountId}`)
        }
        throw error
      }
    },

    async createAccountLink({ accountId, refreshUrl, returnUrl }) {
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: "account_onboarding",
        refresh_url: refreshUrl,
        return_url: returnUrl,
      })
      return stripeAccountLinkSchema.parse(link)
    },

    async createLoginLink(accountId) {
      return stripeLoginLinkSchema.parse(await stripe.accounts.createLoginLink(accountId))
    },
  }
}

export function isResourceMissing(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && error.code === "resource_missing"
}
