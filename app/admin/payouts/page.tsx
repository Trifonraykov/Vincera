import type { Metadata } from "next"
import Link from "next/link"

import {
  formatUtc,
  ScrollTable,
  Section,
  shortId,
  StatusPill,
  Td,
  Th,
} from "@/components/admin/admin-ui"
import {
  CancelRefundButton,
  RetryRefundButton,
  RunPayoutsButton,
} from "@/components/admin/payout-actions"
import { RefundRequestsPanel } from "@/components/refunds/refund-requests-panel"
import { PageHeader } from "@/components/shared/page-header"
import { TRANSFER_STATUS_TEXT } from "@/lib/admin/fields"
import { ledgerStatus, loadPayoutsOverview, type TransferRow } from "@/lib/admin/payouts"
import { canManagePayouts, canRefundOrder } from "@/lib/auth/authz"
import { authorizePage, isImpersonating, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { formatMoney } from "@/lib/money"
import { payoutFailureMessage } from "@/lib/payouts/failure-codes"

export const metadata: Metadata = { title: "Payouts" }

function TransferTable({ label, rows }: { label: string; rows: TransferRow[] }) {
  return (
    <ScrollTable label={label}>
      <thead>
        <tr>
          <Th>Created</Th>
          <Th>Person</Th>
          <Th className="text-right">Amount</Th>
          <Th>Status</Th>
          <Th>Batch</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <Td>{formatUtc(row.createdAt)}</Td>
            <Td>
              <Link className="underline" href={`/admin/users/${row.userId}`}>
                {row.userName}
              </Link>
            </Td>
            <Td className="text-right tabular-nums">
              {formatMoney(row.amountCents, row.currency)}
            </Td>
            <Td>
              {TRANSFER_STATUS_TEXT[row.status]}
              {row.failureCode ? (
                <span className="block text-xs text-muted-foreground">
                  {payoutFailureMessage(row.failureCode)}
                </span>
              ) : null}
            </Td>
            <Td>
              <code className="text-xs">{row.batchRunKey}</code>
            </Td>
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  )
}

/**
 * /admin/payouts (§12, Phase 6; CLAUDE.md §19.39): payout batches, failures (retried by running
 * payouts again), stuck refunds, the reconciliation status, buyers' refund requests (Phase 7's
 * panel). Ledger adjustments are booked from the dispute they settle.
 */
export default async function AdminPayoutsPage() {
  const user = await requireAdmin()
  authorizePage(canManagePayouts(user), "/app")
  const db = getDb()
  const readOnly = await isImpersonating()
  const [overview, ledger] = await Promise.all([loadPayoutsOverview(db), ledgerStatus(db)])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payouts"
        description="Transfers to creators and builders after the hold period, and the ledger's health."
        actions={!readOnly ? <RunPayoutsButton /> : null}
      />

      <Section
        title="Ledger check"
        id="ledger-check"
        description="Every order, refund, adjustment and transfer must add up (database only; the daily job also compares with Stripe)."
      >
        {ledger.mismatches.length === 0 ? (
          <p className="text-sm">
            <StatusPill tone="good">Balanced</StatusPill>{" "}
            <span className="text-muted-foreground">
              {ledger.ordersChecked} orders and {ledger.transfersChecked} transfers checked.
            </span>
          </p>
        ) : (
          <>
            <p className="text-sm">
              <StatusPill tone="bad">{ledger.mismatches.length} mismatches</StatusPill>
            </p>
            <ul className="space-y-1 text-sm">
              {ledger.mismatches.slice(0, 20).map((mismatch, index) => (
                <li key={index} className="break-words">
                  <code className="text-xs">{mismatch.kind}</code>{" "}
                  {mismatch.orderId ? `order #${shortId(mismatch.orderId)} ` : ""}
                  {mismatch.transferId ? `transfer #${shortId(mismatch.transferId)} ` : ""}
                  {mismatch.adjustmentId ? `adjustment #${shortId(mismatch.adjustmentId)} ` : ""}
                  expected {mismatch.expectedCents}, found {mismatch.actualCents}
                  {mismatch.detail ? ` (${mismatch.detail})` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section
        title="Failed transfers"
        id="failed"
        description="Last 30 days. A refused transfer's money is payable again: run payouts once the person fixed their Stripe account."
      >
        {overview.failedTransfers.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <TransferTable label="Failed transfers" rows={overview.failedTransfers} />
        )}
      </Section>

      {overview.pendingTransfers.length > 0 ? (
        <Section
          title="Transfers still pending"
          description="Collected but not confirmed by Stripe. The next run resolves them."
        >
          <TransferTable label="Pending transfers" rows={overview.pendingTransfers} />
        </Section>
      ) : null}

      <Section title="Recent payout batches">
        {overview.batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payout batch has run yet.</p>
        ) : (
          <ScrollTable label="Payout batches">
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Started</Th>
                <Th>Status</Th>
                <Th className="text-right">Transfers</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Failed</Th>
              </tr>
            </thead>
            <tbody>
              {overview.batches.map((batch) => (
                <tr key={batch.id}>
                  <Td>
                    <code className="text-xs">{batch.runKey}</code>
                  </Td>
                  <Td>{formatUtc(batch.startedAt)}</Td>
                  <Td>{batch.status}</Td>
                  <Td className="text-right tabular-nums">{batch.transferCount}</Td>
                  <Td className="text-right tabular-nums">
                    {formatMoney(batch.totalCents, "eur")}
                  </Td>
                  <Td className="text-right tabular-nums">{batch.failedCount}</Td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </Section>

      <Section
        title="Stuck refunds"
        id="stuck-refunds"
        description="Refunds we recorded but Stripe never answered (the app stopped in between). Retry sends the same request again; Stripe never refunds twice."
      >
        {overview.stuckRefunds.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y">
            {overview.stuckRefunds.map((refund) => (
              <li
                key={refund.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <p className="text-sm">
                  {formatMoney(refund.amountCents, refund.currency)} on order #
                  {shortId(refund.orderId)} · since {formatUtc(refund.createdAt)}
                </p>
                {!readOnly && canRefundOrder(user) ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <RetryRefundButton refundId={refund.id} />
                    <CancelRefundButton refundId={refund.id} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <section id="refund-requests" aria-label="Refund requests" className="scroll-mt-24">
        <RefundRequestsPanel />
      </section>
    </div>
  )
}
