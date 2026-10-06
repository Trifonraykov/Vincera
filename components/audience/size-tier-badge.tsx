import { Gauge } from "lucide-react"

import { UnverifiedBadge } from "@/components/social/connection-status-badge"
import { Badge } from "@/components/ui/badge"
import type { SizeTier } from "@/lib/db/schema/enums"
import { SIZE_TIER_LABELS, SIZE_TIER_RANGES } from "@/lib/social/size-tier"

/** A creator's size tier (§5), flagged "Unverified" when it comes from self-reported numbers. */
export function SizeTierBadge({
  tier,
  verified,
  showRange = false,
}: {
  tier: SizeTier
  verified: boolean
  showRange?: boolean
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary">
        <Gauge aria-hidden="true" />
        {SIZE_TIER_LABELS[tier]} creator
        {showRange ? (
          <span className="font-normal text-muted-foreground">· {SIZE_TIER_RANGES[tier]}</span>
        ) : null}
      </Badge>
      {verified ? null : <UnverifiedBadge />}
    </span>
  )
}
