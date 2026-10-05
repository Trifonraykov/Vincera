import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/** One headline number: label, value, optional note (§ dataviz stat tile contract). */
export function StatTile({
  label,
  value,
  note,
  className,
}: {
  label: string
  value: ReactNode
  note?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-1 rounded-xl border bg-card p-4", className)}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tracking-tight">{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  )
}
