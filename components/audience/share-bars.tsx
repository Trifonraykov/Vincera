import { formatPercent } from "./format"

export type ShareRow = { key: string; label: string; share: number }

/**
 * A ranked bar list of shares (one series: magnitude, one hue). It is a real table, so screen
 * readers and the "table view" requirement are served by the same markup; every bar is labelled
 * with its value at the tip. Bars are 12px with a 4px rounded data end; the hue is the validated
 * reference blue, stepped per theme.
 */
export function ShareBars({
  rows,
  caption,
  labelHeader,
  valueHeader,
}: {
  rows: readonly ShareRow[]
  caption: string
  labelHeader: string
  valueHeader: string
}) {
  const max = Math.max(...rows.map((row) => row.share), 0)
  if (rows.length === 0) return null

  return (
    <table className="w-full table-fixed border-separate border-spacing-y-1.5 text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">{labelHeader}</th>
          <th scope="col">{valueHeader}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="group">
            <th
              scope="row"
              className="w-28 truncate pr-3 text-left font-normal text-muted-foreground sm:w-40"
            >
              {row.label}
            </th>
            <td>
              <div className="flex items-center gap-2">
                <div className="h-3 flex-1" aria-hidden="true">
                  <div
                    className="h-full rounded-r-[4px] bg-[#2a78d6] transition-opacity group-hover:opacity-80 dark:bg-[#3987e5]"
                    style={{ width: `${max > 0 ? Math.max((row.share / max) * 100, 1) : 0}%` }}
                  />
                </div>
                <span className="w-14 text-right font-medium tabular-nums">
                  {formatPercent(row.share)}
                </span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
