import { conversion, formatRate } from "@/lib/analytics/range"
import { formatMoney } from "@/lib/money"
import type { LinkWithCounts } from "@/lib/tracked-links/queries"

/**
 * The funnel by tracked link: one row per link (and "No link" for visits and sales that came
 * without one). Scrolls sideways inside its own box on phones, never the page.
 */
export function LinksFunnelTable({
  rows,
  currency,
  caption,
}: {
  rows: readonly LinkWithCounts[]
  currency: string
  caption: string
}) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full min-w-[640px] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="px-4 py-2 font-normal">
              Link
            </th>
            <th scope="col" className="px-2 py-2 text-right font-normal">
              Clicks
            </th>
            <th scope="col" className="px-2 py-2 text-right font-normal">
              Page views
            </th>
            <th scope="col" className="px-2 py-2 text-right font-normal">
              Checkouts
            </th>
            <th scope="col" className="px-2 py-2 text-right font-normal">
              Orders
            </th>
            <th scope="col" className="px-2 py-2 text-right font-normal">
              Click → order
            </th>
            <th scope="col" className="px-4 py-2 text-right font-normal">
              Gross
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.link?.id ?? "none"} className="border-b last:border-b-0">
              <th scope="row" className="px-4 py-2 font-normal">
                {row.link ? (
                  <span className="block min-w-0">
                    <span className="font-medium break-words">
                      {row.link.label ?? row.link.code}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      /r/{row.link.code} · {row.link.ownerName}
                      {row.link.disabledAt ? " · off" : ""}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">No link (direct visits)</span>
                )}
              </th>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.link ? row.counts.clicks.toLocaleString("en-US") : "–"}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.counts.views.toLocaleString("en-US")}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.counts.checkouts.toLocaleString("en-US")}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.counts.orders.toLocaleString("en-US")}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.link ? formatRate(conversion(row.counts.orders, row.counts.clicks)) : "–"}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatMoney(row.counts.grossCents, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
