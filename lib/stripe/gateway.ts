import "server-only"

import { env } from "@/lib/env"
import { dataDir } from "@/lib/services"

import { isStripeFake } from "./client"
import { createFakeStripeGateway } from "./fake"
import { createLiveStripeGateway } from "./live"
import type { StripeAccount, StripeAccountLink, StripeLoginLink } from "./schemas"
import type { CreateAccountLinkInput, CreateConnectedAccountInput } from "./shared"

export {
  ACCOUNT_LINK_TTL_SECONDS,
  connectedAccountParams,
  StripeGatewayError,
  type CreateAccountLinkInput,
  type CreateConnectedAccountInput,
  type StripeGatewayErrorCode,
} from "./shared"

/**
 * The platform's view of Stripe (§7.2, §19.3, §19.10): one interface with a live implementation
 * (the Stripe SDK, `./live.ts`) and a fake (Stripe-shaped JSON objects under `.data/fake-stripe/`,
 * `./fake.ts`). Business code (`./connect.ts`, webhooks, later checkout and payouts) only talks
 * to this interface, so the fake runs the same code paths in development, CI and e2e.
 *
 * Every method returns objects parsed with the Zod schemas in `./schemas.ts` (Stripe's field
 * names, only the fields we use).
 *
 * Phase 1 covers Connect onboarding. Phases 4–5 extend the interface (and both implementations)
 * with checkout sessions, payment intents / balance transactions, transfers, transfer reversals
 * and refunds.
 */

export interface StripeGateway {
  readonly mode: "live" | "fake"
  /**
   * Create a v1 connected account with controller properties (Express Dashboard, platform pays
   * fees and covers losses, Stripe collects requirements, `transfers` requested; §19.10).
   * Idempotent per `idempotencyKey`.
   */
  createConnectedAccount(
    input: CreateConnectedAccountInput,
    options: { idempotencyKey: string },
  ): Promise<StripeAccount>
  /** The account as Stripe has it now (throws `StripeGatewayError` `resource_missing`). */
  retrieveAccount(accountId: string): Promise<StripeAccount>
  /** A single-use hosted onboarding link (`account_onboarding`). */
  createAccountLink(input: CreateAccountLinkInput): Promise<StripeAccountLink>
  /** A one-time link into the account's Express Dashboard (needs finished onboarding details). */
  createLoginLink(accountId: string): Promise<StripeLoginLink>
}

/**
 * The app's gateway: live when Stripe credentials are configured, otherwise the fake (§19.3).
 * Cheap to call (the SDK client is cached in `./client.ts`); the fake keeps no state in memory,
 * only on disk under `.data/fake-stripe/`, so every Next.js worker sees the same objects.
 */
export function getStripeGateway(): StripeGateway {
  return isStripeFake()
    ? createFakeStripeGateway({ root: dataDir("fake-stripe"), appUrl: env.NEXT_PUBLIC_APP_URL })
    : createLiveStripeGateway()
}
