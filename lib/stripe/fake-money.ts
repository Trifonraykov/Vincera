import "server-only"

import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"

import type Stripe from "stripe"
import { z } from "zod"

import type { JsonObject, JsonValue } from "@/lib/db/schema"

import {
  createFakeEvent,
  deliverFakeWebhook,
  randomId,
  unixSeconds,
  type FakeObjectType,
  type FakeStripeOptions,
  type FakeStripeStore,
} from "./fake"
import type { MoneyGateway } from "./gateway"
import { stripeIdOf } from "./ids"
import {
  stripeBalanceTransactionSchema,
  stripeDisputeSchema,
  stripeRefundSchema,
  stripeTransferReversalSchema,
  stripeTransferSchema,
  type StripeDispute,
  type StripeRefund,
  type StripeTransfer,
} from "./money-shared"
import { StripeGatewayError } from "./shared"

/**
 * Fake money (Phase 5, CLAUDE.md §19.31, §19.33): Stripe-shaped `balance_transaction`, `transfer`,
 * `transfer_reversal`, `refund` and `dispute` objects in the fake store, nothing in memory.
 *
 * - Ids derive from the idempotency key (`tr_fake_<sha256…>`, `trr_fake_…`, `re_fake_…`), so a
 *   retried request replays the first result, and the same key with other parameters fails with
 *   `invalid_request`, like Stripe.
 * - **Balances** (`balance` objects): the platform's balance is unlimited until a test sets it
 *   (`setFakePlatformBalance`); then a transfer above it fails with `balance_insufficient`. Each
 *   connected account has a balance that transfers add to and reversals take from;
 *   `drainFakeConnectedBalance` simulates Stripe paying it out to the bank, so the next reversal
 *   fails with `balance_insufficient` (§19.10: the negative entries are then netted later).
 * - **Refunds** succeed at once (Stripe test mode) against the PaymentIntent's latest charge
 *   (written by the fake checkout), with a `refund` balance transaction. The gateway never posts
 *   webhooks itself (the caller may hold the order lock the handler needs): after its commit the
 *   caller asks for them with `deliverFakeRefundEvent` (`refund.created`, `refund.updated`,
 *   `refund.failed`). `settleFakeRefund` turns a refund `failed` / `canceled` later.
 * - **Disputes**: `createFakeDispute` / `closeFakeDispute` plus `deliverFakeStripeEvent` with
 *   `charge.dispute.created` / `.closed` drive the chargeback flow.
 */

/** A connected account's or the platform's fake balance: available cents per currency. */
const fakeBalanceSchema = z.object({
  object: z.literal("balance"),
  available: z.record(z.string(), z.int()),
})

const PLATFORM_BALANCE_ID = "platform"

/** The fake Stripe fee on a dispute (Stripe charges €15 in the EEA). */
export const FAKE_DISPUTE_FEE_CENTS = 1500

function idFor(prefix: string, idempotencyKey: string): string {
  return `${prefix}${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`
}

function sameParams(): never {
  throw new StripeGatewayError(
    "invalid_request",
    "Keys for idempotent requests can only be used with the same parameters they were first used with.",
  )
}

async function readRequired(
  store: FakeStripeStore,
  type: FakeObjectType,
  id: string,
  label: string,
): Promise<JsonObject> {
  let object: JsonObject | null = null
  try {
    object = await store.read(type, id)
  } catch (error) {
    if (!(error instanceof StripeGatewayError)) throw error
  }
  if (!object) throw new StripeGatewayError("resource_missing", `No such ${label}: '${id}'`)
  return object
}

async function readBalance(store: FakeStripeStore, id: string) {
  const raw = await store.read("balance", id)
  return raw ? fakeBalanceSchema.parse(raw) : null
}

async function writeBalance(
  store: FakeStripeStore,
  id: string,
  currency: string,
  cents: number,
  base: { available: Record<string, number> } | null,
): Promise<void> {
  await store.write("balance", id, {
    object: "balance",
    available: { ...(base?.available ?? {}), [currency]: cents },
  })
}

/** Set the platform's available balance (null: unlimited, the default). */
export async function setFakePlatformBalance(
  store: FakeStripeStore,
  currency: string,
  cents: number | null,
): Promise<void> {
  if (cents === null) {
    await store.remove("balance", PLATFORM_BALANCE_ID)
    return
  }
  await writeBalance(
    store,
    PLATFORM_BALANCE_ID,
    currency,
    cents,
    await readBalance(store, PLATFORM_BALANCE_ID),
  )
}

/** A connected account's available balance (transfers in, reversals out, drains). */
export async function fakeConnectedBalance(
  store: FakeStripeStore,
  accountId: string,
  currency: string,
): Promise<number> {
  return (await readBalance(store, accountId))?.available[currency] ?? 0
}

/** Simulate Stripe paying the connected account's balance out to its bank: balance → 0. */
export async function drainFakeConnectedBalance(
  store: FakeStripeStore,
  accountId: string,
  currency: string,
): Promise<void> {
  await writeBalance(store, accountId, currency, 0, await readBalance(store, accountId))
}

async function addToBalance(
  store: FakeStripeStore,
  id: string,
  currency: string,
  delta: number,
): Promise<void> {
  const balance = await readBalance(store, id)
  await writeBalance(store, id, currency, (balance?.available[currency] ?? 0) + delta, balance)
}

function assertPositiveCents(amount: number, label: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new StripeGatewayError("invalid_request", `${label} must be a positive integer`)
  }
}

/** The fields of a stored PaymentIntent and charge the fake refund reads (written by checkout). */
const storedPaymentIntentSchema = z.object({
  id: z.string(),
  latest_charge: z.union([z.string(), z.object({ id: z.string() })]).nullable(),
})
const storedChargeSchema = z.object({
  id: z.string(),
  amount: z.int(),
  amount_refunded: z.int().default(0),
  currency: z.string(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
})

export function createFakeMoneyGateway(
  store: FakeStripeStore,
  options: FakeStripeOptions,
): MoneyGateway {
  void options

  async function readTransfer(id: string): Promise<JsonObject> {
    return readRequired(store, "transfer", id, "transfer")
  }

  /** Stored transfers that match, newest first (as Stripe lists them). */
  async function listStoredTransfers(
    keep: (transfer: StripeTransfer) => boolean,
  ): Promise<StripeTransfer[]> {
    let files: string[]
    try {
      files = await readdir(path.join(store.root, "transfer"))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      throw error
    }
    const found: StripeTransfer[] = []
    for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
      const raw = await store.read("transfer", file.slice(0, -".json".length))
      if (!raw) continue
      const transfer = stripeTransferSchema.parse(raw)
      if (keep(transfer)) found.push(transfer)
    }
    return found.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))
  }

  return {
    async retrieveBalanceTransaction(id) {
      return stripeBalanceTransactionSchema.parse(
        await readRequired(store, "balance_transaction", id, "balance transaction"),
      )
    },

    async createTransfer(input, { idempotencyKey }) {
      const id = idFor("tr_fake_", idempotencyKey)
      const existing = await store.read("transfer", id)
      if (existing) {
        const transfer = stripeTransferSchema.parse(existing)
        if (
          transfer.amount !== input.amount ||
          transfer.currency !== input.currency ||
          stripeIdOf(transfer.destination) !== input.destination
        ) {
          sameParams()
        }
        return transfer
      }

      assertPositiveCents(input.amount, "amount")
      const account = await readRequired(store, "account", input.destination, "destination")
      const capabilities = account.capabilities
      const transfersActive =
        capabilities !== null &&
        typeof capabilities === "object" &&
        !Array.isArray(capabilities) &&
        capabilities.transfers === "active"
      if (!transfersActive) {
        throw new StripeGatewayError(
          "invalid_request",
          "Your destination account needs to have at least one of the following capabilities enabled: transfers, crypto_transfers, legacy_payments",
        )
      }

      const platform = await readBalance(store, PLATFORM_BALANCE_ID)
      if (platform) {
        const available = platform.available[input.currency] ?? 0
        if (available < input.amount) {
          throw new StripeGatewayError(
            "balance_insufficient",
            "You have insufficient available funds in your Stripe account.",
          )
        }
        await writeBalance(
          store,
          PLATFORM_BALANCE_ID,
          input.currency,
          available - input.amount,
          platform,
        )
      }
      await addToBalance(store, input.destination, input.currency, input.amount)

      const transfer: JsonObject = {
        id,
        object: "transfer",
        amount: input.amount,
        amount_reversed: 0,
        currency: input.currency,
        destination: input.destination,
        transfer_group: input.transferGroup,
        reversed: false,
        metadata: input.metadata,
        created: unixSeconds(),
      }
      await store.write("transfer", id, transfer)
      return stripeTransferSchema.parse(transfer)
    },

    async listTransfersByGroup(transferGroup) {
      return listStoredTransfers((transfer) => transfer.transfer_group === transferGroup)
    },

    async listTransfers({ createdFrom }) {
      const from = Math.floor(createdFrom.getTime() / 1000)
      return listStoredTransfers((transfer) => transfer.created >= from)
    },

    async createTransferReversal(input, { idempotencyKey }) {
      const id = idFor("trr_fake_", idempotencyKey)
      const existing = await store.read("transfer_reversal", id)
      if (existing) {
        const reversal = stripeTransferReversalSchema.parse(existing)
        if (
          reversal.amount !== input.amount ||
          stripeIdOf(reversal.transfer) !== input.transferId
        ) {
          sameParams()
        }
        return reversal
      }

      assertPositiveCents(input.amount, "amount")
      const transfer = stripeTransferSchema.parse(await readTransfer(input.transferId))
      const left = transfer.amount - transfer.amount_reversed
      if (input.amount > left) {
        throw new StripeGatewayError(
          "invalid_request",
          `Amount (${input.amount}) is greater than the amount left on the transfer (${left}).`,
        )
      }
      const destination = stripeIdOf(transfer.destination) ?? ""
      const balance = await fakeConnectedBalance(store, destination, transfer.currency)
      if (balance < input.amount) {
        throw new StripeGatewayError(
          "balance_insufficient",
          "The connected account has insufficient funds to cover this reversal.",
        )
      }
      await addToBalance(store, destination, transfer.currency, -input.amount)

      const reversed = transfer.amount_reversed + input.amount
      await store.write("transfer", transfer.id, {
        ...(await readTransfer(transfer.id)),
        amount_reversed: reversed,
        reversed: reversed === transfer.amount,
      })
      const reversal: JsonObject = {
        id,
        object: "transfer_reversal",
        amount: input.amount,
        currency: transfer.currency,
        transfer: transfer.id,
        metadata: input.metadata,
        created: unixSeconds(),
      }
      await store.write("transfer_reversal", id, reversal)
      return stripeTransferReversalSchema.parse(reversal)
    },

    async createRefund(input, { idempotencyKey }) {
      const id = idFor("re_fake_", idempotencyKey)
      const existing = await store.read("refund", id)
      if (existing) {
        const refund = stripeRefundSchema.parse(existing)
        if (
          refund.amount !== input.amount ||
          stripeIdOf(refund.payment_intent) !== input.paymentIntentId
        ) {
          sameParams()
        }
        return refund
      }

      assertPositiveCents(input.amount, "amount")
      const paymentIntent = storedPaymentIntentSchema.parse(
        await readRequired(store, "payment_intent", input.paymentIntentId, "payment_intent"),
      )
      const chargeId = stripeIdOf(paymentIntent.latest_charge)
      if (!chargeId) {
        throw new StripeGatewayError(
          "invalid_request",
          "This PaymentIntent does not have a successful charge to refund.",
        )
      }
      const chargeRaw = await readRequired(store, "charge", chargeId, "charge")
      const charge = storedChargeSchema.parse(chargeRaw)
      const left = charge.amount - charge.amount_refunded
      if (left <= 0) {
        throw new StripeGatewayError(
          "charge_already_refunded",
          `Charge ${charge.id} has already been refunded.`,
        )
      }
      if (input.amount > left) {
        throw new StripeGatewayError(
          "invalid_request",
          `Refund amount (${input.amount}) is greater than unrefunded amount on charge (${left}).`,
        )
      }

      const refunded = charge.amount_refunded + input.amount
      await store.write("charge", charge.id, {
        ...chargeRaw,
        amount_refunded: refunded,
        refunded: refunded === charge.amount,
      })

      const created = unixSeconds()
      const balanceTransactionId = randomId("txn_fake_")
      await store.write("balance_transaction", balanceTransactionId, {
        id: balanceTransactionId,
        object: "balance_transaction",
        amount: -input.amount,
        fee: 0,
        net: -input.amount,
        currency: charge.currency,
        fee_details: [],
        status: "available",
        type: "refund",
        available_on: created,
        created,
        source: id,
      })
      const refund: JsonObject = {
        id,
        object: "refund",
        amount: input.amount,
        currency: charge.currency,
        status: "succeeded",
        failure_reason: null,
        reason: input.reason ?? null,
        payment_intent: input.paymentIntentId,
        charge: charge.id,
        balance_transaction: balanceTransactionId,
        metadata: input.metadata,
        created,
      }
      await store.write("refund", id, refund)
      return stripeRefundSchema.parse(refund)
    },

    async retrieveRefund(refundId) {
      return stripeRefundSchema.parse(await readRequired(store, "refund", refundId, "refund"))
    },

    async retrieveDispute(disputeId) {
      return stripeDisputeSchema.parse(await readRequired(store, "dispute", disputeId, "dispute"))
    },
  }
}

// --- Test and dev helpers (fake only) -------------------------------------------------------

/**
 * Turn a fake refund `failed` or `canceled` (Stripe can fail a card refund days later). A refund
 * that had succeeded gives the amount back to the charge. Returns the updated refund.
 */
export async function settleFakeRefund(
  store: FakeStripeStore,
  refundId: string,
  outcome: "succeeded" | "failed" | "canceled",
  failureReason: string | null = outcome === "failed" ? "expired_or_canceled_card" : null,
): Promise<StripeRefund> {
  const raw = await readRequired(store, "refund", refundId, "refund")
  const refund = stripeRefundSchema.parse(raw)
  const chargeId = stripeIdOf(refund.charge)
  const wasCounted = refund.status !== "failed" && refund.status !== "canceled"
  const counts = outcome === "succeeded"
  if (chargeId && wasCounted !== counts) {
    const chargeRaw = await readRequired(store, "charge", chargeId, "charge")
    const charge = storedChargeSchema.parse(chargeRaw)
    const refunded = charge.amount_refunded + (counts ? refund.amount : -refund.amount)
    await store.write("charge", chargeId, {
      ...chargeRaw,
      amount_refunded: refunded,
      refunded: refunded === charge.amount,
    })
  }
  const updated: JsonObject = {
    ...raw,
    status: outcome,
    failure_reason: outcome === "failed" ? failureReason : null,
  }
  await store.write("refund", refundId, updated)
  return stripeRefundSchema.parse(updated)
}

/**
 * A dispute on a fake charge (`needs_response`), with the balance transaction Stripe books when it
 * opens: −amount − fee. Deliver `charge.dispute.created` with `deliverFakeStripeEvent`.
 */
export async function createFakeDispute(
  store: FakeStripeStore,
  input: { chargeId: string; amount?: number; reason?: string; feeCents?: number },
): Promise<StripeDispute> {
  const charge = storedChargeSchema.parse(
    await readRequired(store, "charge", input.chargeId, "charge"),
  )
  const amount = input.amount ?? charge.amount - charge.amount_refunded
  assertPositiveCents(amount, "amount")
  const fee = input.feeCents ?? FAKE_DISPUTE_FEE_CENTS
  const created = unixSeconds()
  const id = randomId("du_fake_")
  const dispute: JsonObject = {
    id,
    object: "dispute",
    amount,
    currency: charge.currency,
    status: "needs_response",
    reason: input.reason ?? "fraudulent",
    charge: charge.id,
    payment_intent: stripeIdOf(charge.payment_intent) ?? null,
    balance_transactions: [
      {
        id: randomId("txn_fake_"),
        object: "balance_transaction",
        amount: -amount,
        fee,
        net: -amount - fee,
        currency: charge.currency,
        fee_details: [
          {
            amount: fee,
            currency: charge.currency,
            type: "stripe_fee",
            description: "Dispute fee",
          },
        ],
        status: "available",
        type: "adjustment",
        available_on: created,
        created,
        source: id,
      },
    ],
    created,
  }
  await store.write("dispute", id, dispute)
  return stripeDisputeSchema.parse(dispute)
}

/**
 * Close a fake dispute: `won` books the amount back (Stripe keeps the fee, unless `returnFee`:
 * the reinstatement then carries the fee back as a negative fee, as in regions where Stripe
 * refunds it), `lost` keeps it.
 */
export async function closeFakeDispute(
  store: FakeStripeStore,
  disputeId: string,
  outcome: "won" | "lost",
  options: { returnFee?: boolean } = {},
): Promise<StripeDispute> {
  const raw = await readRequired(store, "dispute", disputeId, "dispute")
  const dispute = stripeDisputeSchema.parse(raw)
  const created = unixSeconds()
  const balanceTransactions: JsonValue[] = Array.isArray(raw.balance_transactions)
    ? [...raw.balance_transactions]
    : []
  if (outcome === "won") {
    const withdrawnFee = (dispute.balance_transactions ?? []).reduce((t, bt) => t + bt.fee, 0)
    const returned = options.returnFee ? withdrawnFee : 0
    balanceTransactions.push({
      id: randomId("txn_fake_"),
      object: "balance_transaction",
      amount: dispute.amount,
      fee: -returned,
      net: dispute.amount + returned,
      currency: dispute.currency,
      fee_details: [],
      status: "available",
      type: "adjustment",
      available_on: created,
      created,
      source: dispute.id,
    })
  }
  const updated: JsonObject = { ...raw, status: outcome, balance_transactions: balanceTransactions }
  await store.write("dispute", disputeId, updated)
  return stripeDisputeSchema.parse(updated)
}

/** Post a Stripe-shaped event for a money object to the real webhook route, signed like Stripe. */
export async function deliverFakeStripeEvent(
  store: FakeStripeStore,
  type: Stripe.Event.Type,
  object: JsonObject,
  delivery: { url: string; secret: string; fetch?: typeof fetch },
): Promise<{ status: number; eventId: string }> {
  const event = await createFakeEvent(store, type, object)
  const { status } = await deliverFakeWebhook(event, delivery)
  return { status, eventId: String(event.id) }
}

/**
 * Deliver a refund's event (`refund.created` after `createRefund`; `refund.updated` /
 * `refund.failed` after `settleFakeRefund`) once the caller's transaction has committed.
 */
export async function deliverFakeRefundEvent(
  store: FakeStripeStore,
  refundId: string,
  type: "refund.created" | "refund.updated" | "refund.failed",
  delivery: { url: string; secret: string; fetch?: typeof fetch },
): Promise<{ status: number; eventId: string }> {
  const refund = await readRequired(store, "refund", refundId, "refund")
  return deliverFakeStripeEvent(store, type, refund, delivery)
}
