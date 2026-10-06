import { ChevronRight, Eye, MousePointerClick, Rocket, ShoppingBag } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { LaunchStatusBadge } from "@/components/launches/status-badge"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { listLaunchesForUser, type LaunchListItem } from "@/lib/launches/queries"
import { formatMoney } from "@/lib/money"

export const metadata: Metadata = { title: "Launches" }

/**
 * Launches (§12 `/app/launches`): the launches of the user's collabs (§6: only their own), live
 * ones first, each with its status and quick numbers: people who clicked a tracked link (bots
 * left out), product page views, and sales. Each opens the collab's launch setup; live ones also
 * link to their launch kit.
 */
export default async function LaunchesPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canManageOwnAccount(user))
  const items = await listLaunchesForUser(getDb(), user.id)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Launches"
        description="Your products on sale, and the ones you're getting ready."
      />
      {items.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title="No launches yet"
          description="Once you've both signed a collab's agreement, set up its launch from the collab's Launch tab."
          action={
            <Button asChild size="sm" className="h-11 sm:h-8">
              <Link href="/app/collabs">Open your collabs</Link>
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Your launches">
          {items.map((item) => (
            <li key={item.id}>
              <LaunchRow item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Stat({ icon: Icon, label, value }: { icon: typeof Eye; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{label}: </span>
      <span className="tabular-nums">{value}</span>
    </span>
  )
}

function LaunchRow({ item }: { item: LaunchListItem }) {
  const live = item.wentLiveAt !== null
  return (
    <article className="rounded-xl border bg-card shadow-xs">
      <Link
        href={`/app/collabs/${item.collabId}/launch`}
        className="flex items-center gap-3 rounded-xl p-4 transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold break-words">{item.title}</h2>
            <LaunchStatusBadge status={item.status} />
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>
              {item.priceCents === null
                ? "No price yet"
                : formatMoney(item.priceCents, item.currency)}
            </span>
            {live ? (
              <>
                <Stat
                  icon={MousePointerClick}
                  label="Link clicks"
                  value={String(item.stats.clicks)}
                />
                <Stat icon={Eye} label="Page views" value={String(item.stats.views)} />
                <Stat
                  icon={ShoppingBag}
                  label="Sales"
                  value={`${item.stats.orders} · ${formatMoney(item.stats.grossCents, item.currency)}`}
                />
              </>
            ) : null}
          </p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
      {live ? (
        <div className="border-t px-4 py-2">
          <Link
            href={`/app/launches/${item.id}/kit`}
            className="inline-flex min-h-11 items-center text-sm font-medium underline-offset-4 hover:underline sm:min-h-8"
          >
            Launch kit
          </Link>
        </div>
      ) : null}
    </article>
  )
}
