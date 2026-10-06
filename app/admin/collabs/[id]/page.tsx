import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Facts, formatUtc, Section, StatusPill } from "@/components/admin/admin-ui"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { DISPUTE_KIND_TEXT, DISPUTE_STATUS_TEXT, STAGE_TEXT } from "@/lib/admin/fields"
import { loadCollabForAdmin } from "@/lib/admin/queries"
import { canViewCollab } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { formatMoney } from "@/lib/money"

export const metadata: Metadata = { title: "Collab" }

type Props = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * One collab for admins (Phase 6): members and splits, agreement status, launch, disputes, with
 * links to the members' own pages (admins read them, §6).
 */
export default async function AdminCollabPage({ params }: Props) {
  const user = await requireAdmin()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const detail = await loadCollabForAdmin(getDb(), id)
  if (!detail) notFound()
  authorizePage(canViewCollab(user, detail.summary), "/admin")
  const { summary, agreement, launch, disputes } = detail
  const signed = new Set(agreement?.signatures.map((signature) => signature.userId) ?? [])

  return (
    <div className="space-y-6">
      <PageHeader
        title={summary.target.title}
        description={`${summary.target.kind === "idea" ? "Idea" : "Product"} collab · ${STAGE_TEXT[summary.stage]}`}
        actions={
          <Button asChild variant="outline" className="h-11 w-full sm:h-9 sm:w-auto">
            <Link href={`/app/collabs/${summary.id}`}>Open the collab</Link>
          </Button>
        }
      />
      <Section title="Collab">
        <Facts
          items={[
            { label: "Stage", value: STAGE_TEXT[summary.stage] },
            { label: "Since", value: formatUtc(summary.stageChangedAt) },
            { label: "Last activity", value: formatUtc(summary.lastActivityAt) },
            { label: "Started", value: formatUtc(summary.createdAt) },
            {
              label: "Ended",
              value: summary.endedAt
                ? `${formatUtc(summary.endedAt)} (${summary.endedReason ?? "—"})`
                : "—",
            },
          ]}
        />
      </Section>
      <Section title="Members">
        <ul className="divide-y">
          {summary.members.map((member) => (
            <li
              key={member.userId}
              className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <Link href={`/admin/users/${member.userId}`} className="font-medium underline">
                {member.name}
              </Link>
              <span className="text-sm text-muted-foreground">
                {member.role} · {member.splitPct}%
                {agreement ? (signed.has(member.userId) ? " · signed" : " · not signed") : ""}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Agreement">
        {agreement ? (
          <Facts
            items={[
              { label: "Status", value: agreement.status.replace("_", " ") },
              { label: "Template", value: agreement.templateVersion },
              { label: "Generated", value: formatUtc(agreement.createdAt) },
              { label: "Fully signed", value: formatUtc(agreement.completedAt) },
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No agreement.</p>
        )}
      </Section>
      <Section title="Launch">
        {launch ? (
          <Facts
            items={[
              {
                label: "Title",
                value: (
                  <Link className="underline" href={`/app/collabs/${summary.id}/launch`}>
                    {launch.title}
                  </Link>
                ),
              },
              { label: "Status", value: launch.status.replace("_", " ") },
              {
                label: "Price",
                value:
                  launch.priceCents === null
                    ? "Not set"
                    : formatMoney(launch.priceCents, launch.currency),
              },
              { label: "Went live", value: formatUtc(launch.wentLiveAt) },
              {
                label: "Sales",
                value: `${launch.orders} · ${formatMoney(launch.grossCents, launch.currency)} net of refunds`,
              },
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No launch yet.</p>
        )}
      </Section>
      <Section title="Disputes" id="disputes">
        {disputes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No disputes.</p>
        ) : (
          <ul className="divide-y">
            {disputes.map((dispute) => (
              <li key={dispute.id}>
                <Link
                  href={`/admin/disputes/${dispute.id}`}
                  className="flex min-h-11 items-center justify-between gap-2 py-2 hover:underline"
                >
                  <span>
                    {DISPUTE_KIND_TEXT[dispute.kind]} · raised {formatUtc(dispute.createdAt)}
                  </span>
                  <StatusPill tone={dispute.status === "resolved" ? "neutral" : "bad"}>
                    {DISPUTE_STATUS_TEXT[dispute.status]}
                  </StatusPill>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
