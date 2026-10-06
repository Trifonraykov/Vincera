import { shortDay } from "@/lib/analytics/range"

/**
 * One metric per day as thin columns (a single series: one hue, no legend; the title names it).
 * Each column has a native tooltip with the day and value, and the same numbers are in a table
 * behind "Show the numbers" (the table view). Columns are anchored to the baseline with a 2px
 * rounded top; the hue is the reference blue used by the audience charts.
 */
export function DailyColumns({
  title,
  days,
  values,
  format = (value) => value.toLocaleString("en-US"),
}: {
  title: string
  days: readonly string[]
  values: readonly number[]
  format?: (value: number) => string
}) {
  const max = Math.max(0, ...values)
  const total = values.reduce((sum, value) => sum + value, 0)
  return (
    <figure className="space-y-2 rounded-xl border bg-card p-4">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{format(total)}</span>
      </figcaption>
      <div className="flex h-24 items-end gap-px" aria-hidden="true">
        {values.map((value, index) => (
          <div
            key={days[index]}
            title={`${shortDay(days[index] ?? "")}: ${format(value)}`}
            className="group flex h-full min-w-0 flex-1 items-end"
          >
            <div
              className="w-full rounded-t-[2px] bg-[#2a78d6] group-hover:opacity-80 dark:bg-[#3987e5]"
              style={{
                height: max > 0 && value > 0 ? `${Math.max((value / max) * 100, 3)}%` : "0",
              }}
            />
          </div>
        ))}
      </div>
      <div
        className="flex justify-between border-t pt-1 text-xs text-muted-foreground"
        aria-hidden="true"
      >
        <span>{days[0] ? shortDay(days[0]) : ""}</span>
        <span>{days.at(-1) ? shortDay(days.at(-1) ?? "") : ""}</span>
      </div>
      <details className="text-sm">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-muted-foreground md:min-h-0">
          Show the numbers
        </summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{title} per day</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1 font-normal">
                  Day
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  {title}
                </th>
              </tr>
            </thead>
            <tbody>
              {values.map((value, index) => (
                <tr key={days[index]} className="border-t">
                  <td className="py-1">{shortDay(days[index] ?? "")}</td>
                  <td className="py-1 text-right tabular-nums">{format(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
