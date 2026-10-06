import Link from "next/link"

import {
  filterLabel,
  SUPPLY_FILTERS,
  type SupplyFilter,
  type SupplyKind,
} from "@/lib/supply/lifecycle"
import { cn } from "@/lib/utils"

/**
 * The status filter of `/app/ideas` and `/app/products` (`?status=`): one link per filter with its
 * count. On phones the row scrolls sideways inside itself (never the page) and every chip is a
 * 44 px target; filters with nothing in them are hidden, except "All" and the current one.
 */
export function SupplyStatusFilter({
  kind,
  basePath,
  current,
  counts,
}: {
  kind: SupplyKind
  basePath: string
  current: SupplyFilter
  counts: Record<SupplyFilter, number>
}) {
  const shown = SUPPLY_FILTERS.filter(
    (filter) => filter === "all" || filter === current || counts[filter] > 0,
  )
  return (
    <nav aria-label={`Filter ${kind}s by status`} className="-mx-4 sm:mx-0">
      <ul className="flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 py-1 sm:flex-wrap sm:overflow-visible sm:px-0">
        {shown.map((filter) => {
          const active = filter === current
          return (
            <li key={filter} className="shrink-0">
              <Link
                href={filter === "all" ? basePath : `${basePath}?status=${filter}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-8 sm:px-3",
                  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {filterLabel(kind, filter)}
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
