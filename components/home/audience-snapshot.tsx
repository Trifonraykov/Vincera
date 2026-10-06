import { BadgeCheck, Users } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { DbOrTx } from "@/lib/db/client"
import { loadAudienceOverview } from "@/lib/social/audience"
import { SIZE_TIER_LABELS, SIZE_TIER_RANGES } from "@/lib/social/size-tier"

import { HomeSection } from "./section"

function compactCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  )
}

/**
 * "Your audience" on the creator's `/app`: the size tier, each connected platform's followers
 * (verified or not) and the top countries of the largest one, linking to `/app/audience`.
 */
export async function AudienceSnapshotSection({ db, userId }: { db: DbOrTx; userId: string }) {
  const overview = await loadAudienceOverview(db, userId)
  const withNumbers = overview.connections.filter(
    (view) => view.latest?.followers !== null && view.latest,
  )
  const largest = [...withNumbers].sort(
    (a, b) => (b.latest?.followers ?? 0) - (a.latest?.followers ?? 0),
  )[0]
  const countries = largest?.latest?.topCountries.slice(0, 3) ?? []
  const regionNames = new Intl.DisplayNames(["en"], { type: "region" })

  return (
    <HomeSection
      id="home-audience"
      icon={Users}
      title="Your audience"
      link={overview.connections.length > 0 ? { href: "/app/audience", label: "Details" } : null}
    >
      {overview.connections.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Connect your audience"
          description="Link YouTube, Instagram or TikTok so builders can see who you reach. Verified audiences rank higher with builders."
          action={
            <Button asChild size="sm" className="h-11 sm:h-8">
              <Link href="/app/settings/connections">Connect an account</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold">
              {overview.tier.tier ? SIZE_TIER_LABELS[overview.tier.tier] : "Size pending"}
            </span>
            {overview.tier.tier ? (
              <span className="text-sm text-muted-foreground">
                {SIZE_TIER_RANGES[overview.tier.tier]}
              </span>
            ) : null}
            {overview.tier.verified ? (
              <Badge variant="secondary">
                <BadgeCheck aria-hidden="true" />
                Verified
              </Badge>
            ) : (
              <Badge variant="outline">Unverified</Badge>
            )}
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {overview.connections.map((view) => (
              <li key={view.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">{view.label}</span>
                <span className="font-medium tabular-nums">
                  {view.latest?.followers !== null && view.latest?.followers !== undefined
                    ? compactCount(view.latest.followers)
                    : "Syncing…"}
                </span>
              </li>
            ))}
          </ul>
          {countries.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Top countries:{" "}
              {countries
                .map(
                  (entry) =>
                    `${regionNames.of(entry.country) ?? entry.country} ${Math.round(entry.share * 100)}%`,
                )
                .join(", ")}
            </p>
          ) : null}
        </div>
      )}
    </HomeSection>
  )
}
