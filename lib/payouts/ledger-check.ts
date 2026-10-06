import "server-only"

import type { DbOrTx } from "@/lib/db/client"
import { checkLedger, type LedgerCheckGateway } from "@/lib/ledger/check"
import type { LedgerCheckMismatch } from "@/lib/ledger/types"
import { reportError } from "@/lib/observability"

/** A reconciliation mismatch, as reported to Sentry (kind and ids; never people's amounts). */
export class LedgerMismatchError extends Error {
  readonly kind: LedgerCheckMismatch["kind"]

  constructor(mismatch: LedgerCheckMismatch) {
    super(`Ledger mismatch: ${mismatch.kind}`)
    this.name = "LedgerMismatchError"
    this.kind = mismatch.kind
  }
}

export type LedgerCheckRun = {
  ordersChecked: number
  transfersChecked: number
  mismatchCount: number
  /** Mismatches per kind. */
  kinds: Partial<Record<LedgerCheckMismatch["kind"], number>>
}

/**
 * The daily `ledger-check` job's work (§9 "reconciliation", §13): `checkLedger` against the
 * database and Stripe's transfers; every mismatch goes to Sentry (`area: ledger`, its kind, and
 * the order / transfer / refund / chargeback id). Read-only.
 */
export async function runLedgerCheck(
  db: DbOrTx,
  options: { gateway: LedgerCheckGateway; at?: Date },
): Promise<LedgerCheckRun> {
  const report = await checkLedger(db, {
    compareWithStripe: true,
    gateway: options.gateway,
    at: options.at,
  })
  const kinds: LedgerCheckRun["kinds"] = {}
  for (const mismatch of report.mismatches) {
    kinds[mismatch.kind] = (kinds[mismatch.kind] ?? 0) + 1
    reportError(new LedgerMismatchError(mismatch), {
      tags: { area: "ledger", job: "ledger-check", kind: mismatch.kind },
      extra: {
        orderId: mismatch.orderId,
        transferId: mismatch.transferId,
        refundId: mismatch.refundId,
        chargebackId: mismatch.chargebackId,
        reversalId: mismatch.reversalId,
        stripeId: mismatch.stripeId,
      },
    })
  }
  return {
    ordersChecked: report.ordersChecked,
    transfersChecked: report.transfersChecked,
    mismatchCount: report.mismatches.length,
    kinds,
  }
}
