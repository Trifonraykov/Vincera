import { Badge } from "@/components/ui/badge"
import type { LaunchStatus } from "@/lib/db/schema/enums"
import { LAUNCH_STATUS_LABELS } from "@/lib/launches/status"
import { cn } from "@/lib/utils"

const TONES: Record<LaunchStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  pending_approval: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  admin_review: "border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  live: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  paused: "border-orange-500/40 bg-orange-500/10 text-orange-800 dark:text-orange-300",
  ended: "border-border bg-muted text-muted-foreground",
}

/** A launch's status, in words (colour is never the only signal). */
export function LaunchStatusBadge({
  status,
  className,
}: {
  status: LaunchStatus
  className?: string
}) {
  return (
    <Badge variant="outline" className={cn(TONES[status], className)}>
      {LAUNCH_STATUS_LABELS[status]}
    </Badge>
  )
}
