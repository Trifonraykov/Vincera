import { ChevronRight, Lightbulb, Package } from "lucide-react"
import Link from "next/link"

import { formatRelative, formatTimeLeft } from "@/lib/proposals/display"
import { formatTimeline } from "@/lib/proposals/fields"
import type { ProposalListItem } from "@/lib/proposals/queries"
import { cn } from "@/lib/utils"

import { ProposalStatusBadge, YourTurnBadge } from "./status-badge"

/**
 * Proposals as tappable rows (one link per row, at least 44 px tall): what it is about, with whom,
 * the terms on the table, and whose turn it is or how it ended.
 */
export function ProposalList({
  items,
  now,
  className,
}: {
  items: readonly ProposalListItem[]
  now: Date
  className?: string
}) {
  return (
    <ul className={cn("divide-y overflow-hidden rounded-xl border bg-card shadow-xs", className)}>
      {items.map((item) => {
        const Icon = item.target.kind === "idea" ? Lightbulb : Package
        const open = item.closedAt === null
        return (
          <li key={item.id}>
            <Link
              href={`/app/proposals/${item.id}`}
              className="flex min-h-11 items-start gap-3 p-4 transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{item.target.title}</span>
                  {item.yourTurn ? <YourTurnBadge /> : null}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {item.sentByUser ? "To" : "From"} {item.counterpart.name} · Creator{" "}
                  {item.creatorSplitPct}% / Builder {item.builderSplitPct}% ·{" "}
                  {formatTimeline(item.timelineWeeks)}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <ProposalStatusBadge status={item.status} />
                  {open ? (
                    <span>
                      {item.yourTurn ? "Answer" : "Expires"} {formatTimeLeft(item.expiresAt, now)}
                    </span>
                  ) : item.closedAt ? (
                    <span>{formatRelative(item.closedAt, now)}</span>
                  ) : null}
                </span>
              </span>
              <ChevronRight
                className="mt-2 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
