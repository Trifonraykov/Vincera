import { ExternalLink, ListChecks } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import {
  AdminApproveButton,
  AdminEndButton,
  AdminRejectButton,
  PauseButton,
  ResumeButton,
} from "@/components/launches/launch-actions"
import { LaunchStatusBadge } from "@/components/launches/status-badge"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { MarkdownText } from "@/components/supply/markdown-text"
import { Button } from "@/components/ui/button"
import { canAccessAdmin } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import type { LaunchStatus } from "@/lib/db/schema/enums"
import { DELIVERY_TYPE_LABELS, launchMediaPath, PRICE_TAX_NOTE } from "@/lib/launches/fields"
import { listLaunchesForAdmin, type AdminLaunchItem } from "@/lib/launches/queries"
import { formatMoney } from "@/lib/money"
import { formatExact } from "@/lib/proposals/display"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Launches" }

const TABS = [
  { id: "review", label: "To review", statuses: ["admin_review"] },
  { id: "live", label: "Live", statuses: ["live"] },
  { id: "paused", label: "Paused", statuses: ["paused"] },
  { id: "setup", label: "In setup", statuses: ["draft", "pending_approval"] },
  { id: "ended", label: "Ended", statuses: ["ended"] },
  {
    id: "all",
    label: "All",
    statuses: ["admin_review", "live", "paused", "pending_approval", "draft", "ended"],
  },
] as const satisfies readonly { id: string; label: string; statuses: readonly LaunchStatus[] }[]
type TabId = (typeof TABS)[number]["id"]

type Props = { searchParams: Promise<{ tab?: string | string[] }> }

/**
 * Admin launches (§12 `/admin/launches`, CLAUDE.md §19.32): the review queue of launches both
 * members approved (oldest first): approve → live, or send back to draft with a note the members
 * read. Live and paused launches can be paused, resumed or ended. Every action is written to
 * `admin_audit_log`. Phase 6 added the other tabs (in setup, ended, all), so every launch is here.
 */
export default async function AdminLaunchesPage({ searchParams }: Props) {
  const user = await requireAdmin()
  authorizePage(canAccessAdmin(user), "/app")
  const raw = (await searchParams).tab
  const tabId: TabId = TABS.some((tab) => tab.id === raw) ? (raw as TabId) : "review"
  const tab = TABS.find((entry) => entry.id === tabId) ?? TABS[0]
  const db = getDb()
  // Phase 6 (CLAUDE.md §19.39): every launch, not only the review queue. Several statuses are
  // merged newest first (the review queue keeps its oldest-submission-first order).
  const lists = await Promise.all(tab.statuses.map((status) => listLaunchesForAdmin(db, status)))
  const launches =
    lists.length === 1
      ? (lists[0] ?? [])
      : lists.flat().sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())

  return (
    <div className="space-y-6">
      <PageHeader
        title="Launches"
        description="Check each launch before it goes live: the page, the price and what buyers get."
      />
      <nav aria-label="Launch lists" className="-mx-4 sm:mx-0">
        <ul className="flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 py-1 sm:px-0">
          {TABS.map((entry) => {
            const active = entry.id === tabId
            return (
              <li key={entry.id} className="shrink-0">
                <Link
                  href={
                    entry.id === "review" ? "/admin/launches" : `/admin/launches?tab=${entry.id}`
                  }
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-8 sm:px-3",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background hover:bg-accent",
                  )}
                >
                  {entry.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {launches.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={
            tabId === "review" ? "Nothing to review" : `No ${tab.label.toLowerCase()} launches`
          }
          description={
            tabId === "review"
              ? "Launches appear here once both members have approved them."
              : undefined
          }
        />
      ) : (
        <ul className="space-y-4" aria-label={tab.label}>
          {launches.map((launch) => (
            <li key={launch.id}>
              <AdminLaunchCard launch={launch} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AdminLaunchCard({ launch }: { launch: AdminLaunchItem }) {
  const headingId = `launch-${launch.id}`
  return (
    <article
      aria-labelledby={headingId}
      className="space-y-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="text-lg font-semibold break-words">
            {launch.title}
          </h2>
          {launch.tagline ? (
            <p className="text-sm text-muted-foreground">{launch.tagline}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {launch.members.map((member) => `${member.name} (${member.role})`).join(" × ")}
          </p>
        </div>
        <LaunchStatusBadge status={launch.status} />
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Price</dt>
          <dd className="font-medium">
            {launch.priceCents === null
              ? "Not set"
              : formatMoney(launch.priceCents, launch.currency)}
            <span className="block text-xs font-normal text-muted-foreground">
              {PRICE_TAX_NOTE}
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Delivery</dt>
          <dd className="font-medium">
            {launch.deliveryType ? DELIVERY_TYPE_LABELS[launch.deliveryType].title : "Not set"}
            {launch.deliveryType === "file" ? ` (${launch.fileCount})` : null}
            {launch.deliveryUrl ? (
              <span className="block truncate font-normal text-muted-foreground">
                {launch.deliveryUrl}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {launch.status === "admin_review" ? "Submitted" : "Sales"}
          </dt>
          <dd className="font-medium">
            {launch.status === "admin_review"
              ? launch.submittedAt
                ? formatExact(launch.submittedAt)
                : "—"
              : `${launch.stats.orders} · ${formatMoney(launch.stats.grossCents, launch.currency)}`}
          </dd>
        </div>
      </dl>

      {launch.media.length > 0 ? (
        <ul className="flex gap-2 overflow-x-auto" aria-label="Images">
          {launch.media.map((item) => (
            <li key={item.url} className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- a redirect to a signed URL */}
              <img
                src={launchMediaPath(launch.id, item.url)}
                alt={item.alt}
                className="h-24 w-40 rounded-md border object-cover"
              />
            </li>
          ))}
        </ul>
      ) : null}

      {launch.descriptionMd ? (
        <details className="rounded-lg border p-3">
          <summary className="min-h-11 cursor-pointer content-center text-sm font-medium sm:min-h-0">
            Description
          </summary>
          <MarkdownText source={launch.descriptionMd} className="mt-3" />
        </details>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        {launch.status === "admin_review" ? (
          <>
            <AdminApproveButton launchId={launch.id} title={launch.title} />
            <AdminRejectButton launchId={launch.id} title={launch.title} />
          </>
        ) : null}
        {launch.status === "live" ? (
          <PauseButton launchId={launch.id} title={launch.title} />
        ) : null}
        {launch.status === "paused" ? <ResumeButton launchId={launch.id} /> : null}
        {launch.status === "live" || launch.status === "paused" ? (
          <AdminEndButton launchId={launch.id} title={launch.title} />
        ) : null}
        {launch.status !== "admin_review" ? (
          <Button asChild variant="ghost" className="h-11 w-full sm:h-9 sm:w-auto">
            <Link href={`/p/${launch.slug}`} target="_blank">
              <ExternalLink aria-hidden="true" />
              Product page
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="ghost" className="h-11 w-full sm:h-9 sm:w-auto">
          <Link href={`/app/collabs/${launch.collabId}/launch`}>Launch setup</Link>
        </Button>
      </div>
    </article>
  )
}
