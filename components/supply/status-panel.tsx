import type { ReactNode } from "react"

import { statusExplanation, type SupplyKind, type SupplyStatus } from "@/lib/supply/lifecycle"

import { SupplyStatusBadge } from "./status-badge"

/** The owner's status box on a detail page: badge, what it means, and the status buttons. */
export function SupplyStatusPanel({
  kind,
  status,
  children,
}: {
  kind: SupplyKind
  status: SupplyStatus
  children?: ReactNode
}) {
  return (
    <section
      aria-label="Status"
      className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-1.5">
        <SupplyStatusBadge kind={kind} status={status} />
        <p className="text-sm text-pretty text-muted-foreground">
          {statusExplanation(kind, status)}
        </p>
      </div>
      {children ? <div className="flex shrink-0 flex-col gap-2 sm:flex-row">{children}</div> : null}
    </section>
  )
}
