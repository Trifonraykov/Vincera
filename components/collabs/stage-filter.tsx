import Link from "next/link"

import { collabFilterLabel, COLLAB_FILTERS, type CollabFilter } from "@/lib/collabs/display"
import { cn } from "@/lib/utils"

/**
 * The stage filter of `/app/collabs` (`?stage=`): one link per stage with its count, "Active"
 * (every stage but ended) first and "All" last. On phones the row scrolls sideways inside itself
 * (never the page) and every chip is a 44 px target; empty stages are hidden, except "Active",
 * "All" and the current one. Same look as the ideas and products filters.
 */
export function CollabStageFilter({
  current,
  counts,
}: {
  current: CollabFilter
  counts: Record<CollabFilter, number>
}) {
  const shown = COLLAB_FILTERS.filter(
    (filter) => filter === "active" || filter === "all" || filter === current || counts[filter] > 0,
  )
  return (
    <nav aria-label="Filter collabs by stage" className="-mx-4 sm:mx-0">
      <ul className="flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 py-1 sm:flex-wrap sm:overflow-visible sm:px-0">
        {shown.map((filter) => {
          const active = filter === current
          return (
            <li key={filter} className="shrink-0">
              <Link
                href={filter === "active" ? "/app/collabs" : `/app/collabs?stage=${filter}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-8 sm:px-3",
                  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {collabFilterLabel(filter)}
                <span
                  className={cn("tabular-nums", active ? "opacity-80" : "text-muted-foreground")}
                >
                  {counts[filter]}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
