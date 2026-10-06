import { Scale } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { FilterChips, formatUtc, StatusPill } from "@/components/admin/admin-ui"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { disputeCounts, listDisputesForAdmin } from "@/lib/admin/disputes"
import { DISPUTE_KIND_TEXT, DISPUTE_STATUS_TEXT, OUTCOME_LABELS } from "@/lib/admin/fields"
import { canManageUsers } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import type { DisputeStatus } from "@/lib/db/schema/enums"

export const metadata: Metadata = { title: "Disputes" }

type Props = { searchParams: Promise<{ status?: string }> }

const TABS = [
  { id: "unresolved", label: "Needs a decision" },
  { id: "open", label: "Open" },
  { id: "in_review", label: "In review" },
  { id: "resolved", label: "Resolved" },
] as const
type TabId = (typeof TABS)[number]["id"]

/**
 * /admin/disputes (§12, Phase 6): collab disputes raised by members. Open ones are taken into
 * review, then resolved with a note and an outcome (CLAUDE.md §19.38).
 */
export default async function AdminDisputesPage({ searchParams }: Props) {
  const user = await requireAdmin()
  authorizePage(canManageUsers(user), "/app")
  const raw = (await searchParams).status
  const tab: TabId = TABS.some((entry) => entry.id === raw) ? (raw as TabId) : "unresolved"
  const db = getDb()
  const [items, counts] = await Promise.all([
    listDisputesForAdmin(db, { status: tab as DisputeStatus | "unresolved" }),
    disputeCounts(db),
  ])
  const countOf = (id: TabId) =>
    id === "unresolved" ? counts.open + counts.in_review : counts[id as DisputeStatus]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Disputes"
        description="Members raise disputes about splits, delivery or exits. Take each into review, then resolve it."
      />
      <FilterChips
        label="Dispute lists"
        chips={TABS.map((entry) => ({
          href:
            entry.id === "unresolved" ? "/admin/disputes" : `/admin/disputes?status=${entry.id}`,
          label: entry.label,
          active: entry.id === tab,
          count: countOf(entry.id),
        }))}
      />
      {items.length === 0 ? (
        <EmptyState
          icon={Scale}
          title={tab === "resolved" ? "No resolved disputes" : "Nothing to decide"}
          description={tab === "resolved" ? undefined : "New disputes appear here."}
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Disputes">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/admin/disputes/${item.id}`}
                className="flex min-h-11 flex-col gap-1 p-4 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block font-medium break-words">{item.collabTitle}</span>
                  <span className="block text-sm text-muted-foreground">
                    {DISPUTE_KIND_TEXT[item.kind]} · raised by {item.raisedByName} ·{" "}
                    {formatUtc(item.createdAt)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap gap-1">
                  <StatusPill tone={item.status === "resolved" ? "neutral" : "bad"}>
                    {DISPUTE_STATUS_TEXT[item.status]}
                  </StatusPill>
                  {item.outcome ? <StatusPill>{OUTCOME_LABELS[item.outcome]}</StatusPill> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
