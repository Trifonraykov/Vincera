import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Facts, formatUtc, Section, shortId, StatusPill } from "@/components/admin/admin-ui"
import {
  LedgerAdjustmentForm,
  PauseForDisputeButton,
  ResolveDisputeForm,
  ReviewDisputeButton,
} from "@/components/admin/dispute-actions"
import { PageHeader } from "@/components/shared/page-header"
import { loadDisputeForAdmin, userNames } from "@/lib/admin/disputes"
import {
  DISPUTE_KIND_TEXT,
  DISPUTE_STATUS_TEXT,
  OUTCOME_LABELS,
  STAGE_TEXT,
} from "@/lib/admin/fields"
import { listAdjustments } from "@/lib/admin/ledger-adjustments"
import {
  canAdjustLedger,
  canResolveDispute,
  canReviewDispute,
  canViewDispute,
} from "@/lib/auth/authz"
import { authorizePage, isImpersonating, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { formatMoney } from "@/lib/money"

export const metadata: Metadata = { title: "Dispute" }

type Props = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * One dispute (§16 Phase 6 acceptance; CLAUDE.md §19.38): the member's description, the collab,
 * its launch and orders; take it into review; resolve it with a note and an outcome, with a
 * ledger adjustment (lines summing to zero, audited) when money moves; pause the launch meanwhile.
 */
export default async function AdminDisputePage({ params }: Props) {
  const user = await requireAdmin()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const db = getDb()
  const detail = await loadDisputeForAdmin(db, id)
  if (!detail) notFound()
  authorizePage(canViewDispute(user, detail.collab), "/admin")
  const { dispute, collab, launch, orders } = detail
  const readOnly = await isImpersonating()
  const adjustments = await listAdjustments(db, { disputeId: dispute.id })
  const names = await userNames(db, [
    ...(dispute.resolvedBy ? [dispute.resolvedBy] : []),
    ...(dispute.inReviewByUserId ? [dispute.inReviewByUserId] : []),
  ])
  const memberName = new Map(collab.members.map((member) => [member.userId, member.name]))
  const parties = [
    ...collab.members.map((member) => ({
      id: member.userId,
      label: `${member.name} (${member.role})`,
    })),
    { id: "platform", label: "The platform" },
  ]
  const orderOptions = orders
    .filter((order) => order.status !== "disputed")
    .map((order) => ({
      id: order.id,
      label: `#${shortId(order.id)} · ${formatMoney(order.grossCents, order.currency)} · ${order.paidAt.toISOString().slice(0, 10)}`,
    }))

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${DISPUTE_KIND_TEXT[dispute.kind]} dispute`}
        description={
          <>
            On{" "}
            <Link className="underline" href={`/admin/collabs/${collab.id}`}>
              {collab.target.title}
            </Link>{" "}
            · raised by {detail.raisedByName} · {formatUtc(dispute.createdAt)}
          </>
        }
        actions={
          !readOnly && canReviewDispute(user, dispute) ? (
            <ReviewDisputeButton disputeId={dispute.id} />
          ) : null
        }
      />

      <Section title="What the member says">
        <p className="text-sm break-words whitespace-pre-wrap">{dispute.description}</p>
        <Facts
          items={[
            {
              label: "Status",
              value: (
                <StatusPill tone={dispute.status === "resolved" ? "neutral" : "bad"}>
                  {DISPUTE_STATUS_TEXT[dispute.status]}
                </StatusPill>
              ),
            },
            {
              label: "In review since",
              value: dispute.inReviewAt
                ? `${formatUtc(dispute.inReviewAt)} by ${names.get(dispute.inReviewByUserId ?? "") ?? "an admin"}`
                : "—",
            },
            { label: "Collab stage", value: STAGE_TEXT[collab.stage] },
          ]}
        />
      </Section>

      <Section title="Members">
        <ul className="divide-y">
          {collab.members.map((member) => (
            <li
              key={member.userId}
              className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <Link href={`/admin/users/${member.userId}`} className="font-medium underline">
                {member.name}
              </Link>
              <span className="text-sm text-muted-foreground">
                {member.role} · {member.splitPct}%
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Launch"
        actions={
          !readOnly && launch?.status === "live" && dispute.status !== "resolved" ? (
            <PauseForDisputeButton launchId={launch.id} title={launch.title} />
          ) : null
        }
      >
        {launch ? (
          <>
            <Facts
              items={[
                { label: "Title", value: launch.title },
                {
                  label: "Status",
                  value: `${launch.status.replace("_", " ")}${launch.pausedBy ? ` (paused by ${launch.pausedBy})` : ""}`,
                },
                { label: "Went live", value: formatUtc(launch.wentLiveAt) },
              ]}
            />
            {orders.length > 0 ? (
              <ul className="space-y-1 text-sm" aria-label="Orders">
                {orders.map((order) => (
                  <li key={order.id}>
                    #{shortId(order.id)} · {formatMoney(order.grossCents, order.currency)}
                    {order.refundedCents > 0
                      ? ` (${formatMoney(order.refundedCents, order.currency)} refunded)`
                      : ""}{" "}
                    · {order.status.replace("_", " ")} · {formatUtc(order.paidAt)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No orders.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No launch.</p>
        )}
      </Section>

      {dispute.status === "resolved" ? (
        <Section title="Resolution">
          <Facts
            items={[
              { label: "Outcome", value: dispute.outcome ? OUTCOME_LABELS[dispute.outcome] : "—" },
              {
                label: "Resolved",
                value: `${formatUtc(dispute.resolvedAt)} by ${names.get(dispute.resolvedBy ?? "") ?? "an admin"}`,
              },
            ]}
          />
          <p className="text-sm break-words whitespace-pre-wrap">{dispute.resolutionNote}</p>
        </Section>
      ) : !readOnly && canResolveDispute(user, dispute) ? (
        <Section
          title="Resolve"
          description="The note goes to both members. Everything here is written to the audit log."
        >
          <ResolveDisputeForm disputeId={dispute.id} parties={parties} orders={orderOptions} />
        </Section>
      ) : dispute.status === "open" ? (
        <p className="text-sm text-muted-foreground">
          Take the dispute into review before resolving it; the members are told you&apos;re looking
          into it.
        </p>
      ) : null}

      <Section title="Ledger adjustments" id="adjustments">
        {adjustments.length === 0 ? (
          <p className="text-sm text-muted-foreground">None for this dispute.</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {adjustments.map((adjustment) => (
              <li key={adjustment.id} className="rounded-lg border p-3">
                <p className="font-medium">
                  {formatUtc(adjustment.createdAt)}
                  {adjustment.orderId ? ` · order #${shortId(adjustment.orderId)}` : ""}
                </p>
                <p className="text-muted-foreground">{adjustment.reason}</p>
                <ul className="mt-1 tabular-nums">
                  {adjustment.lines.map((line, index) => (
                    <li key={index}>
                      {line.userId ? (memberName.get(line.userId) ?? line.userId) : "Platform"}:{" "}
                      {formatMoney(line.amountCents, line.currency)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {!readOnly && dispute.status === "resolved" && canAdjustLedger(user) ? (
          <details className="rounded-lg border p-3">
            <summary className="min-h-11 cursor-pointer content-center text-sm font-medium sm:min-h-0">
              Book another adjustment
            </summary>
            <div className="mt-3">
              <LedgerAdjustmentForm
                disputeId={dispute.id}
                parties={parties}
                orders={orderOptions}
              />
            </div>
          </details>
        ) : null}
      </Section>
    </div>
  )
}
