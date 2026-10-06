import "server-only"

import { env } from "@/lib/env"
import { dataDir } from "@/lib/services"

import { isStripeFake } from "./client"
import { createFakeStripeGateway } from "./fake"
import { createLiveStripeGateway } from "./live"
import type {
  CreateCheckoutSessionInput,
  StripeCharge,
  StripeCheckoutSession,
  StripePaymentIntent,
} from "./checkout-shared"
import type {
  CreateRefundInput,
  CreateTransferInput,
  CreateTransferReversalInput,
  StripeBalanceTransaction,
  StripeDispute,
  StripeRefund,
  StripeTransfer,
  StripeTransferReversal,
} from "./money-shared"
import type { CreatePromotionCodeInput, StripePromotionCode } from "./promotions-shared"
import type { StripeAccount, StripeAccountLink, StripeLoginLink } from "./schemas"
import type { CreateAccountLinkInput, CreateConnectedAccountInput } from "./shared"

export {
  ACCOUNT_LINK_TTL_SECONDS,
  connectedAccountParams,
  StripeGatewayError,
  StripeGatewayNotBuiltError,
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
 * The interface is split by topic (CLAUDE.md §19.31), each with a live and a fake file and one
 * owner: Connect (Phase 1, `./live.ts` / `./fake.ts`), checkout (`./live-checkout.ts` /
 * `./fake-checkout.ts`, the checkout builder), money (`./live-money.ts` / `./fake-money.ts`, the
 * ledger builder) and promotion codes (`./live-promotions.ts` / `./fake-promotions.ts`, the launch
 * builder). `StripeGateway` is their union.
 */

export interface StripeGateway
  extends ConnectGateway, CheckoutGateway, MoneyGateway, PromotionsGateway {
  readonly mode: "live" | "fake"
}

/** Connect onboarding (Phase 1). */
export interface ConnectGateway {
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

/** Checkout (Phase 4, the checkout builder; §7.2, §19.10). */
export interface CheckoutGateway {
  /**
   * Create a Checkout Session with `checkoutSessionParams(input)` (./checkout-shared.ts).
   * Idempotent per `idempotencyKey` (`checkout:<orderRef>`).
   */
  createCheckoutSession(
    input: CreateCheckoutSessionInput,
    options: { idempotencyKey: string },
  ): Promise<StripeCheckoutSession>
  /** The session as Stripe has it now (the success page and `checkout.session.completed`). */
  retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession>
  /**
   * The PaymentIntent with `latest_charge.balance_transaction` expanded, so the Stripe fee is known
   * once the balance transaction exists (null while it is pending, §19.10).
   */
  retrievePaymentIntentWithBalanceTransaction(paymentIntentId: string): Promise<StripePaymentIntent>
  /** A charge with `balance_transaction` expanded (`charge.updated` carries only its id). */
  retrieveCharge(chargeId: string): Promise<StripeCharge>
}

/** Balance transactions, transfers, reversals, refunds and disputes (Phase 5, the ledger builder). */
export interface MoneyGateway {
  /** The real Stripe fee of a charge (§9 step 2). */
  retrieveBalanceTransaction(balanceTransactionId: string): Promise<StripeBalanceTransaction>
  /**
   * One aggregated transfer to a connected account, without `source_transaction` (§19.10).
   * Idempotency key `payout:<batchId>:<userId>`. Throws `StripeGatewayError`
   * `balance_insufficient` when the platform balance is too low.
   */
  createTransfer(
    input: CreateTransferInput,
    options: { idempotencyKey: string },
  ): Promise<StripeTransfer>
  /** Transfers with this `transfer_group` (finds a transfer whose idempotency key expired). */
  listTransfersByGroup(transferGroup: string): Promise<StripeTransfer[]>
  /**
   * Every platform transfer created at or after `createdFrom` (reconciliation, `ledger:check`:
   * Stripe's side against ours, so a transfer we have no row for is found).
   */
  listTransfers(input: { createdFrom: Date }): Promise<StripeTransfer[]>
  /**
   * Reverse part of a transfer after a refund or lost chargeback (§9). Throws
   * `StripeGatewayError` `balance_insufficient` when the connected balance is too low (§19.10:
   * the negative entries then stay unpaid and are netted against future payouts).
   */
  createTransferReversal(
    input: CreateTransferReversalInput,
    options: { idempotencyKey: string },
  ): Promise<StripeTransferReversal>
  /** Refund (part of) a payment. Idempotency key `refund:<refunds.id>`. */
  createRefund(input: CreateRefundInput, options: { idempotencyKey: string }): Promise<StripeRefund>
  retrieveRefund(refundId: string): Promise<StripeRefund>
  /** A dispute with its balance transactions (the disputed amount and the dispute fee). */
  retrieveDispute(disputeId: string): Promise<StripeDispute>
}

/** Promotion codes for tracked-link discount codes (Phase 4, the launch builder; §10). */
export interface PromotionsGateway {
  /**
   * A percent-off coupon plus its customer-facing promotion code. Idempotency key
   * `promo:<trackedLinkId>`.
   */
  createPromotionCode(
    input: CreatePromotionCodeInput,
    options: { idempotencyKey: string },
  ): Promise<StripePromotionCode>
  /** Stop a code from being used (a disabled tracked link). */
  deactivatePromotionCode(promotionCodeId: string): Promise<StripePromotionCode>
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
