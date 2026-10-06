import "server-only"

import Stripe from "stripe"

import type { MoneyGateway } from "./gateway"
import {
  stripeBalanceTransactionSchema,
  stripeDisputeSchema,
  stripeRefundSchema,
  stripeTransferReversalSchema,
  stripeTransferSchema,
  type StripeTransfer,
} from "./money-shared"
import { StripeGatewayError, type StripeGatewayErrorCode } from "./shared"

/**
 * Live money (Phase 5, CLAUDE.md §19.31, §19.33): balance transactions, transfers (no
 * `source_transaction`, §19.10), transfer reversals, refunds and disputes through the SDK. Every
 * response is parsed with the Zod schemas in `./money-shared.ts`. Stripe's `resource_missing`,
 * `balance_insufficient` and `charge_already_refunded` errors become `StripeGatewayError`s the
 * callers act on; anything else (network, auth, rate limits) is rethrown as it is.
 */
export function createLiveMoneyGateway(stripe: Stripe): MoneyGateway {
  return {
    async retrieveBalanceTransaction(id) {
      return mapErrors(async () =>
        stripeBalanceTransactionSchema.parse(await stripe.balanceTransactions.retrieve(id)),
      )
    },

    async createTransfer(input, { idempotencyKey }) {
      return mapErrors(async () =>
        stripeTransferSchema.parse(
          await stripe.transfers.create(
            {
              amount: input.amount,
              currency: input.currency,
              destination: input.destination,
              transfer_group: input.transferGroup,
              metadata: input.metadata,
            },
            { idempotencyKey },
          ),
        ),
      )
    },

    async listTransfersByGroup(transferGroup) {
      return mapErrors(async () => {
        const found: StripeTransfer[] = []
        for await (const transfer of stripe.transfers.list({
          transfer_group: transferGroup,
          limit: 100,
        })) {
          found.push(stripeTransferSchema.parse(transfer))
        }
        return found
      })
    },

    async listTransfers({ createdFrom }) {
      return mapErrors(async () => {
        const found: StripeTransfer[] = []
        for await (const transfer of stripe.transfers.list({
          created: { gte: Math.floor(createdFrom.getTime() / 1000) },
          limit: 100,
        })) {
          found.push(stripeTransferSchema.parse(transfer))
        }
        return found
      })
    },

    async createTransferReversal(input, { idempotencyKey }) {
      return mapErrors(async () =>
        stripeTransferReversalSchema.parse(
          await stripe.transfers.createReversal(
            input.transferId,
            { amount: input.amount, metadata: input.metadata },
            { idempotencyKey },
          ),
        ),
      )
    },

    async createRefund(input, { idempotencyKey }) {
      return mapErrors(async () =>
        stripeRefundSchema.parse(
          await stripe.refunds.create(
            {
              payment_intent: input.paymentIntentId,
              amount: input.amount,
              ...(input.reason ? { reason: input.reason } : {}),
              metadata: input.metadata,
            },
            { idempotencyKey },
          ),
        ),
      )
    },

    async retrieveRefund(refundId) {
      return mapErrors(async () =>
        stripeRefundSchema.parse(await stripe.refunds.retrieve(refundId)),
      )
    },

    async retrieveDispute(disputeId) {
      // `balance_transactions` is always included on a Dispute.
      return mapErrors(async () =>
        stripeDisputeSchema.parse(await stripe.disputes.retrieve(disputeId)),
      )
    },
  }
}

const MAPPED_CODES: readonly StripeGatewayErrorCode[] = [
  "resource_missing",
  "balance_insufficient",
  "charge_already_refunded",
]

function isMappedCode(code: string | undefined): code is StripeGatewayErrorCode {
  return MAPPED_CODES.some((mapped) => mapped === code)
}

/** Stripe's errors callers act on become `StripeGatewayError`s; others pass through. */
async function mapErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      if (isMappedCode(error.code)) throw new StripeGatewayError(error.code, error.message)
      // A connected account that cannot cover a reversal answers `insufficient_funds`.
      if (error.code === "insufficient_funds") {
        throw new StripeGatewayError("balance_insufficient", error.message)
      }
      if (error.type === "StripeInvalidRequestError") {
        throw new StripeGatewayError("invalid_request", error.message)
      }
    }
    throw error
  }
}
