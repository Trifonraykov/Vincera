import { ChartColumn, Link2 } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { DailyColumns } from "@/components/analytics/daily-columns"
import { FunnelSteps } from "@/components/analytics/funnel-steps"
import { LinksFunnelTable } from "@/components/analytics/links-funnel-table"
import { RangePicker } from "@/components/analytics/range-picker"
import { StatTile } from "@/components/audience/stat-tile"
import { CollabHeader } from "@/components/collabs/collab-header"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { loadFunnelLaunch, loadLaunchFunnel } from "@/lib/analytics/funnel"
import { parseDayRange } from "@/lib/analytics/range"
import { canViewCollabAnalytics, isCollabMember } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { loadCollabSummary } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"
import { formatMoney } from "@/lib/money"
import { loadLinksWithCounts } from "@/lib/tracked-links/queries"

export const metadata: Metadata = { title: "Analytics" }

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const DEFAULT_DAYS = 30
const MAX_DAYS = 365

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Collab analytics (§10 "collab analytics funnel", §12 `/app/collabs/[id]/analytics`; CLAUDE.md
 * §19.38): for the collab's launch over a UTC day range (default 30 days, up to a year), the
 * funnel clicks → product page views → checkouts started → paid orders with each step's
 * conversion, the same by tracked link, daily columns, and revenue: gross, refunded and the
 * viewer's own share (never the other member's). Members and admins (read) only
 * (`canViewCollabAnalytics`); the segment layout runs the same check outside the Suspense
 * boundary so strangers get a real 404.
 */
export default async function CollabAnalyticsPage({ params, searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const collab = await loadCollabSummary(db, id)
  if (!collab || !canViewCollabAnalytics(user, collab)) notFound()

  const launch = await loadFunnelLaunch(db, collab.id)
  const header = <CollabHeader collab={collab} viewerId={user.id} section="analytics" />

  if (!launch?.wentLiveAt) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        {header}
        <EmptyState
          icon={ChartColumn}
          title="Numbers start when the launch goes live"
          description="Clicks on your tracked links, product page views, checkouts and sales show up here once the product is on sale."
          action={
            <Button asChild variant="outline" className="h-11 sm:h-9">
              <Link href={`/app/collabs/${collab.id}/launch`}>Open the launch</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const query = await searchParams
  const at = now()
  const range = parseDayRange(
    { from: single(query.from), to: single(query.to) },
    { now: at, defaultDays: DEFAULT_DAYS, maxDays: MAX_DAYS },
  )
  const isMember = isCollabMember(user, collab)
  const [funnel, links] = await Promise.all([
    loadLaunchFunnel(db, { launch, range, viewerUserId: isMember ? user.id : null }),
    loadLinksWithCounts(db, { launchId: launch.id, collabId: collab.id, range }),
  ])
  const { totals } = funnel
  const money = (cents: number) => formatMoney(cents, launch.currency)
  const basePath = `/app/collabs/${collab.id}/analytics`

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {header}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {launch.title}: how people found it and bought it. Bots are left out.
        </p>
        <Link
          href={`/app/launches/${launch.id}/links`}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium underline-offset-4 hover:underline md:min-h-0"
        >
          <Link2 className="size-4" aria-hidden="true" />
          Tracked links
        </Link>
      </div>
      <RangePicker basePath={basePath} range={range} now={at} maxDays={MAX_DAYS} />

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Link clicks"
          value={totals.clicks.toLocaleString("en-US")}
          note={`${totals.visitors.toLocaleString("en-US")} different visitors`}
        />
        <StatTile label="Page views" value={totals.views.toLocaleString("en-US")} />
        <StatTile label="Paid orders" value={totals.orders.toLocaleString("en-US")} />
        <StatTile
          label="Gross sales"
          value={money(totals.grossCents)}
          note={
            totals.refundedCents > 0 ? `${money(totals.refundedCents)} refunded` : "VAT included"
          }
        />
        {funnel.viewerShareCents !== null ? (
          <StatTile
            label="Your share"
            value={money(funnel.viewerShareCents)}
            note="Of these orders, after VAT, fees, the platform fee and refunds. Fees still pending are not in yet."
            className="col-span-2 lg:col-span-4"
          />
        ) : null}
      </dl>

      <section aria-labelledby="funnel-heading" className="space-y-3 rounded-xl border bg-card p-4">
        <h2 id="funnel-heading" className="font-semibold">
          Funnel
        </h2>
        <FunnelSteps
          steps={[
            { label: "Link clicks", value: totals.clicks },
            {
              label: "Page views",
              value: totals.views,
              note: "Includes people who came to the product page without a tracked link.",
            },
            { label: "Checkouts started", value: totals.checkouts },
            { label: "Paid orders", value: totals.orders },
          ]}
        />
      </section>

      <section aria-labelledby="links-heading" className="space-y-3">
        <h2 id="links-heading" className="font-semibold">
          By tracked link
        </h2>
        <LinksFunnelTable
          rows={links.rows}
          currency={launch.currency}
          caption="The funnel by tracked link"
        />
      </section>

      <section aria-labelledby="daily-heading" className="space-y-3">
        <h2 id="daily-heading" className="font-semibold">
          Day by day
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <DailyColumns
            title="Link clicks"
            days={funnel.daily.map((d) => d.day)}
            values={funnel.daily.map((d) => d.clicks)}
          />
          <DailyColumns
            title="Page views"
            days={funnel.daily.map((d) => d.day)}
            values={funnel.daily.map((d) => d.views)}
          />
          <DailyColumns
            title="Checkouts started"
            days={funnel.daily.map((d) => d.day)}
            values={funnel.daily.map((d) => d.checkouts)}
          />
          <DailyColumns
            title="Gross sales"
            days={funnel.daily.map((d) => d.day)}
            values={funnel.daily.map((d) => d.grossCents)}
            format={money}
          />
        </div>
      </section>
    </div>
  )
}
