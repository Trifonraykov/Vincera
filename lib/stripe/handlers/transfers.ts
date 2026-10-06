import "server-only"

import {
  recordStripeTransferReversals,
  transferWithReversalsSchema,
} from "@/lib/payouts/external-reversals"

import { on, type StripeHandlerGroup } from "./define"

/**
 * Transfers webhook handlers (CLAUDE.md §19.31, §19.35; owner: payouts): `transfer.reversed`
 * records reversals made outside the app (lib/payouts/external-reversals.ts); the app's own are
 * recorded by the `payouts-reverse` job.
 */
export const transfersHandlers = {
  "transfer.reversed": on(transferWithReversalsSchema, async (event, { tx, afterCommit }) => {
    await recordStripeTransferReversals(tx, event.data.object, { afterCommit })
  }),
} satisfies StripeHandlerGroup
