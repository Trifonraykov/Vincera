import type { AgeGender } from "@/lib/db/schema/types"

import {
  ageGroupLabel,
  formatPercent,
  GENDER_LABELS,
  genderGroup,
  type GenderGroup,
} from "./format"

/**
 * Age × gender as one stacked bar per age group (part-to-whole of the audience). Three gender
 * groups take categorical slots 1–3 of the validated reference palette (blue, orange, aqua;
 * CVD-checked in both themes against the card surface). A legend with totals is always shown,
 * segments are separated by a 2px surface gap, and the full numbers are in the table below the
 * chart (the light aqua is under 3:1 on white, so the table and legend carry the values).
 */

const GENDER_ORDER: readonly GenderGroup[] = ["female", "male", "other"]

const SWATCH: Record<GenderGroup, string> = {
  female: "bg-[#2a78d6] dark:bg-[#3987e5]",
  male: "bg-[#eb6834] dark:bg-[#d95926]",
  other: "bg-[#1baf7a] dark:bg-[#199e70]",
}

type AgeRow = { ageGroup: string; total: number; byGender: Record<GenderGroup, number> }

function rowsOf(ageGender: AgeGender): AgeRow[] {
  const rows = new Map<string, AgeRow>()
  for (const bucket of ageGender.buckets) {
    const row = rows.get(bucket.ageGroup) ?? {
      ageGroup: bucket.ageGroup,
      total: 0,
      byGender: { female: 0, male: 0, other: 0 },
    }
    const group = genderGroup(bucket.gender)
    row.byGender[group] += bucket.share
    row.total += bucket.share
    rows.set(bucket.ageGroup, row)
  }
  return [...rows.values()].sort((a, b) =>
    a.ageGroup.localeCompare(b.ageGroup, "en", { numeric: true }),
  )
}

export function AgeGenderChart({ ageGender, caption }: { ageGender: AgeGender; caption: string }) {
  const rows = rowsOf(ageGender)
  if (rows.length === 0) return null
  const totals: Record<GenderGroup, number> = { female: 0, male: 0, other: 0 }
  for (const row of rows) for (const group of GENDER_ORDER) totals[group] += row.byGender[group]
  const genders = GENDER_ORDER.filter((group) => totals[group] > 0)
  const max = Math.max(...rows.map((row) => row.total), 0)

  return (
    <figure className="space-y-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Legend">
        {genders.map((group) => (
          <li key={group} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-full ${SWATCH[group]}`} aria-hidden="true" />
            <span className="text-muted-foreground">{GENDER_LABELS[group]}</span>
            <span className="font-medium tabular-nums">{formatPercent(totals[group])}</span>
          </li>
        ))}
      </ul>

      <div className="space-y-1.5" aria-hidden="true">
        {rows.map((row) => (
          <div key={row.ageGroup} className="flex items-center gap-2 text-sm">
            <span className="w-14 shrink-0 text-muted-foreground tabular-nums">
              {ageGroupLabel(row.ageGroup)}
            </span>
            <div className="flex h-3 flex-1 items-stretch">
              <div
                className="flex gap-0.5"
                style={{ width: `${max > 0 ? Math.max((row.total / max) * 100, 1) : 0}%` }}
              >
                {genders
                  .filter((group) => row.byGender[group] > 0)
                  .map((group, index, present) => (
                    <div
                      key={group}
                      title={`${ageGroupLabel(row.ageGroup)} · ${GENDER_LABELS[group]} · ${formatPercent(row.byGender[group])}`}
                      className={`h-full ${SWATCH[group]} ${index === present.length - 1 ? "rounded-r-[4px]" : ""} transition-opacity hover:opacity-80`}
                      style={{ flexGrow: row.byGender[group], flexBasis: 0 }}
                    />
                  ))}
              </div>
            </div>
            <span className="w-14 text-right font-medium tabular-nums">
              {formatPercent(row.total)}
            </span>
          </div>
        ))}
      </div>

      <figcaption className="sr-only">{caption}</figcaption>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground underline-offset-4 hover:underline">
          Show as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left tabular-nums">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-normal">
                  Age
                </th>
                {genders.map((group) => (
                  <th key={group} scope="col" className="py-1.5 pr-3 font-normal">
                    {GENDER_LABELS[group]}
                  </th>
                ))}
                <th scope="col" className="py-1.5 font-normal">
                  All
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.ageGroup} className="border-b last:border-0">
                  <th scope="row" className="py-1.5 pr-3 font-normal">
                    {ageGroupLabel(row.ageGroup)}
                  </th>
                  {genders.map((group) => (
                    <td key={group} className="py-1.5 pr-3">
                      {formatPercent(row.byGender[group])}
                    </td>
                  ))}
                  <td className="py-1.5 font-medium">{formatPercent(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
