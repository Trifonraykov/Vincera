import { ConnectionStatusBadge } from "@/components/social/connection-status-badge"
import { ProviderIcon } from "@/components/social/provider-icon"
import type { AudienceOverview } from "@/lib/social/audience"
import { SIZE_TIER_RANGES } from "@/lib/social/size-tier"

import { formatCompact, formatDateTimeUtc, formatPercent } from "./format"
import { SizeTierBadge } from "./size-tier-badge"

/**
 * Key audience numbers: the size tier and, per connected platform, followers, average views and
 * engagement with the connection's health (Verified / Unverified / Expired ...).
 */
export function AudienceStats({
  overview,
  headingLevel = "h2",
}: {
  overview: AudienceOverview
  headingLevel?: "h2" | "h3"
}) {
  const Heading = headingLevel
  const { tier } = overview

  return (
    <section aria-labelledby="key-stats" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id="key-stats" className="text-base font-semibold">
          Key stats
        </Heading>
        {tier.tier ? (
          <SizeTierBadge tier={tier.tier} verified={tier.verified} />
        ) : (
          <span className="text-sm text-muted-foreground">Size tier appears after a sync</span>
        )}
      </div>
      {tier.tier ? (
        <p className="text-sm text-muted-foreground">
          Your size tier ({SIZE_TIER_RANGES[tier.tier]}) uses your largest{" "}
          {tier.verified ? "verified" : "self-reported"} platform.
          {tier.verified
            ? ""
            : " It becomes verified once you connect the account or we check your screenshot."}
        </p>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {overview.connections.map((connection) => {
          const audienceWord = connection.provider === "youtube" ? "Subscribers" : "Followers"
          const latest = connection.latest
          return (
            <li key={connection.id} className="space-y-3 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <ProviderIcon provider={connection.provider} className="size-4" />
                <span className="font-medium">{connection.label}</span>
                <ConnectionStatusBadge health={connection.health} className="ml-auto" />
              </div>
              {latest ? (
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{audienceWord}</dt>
                    <dd className="text-lg font-semibold">{formatCompact(latest.followers)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Avg. views</dt>
                    <dd className="text-lg font-semibold">{formatCompact(latest.avgViews)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Engagement</dt>
                    <dd className="text-lg font-semibold">
                      {formatPercent(latest.engagementRate)}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">No numbers yet.</p>
              )}
              <p className="text-xs text-muted-foreground">
                {latest
                  ? `${connection.source === "manual" ? "Entered" : "Updated"} ${formatDateTimeUtc(latest.takenAt)}`
                  : "Waiting for the first sync"}
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
