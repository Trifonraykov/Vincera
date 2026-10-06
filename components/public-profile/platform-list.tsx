import { ExternalLink } from "lucide-react"

import { formatCompact, formatDate, formatPercent } from "@/components/audience/format"
import { ConnectionStatusBadge } from "@/components/social/connection-status-badge"
import { ProviderIcon } from "@/components/social/provider-icon"
import type { PublicPlatform } from "@/lib/public-profiles/load"

/**
 * A creator's platforms on their public profile: aggregate numbers only, with "Verified" (the
 * platform confirmed them) or "Unverified" (self-reported, §7.1 fallback) on each.
 */
export function PlatformList({ platforms }: { platforms: readonly PublicPlatform[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {platforms.map((platform) => (
        <li key={platform.provider} className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderIcon provider={platform.provider} className="size-4" />
            <span className="font-medium">{platform.label}</span>
            <ConnectionStatusBadge
              health={platform.verified ? "ok" : "unverified"}
              className="ml-auto"
            />
          </div>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-muted-foreground">
                {platform.provider === "youtube" ? "Subscribers" : "Followers"}
              </dt>
              <dd className="text-lg font-semibold">{formatCompact(platform.followers)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Avg. views</dt>
              <dd className="text-lg font-semibold">{formatCompact(platform.avgViews)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Engagement</dt>
              <dd className="text-lg font-semibold">{formatPercent(platform.engagementRate)}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {platform.stale ? "Last updated " : "Updated "}
              {formatDate(platform.updatedAt)}
            </span>
            {platform.profileUrl ? (
              <a
                href={platform.profileUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
              >
                View on {platform.label}
                <ExternalLink className="size-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
