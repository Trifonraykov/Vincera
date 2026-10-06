import { Badge } from "@/components/ui/badge"
import type { ProposalStatus } from "@/lib/db/schema/enums"
import { PROPOSAL_STATUS_LABELS } from "@/lib/proposals/display"
import { cn } from "@/lib/utils"

const TONES: Record<ProposalStatus, string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  countered: "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300",
  accepted: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  declined: "border-border bg-muted text-muted-foreground",
  expired: "border-border bg-muted text-muted-foreground",
  withdrawn: "border-border bg-muted text-muted-foreground",
}

/** A proposal's status, in words (colour is never the only signal). */
export function ProposalStatusBadge({
  status,
  className,
}: {
  status: ProposalStatus
  className?: string
}) {
  return (
    <Badge variant="outline" className={cn(TONES[status], className)}>
      {PROPOSAL_STATUS_LABELS[status]}
    </Badge>
  )
}

/** "Your turn" next to proposals that wait for the viewer's answer. */
export function YourTurnBadge({ className }: { className?: string }) {
  return <Badge className={className}>Your turn</Badge>
}
