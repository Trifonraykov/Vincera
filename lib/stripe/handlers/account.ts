import "server-only"

import { syncAccountFromStripe, syncTransfersCapability } from "../connect"
import { capabilityAccountId, stripeAccountSchema, stripeCapabilitySchema } from "../schemas"

import { eventTime, on, type StripeHandlerGroup } from "./define"

/**
 * Connected account status (§7.2, §19.10): both events arrive on the Connect endpoint and update
 * `stripe_accounts`. Becoming payouts-ready advances onboarding and notifies the user once
 * (`syncAccountFromStripe` in lib/stripe/connect.ts).
 */
export const accountHandlers = {
  "account.updated": on(stripeAccountSchema, async (event, { tx }) => {
    await syncAccountFromStripe(tx, event.data.object, { observedAt: eventTime(event) })
  }),

  "capability.updated": on(stripeCapabilitySchema, async (event, { tx }) => {
    const capability = event.data.object
    // Only `transfers` decides readiness (§19.10); we do not request other capabilities.
    if (capability.id !== "transfers") return
    await syncTransfersCapability(tx, capabilityAccountId(capability), capability.status, {
      observedAt: eventTime(event),
    })
  }),
} satisfies StripeHandlerGroup
