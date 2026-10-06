import Link from "next/link"

import { Button } from "@/components/ui/button"
import { lastDays, RANGE_PRESETS, rangeLength, type DayRange } from "@/lib/analytics/range"
import { cn } from "@/lib/utils"

/**
 * Date range control (UTC days) for the analytics pages: preset chips as links, plus a small GET
 * form with two date fields. Works without JavaScript; `extra` keeps other search params (filters).
 */
export function RangePicker({
  basePath,
  range,
  now,
  maxDays,
  presets = RANGE_PRESETS,
  extra = {},
}: {
  basePath: string
  range: DayRange
  now: Date
  maxDays: number
  presets?: readonly number[]
  extra?: Record<string, string>
}) {
  const href = (r: DayRange) => {
    const params = new URLSearchParams({ ...extra, from: r.from, to: r.to })
    return `${basePath}?${params.toString()}`
  }
  const length = rangeLength(range)
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <nav aria-label="Date range" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <ul className="flex min-w-max gap-2">
          {presets
            .filter((days) => days <= maxDays)
            .map((days) => {
              const preset = lastDays(days, now)
              const active = preset.from === range.from && preset.to === range.to
              return (
                <li key={days}>
                  <Link
                    href={href(preset)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "inline-flex h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors md:h-8",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "hover:bg-accent",
                    )}
                  >
                    {days === 365 ? "Last year" : `Last ${days} days`}
                  </Link>
                </li>
              )
            })}
        </ul>
      </nav>
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-2">
        {Object.entries(extra).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <label className="grid gap-1 text-xs text-muted-foreground">
          From
          <input
            type="date"
            name="from"
            defaultValue={range.from}
            className="h-11 rounded-md border bg-background px-2 text-base text-foreground md:h-8 md:text-sm"
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          To
          <input
            type="date"
            name="to"
            defaultValue={range.to}
            className="h-11 rounded-md border bg-background px-2 text-base text-foreground md:h-8 md:text-sm"
          />
        </label>
        <Button type="submit" variant="outline" className="h-11 md:h-8">
          Apply
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          {length} {length === 1 ? "day" : "days"}, UTC. Up to {maxDays} days.
        </p>
      </form>
    </div>
  )
}
