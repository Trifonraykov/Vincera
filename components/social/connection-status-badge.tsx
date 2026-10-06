import { BadgeCheck, CircleAlert, Clock, ShieldQuestion, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { ConnectionHealth } from "@/lib/social/view"
import { cn } from "@/lib/utils"

/**
 * A connection's state in words plus an icon (never color alone): Verified, Unverified (manual
 * entry not checked yet), Syncing, Sync problem, Expired.
 */

const HEALTH: Record<
  ConnectionHealth,
  { label: string; icon: typeof BadgeCheck; className: string }
> = {
  ok: {
    label: "Verified",
    icon: BadgeCheck,
    className: "border-emerald-600/30 text-emerald-700 dark:text-emerald-300",
  },
  unverified: {
    label: "Unverified",
    icon: ShieldQuestion,
    className: "border-amber-600/40 text-amber-800 dark:text-amber-300",
  },
  syncing: {
    label: "Syncing",
    icon: Clock,
    className: "text-muted-foreground",
  },
  error: {
    label: "Sync problem",
    icon: TriangleAlert,
    className: "border-amber-600/40 text-amber-800 dark:text-amber-300",
  },
  expired: {
    label: "Expired",
    icon: CircleAlert,
    className: "border-destructive/40 text-destructive",
  },
}

export function ConnectionStatusBadge({
  health,
  className,
}: {
  health: ConnectionHealth
  className?: string
}) {
  const { label, icon: Icon, className: tone } = HEALTH[health]
  return (
    <Badge variant="outline" className={cn(tone, className)}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  )
}

/** The "Unverified" flag for self-reported numbers (§7.1 fallback), wherever they are shown. */
export function UnverifiedBadge({ className }: { className?: string }) {
  return <ConnectionStatusBadge health="unverified" className={className} />
}
