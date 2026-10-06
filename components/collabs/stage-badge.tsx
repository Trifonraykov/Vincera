import { Badge } from "@/components/ui/badge"
import { COLLAB_STAGE_LABELS } from "@/lib/collabs/display"
import type { CollabStage } from "@/lib/db/schema/enums"
import { cn } from "@/lib/utils"

const TONES: Record<CollabStage, string> = {
  agreement: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  building: "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300",
  launch_review: "border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  live: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  ended: "border-border bg-muted text-muted-foreground",
}

/** A collab's stage, in words (colour is never the only signal). */
export function CollabStageBadge({ stage, className }: { stage: CollabStage; className?: string }) {
  return (
    <Badge variant="outline" className={cn(TONES[stage], className)}>
      {COLLAB_STAGE_LABELS[stage]}
    </Badge>
  )
}
