import { Badge } from "@/components/ui/badge"
import { statusLabel, type SupplyKind, type SupplyStatus } from "@/lib/supply/lifecycle"
import { cn } from "@/lib/utils"

/** The status of an idea or product as a badge: filled while published, outlined otherwise. */
export function SupplyStatusBadge({
  kind,
  status,
  className,
}: {
  kind: SupplyKind
  status: SupplyStatus
  className?: string
}) {
  const live = status === "open" || status === "seeking"
  const busy = status === "in_collab" || status === "launched"
  return (
    <Badge
      variant={live ? "default" : busy ? "secondary" : "outline"}
      className={cn(status === "archived" && "text-muted-foreground", className)}
    >
      {statusLabel(kind, status)}
    </Badge>
  )
}
