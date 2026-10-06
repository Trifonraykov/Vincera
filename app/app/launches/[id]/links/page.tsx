import { ChartColumn, Link2, Plus } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { CreateLinkForm } from "@/components/analytics/create-link-form"
import { LinkOwnerActions } from "@/components/analytics/link-owner-actions"
import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { CopyButton } from "@/components/launches/copy-button"
import { LaunchStatusBadge } from "@/components/launches/status-badge"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Badge } from "@/components/ui/badge"
import { conversion, formatRate } from "@/lib/analytics/range"
import { canCreateTrackedLink, canManageTrackedLink, canViewLaunchLinks } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { loadLaunchAccess } from "@/lib/launches/queries"
import { trackedLinkPath } from "@/lib/launches/tracked-links"
import { formatMoney } from "@/lib/money"
import { discountPath } from "@/lib/tracked-links/fields"
import {
  loadLinksLaunch,
  loadLinksWithCounts,
  type LinkWithCounts,
} from "@/lib/tracked-links/queries"
import { absoluteUrl } from "@/lib/urls"

export const metadata: Metadata = { title: "Tracked links" }

type Props = { params: Promise<{ id: string }> }

/**
 * Tracked links of a launch (§12 `/app/launches/[id]/links`, v1; CLAUDE.md §19.38): every link
 * of the launch with its all-time numbers (clicks without bots, visitors, page views, checkouts,
 * orders, gross), copy buttons for `/r/<code>` and, for links with a discount, the product page
 * with `?code=`. Members of a live or paused launch add links for themselves (name and an optional
 * discount code); owners rename or turn off their own. Admins read. Anyone else: 404 (the
 * segment's layout checks first).
 */
export default async function LaunchLinksPage({ params }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const access = await loadLaunchAccess(db, id)
  if (!access || !canViewLaunchLinks(user, access)) notFound()
  const launch = await loadLinksLaunch(db, id)
  if (!launch) notFound()

  const { rows } = await loadLinksWithCounts(db, {
    launchId: launch.id,
    collabId: launch.collabId,
    range: null,
  })
  const canCreate = canCreateTrackedLink(user, access)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AppBarSlot title="Tracked links" back="/app/launches" />
      <PageHeader
        title={`Tracked links: ${launch.title}`}
        description="Share a different link in each place you post, and see which one brings buyers. Numbers are all-time; bots are left out."
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <LaunchStatusBadge status={launch.status} />
        <Link
          href={`/app/collabs/${launch.collabId}/analytics`}
          className="inline-flex min-h-11 items-center gap-1 underline-offset-4 hover:underline sm:min-h-0"
        >
          <ChartColumn className="size-4" aria-hidden="true" />
          Analytics by day
        </Link>
        <Link
          href={`/app/collabs/${launch.collabId}/launch`}
          className="inline-flex min-h-11 items-center underline-offset-4 hover:underline sm:min-h-0"
        >
          Launch setup
        </Link>
      </div>

      {canCreate ? (
        <section
          aria-labelledby="new-link-heading"
          className="space-y-3 rounded-xl border bg-card p-4 shadow-xs"
        >
          <h2 id="new-link-heading" className="flex items-center gap-2 font-semibold">
            <Plus className="size-4" aria-hidden="true" />
            New link
          </h2>
          <CreateLinkForm launchId={launch.id} />
        </section>
      ) : launch.wentLiveAt === null ? (
        <p className="text-sm text-muted-foreground">Links can be added once the launch is live.</p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="No links yet"
          description="Going live creates the creator's default link. Add more for each place you share it."
        />
      ) : (
        <ul className="space-y-3" aria-label="Links">
          {rows.map((row) => (
            <li key={row.link?.id ?? "none"}>
              <LinkCard
                row={row}
                slug={launch.slug}
                currency={launch.currency}
                canManage={
                  row.link !== null &&
                  canManageTrackedLink(user, {
                    ownerUserId: row.link.ownerUserId,
                    memberUserIds: access.memberUserIds,
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function LinkCard({
  row,
  slug,
  currency,
  canManage,
}: {
  row: LinkWithCounts
  slug: string
  currency: string
  canManage: boolean
}) {
  const { link, counts } = row
  const n = (value: number) => value.toLocaleString("en-US")
  if (!link) {
    return (
      <article className="space-y-3 rounded-xl border border-dashed p-4">
        <h2 className="font-semibold">No link</h2>
        <p className="text-sm text-muted-foreground">
          People who came to the product page another way (a shared address, a search).
        </p>
        <dl className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Page views" value={n(counts.views)} />
          <Stat label="Checkouts" value={n(counts.checkouts)} />
          <Stat label="Orders" value={n(counts.orders)} />
          <Stat label="Gross" value={formatMoney(counts.grossCents, currency)} />
        </dl>
      </article>
    )
  }
  const name = link.label ?? link.code
  const url = absoluteUrl(trackedLinkPath(link.code))
  const discountUrl = link.discountCode ? absoluteUrl(discountPath(slug, link.discountCode)) : null
  return (
    <article className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="font-semibold break-words">{name}</h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{link.ownerName}</span>
            {link.isDefault ? <Badge variant="secondary">Default</Badge> : null}
            {link.discountCode ? (
              <Badge variant="secondary">
                {link.discountCode} · {link.discountPercentOff}% off
              </Badge>
            ) : null}
            {link.disabledAt ? <Badge variant="outline">Off</Badge> : null}
          </p>
        </div>
        {canManage ? (
          <LinkOwnerActions
            linkId={link.id}
            label={name}
            canDisable={!link.isDefault && link.disabledAt === null}
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-sm">
          {url}
        </code>
        <CopyButton text={url} label={`Copy the link “${name}”`} />
      </div>
      {discountUrl ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-sm">
            {discountUrl}
          </code>
          <CopyButton text={discountUrl} label={`Copy the discount link for “${name}”`}>
            Copy with code
          </CopyButton>
        </div>
      ) : null}
      <dl className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-6">
        <Stat label="Clicks" value={n(counts.clicks)} />
        <Stat label="Visitors" value={n(counts.visitors)} />
        <Stat label="Page views" value={n(counts.views)} />
        <Stat label="Checkouts" value={n(counts.checkouts)} />
        <Stat label="Orders" value={n(counts.orders)} />
        <Stat label="Gross" value={formatMoney(counts.grossCents, currency)} />
      </dl>
      <p className="text-xs text-muted-foreground">
        {formatRate(conversion(counts.orders, counts.clicks))} of clicks became orders.
      </p>
    </article>
  )
}
