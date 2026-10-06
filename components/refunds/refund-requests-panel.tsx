import { Inbox } from "lucide-react"
import type { ReactNode } from "react"

import { EmptyState } from "@/components/shared/empty-state"
import { canDecideRefundRequest } from "@/lib/auth/authz"
import { requireAdmin } from "@/lib/auth/session"
import { agreementDate } from "@/lib/agreements/template-v1"
import { getDb } from "@/lib/db/client"
import { formatMoney } from "@/lib/money"
import { REFUND_REASON_LABELS } from "@/lib/refund-requests/fields"
import { listPendingRefundRequests } from "@/lib/refund-requests/service"

import { RefundDecisionButtons } from "./refund-request-panel"

/**
 * Pending buyer refund requests with Approve / Decline (Phase 7, v1; CLAUDE.md §19.38), oldest
 * first. Placed by the admin area on `/admin/payouts` inside a section with
 * `id="refund-requests"` (the `admin.refund_requested` notification links there). An async server
 * component that loads its own data and checks `requireAdmin()` itself; it takes no props.
 * Never shows the buyer's email: the order reference, amounts, reason and message are enough.
 */
export async function RefundRequestsPanel(): Promise<ReactNode> {
  const admin = await requireAdmin()
  const requests = await listPendingRefundRequests(getDb())
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Refund requests</h2>
      {requests.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No refund requests waiting"
          description="Buyers can ask for a refund within 14 days of paying. New requests show up here."
        />
      ) : (
        <ul className="space-y-3" aria-label="Pending refund requests">
          {requests.map((request) => {
            const amount = formatMoney(request.amountCents, request.currency)
            return (
              <li key={request.id} className="space-y-2 rounded-xl border bg-card p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium break-words">{request.launchTitle}</p>
                  <p className="font-semibold tabular-nums">{amount}</p>
                </div>
                <p className="text-muted-foreground">
                  Order …{request.orderId.slice(-8)} · paid {agreementDate(request.paidAt)} ·{" "}
                  {formatMoney(request.orderGrossCents, request.currency)}
                  {request.orderRefundedCents > 0
                    ? `, ${formatMoney(request.orderRefundedCents, request.currency)} refunded already`
                    : ""}
                  {request.orderStatus === "disputed" ? " · chargeback open" : ""}
                </p>
                <p>
                  <span className="text-muted-foreground">Reason: </span>
                  {REFUND_REASON_LABELS[request.reason]}
                  <span className="text-muted-foreground">
                    {" "}
                    · asked {agreementDate(request.createdAt)}
                  </span>
                </p>
                {request.message ? (
                  <blockquote className="border-l-2 pl-3 break-words whitespace-pre-wrap text-muted-foreground">
                    {request.message}
                  </blockquote>
                ) : null}
                {canDecideRefundRequest(admin, { status: "pending" }) ? (
                  <RefundDecisionButtons requestId={request.id} amountLabel={amount} />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
