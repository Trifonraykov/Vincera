import type { CountryShare } from "@/lib/db/schema/types"
import type { AudienceBasis } from "@/lib/social/types"

import { countryLabel } from "./format"
import { ShareBars } from "./share-bars"

/** Top countries, largest first (shares of viewers or followers, per `basis`). */
export function CountryBars({
  countries,
  basis,
  caption,
  limit = 10,
}: {
  countries: readonly CountryShare[]
  basis: AudienceBasis | null
  caption: string
  limit?: number
}) {
  const rows = [...countries]
    .sort((a, b) => b.share - a.share)
    .slice(0, limit)
    .map((row) => ({ key: row.country, label: countryLabel(row.country), share: row.share }))
  return (
    <ShareBars
      rows={rows}
      caption={caption}
      labelHeader="Country"
      valueHeader={`Share of ${basis ?? "audience"}`}
    />
  )
}
