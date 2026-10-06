/**
 * Countries where a creator or builder can open a Stripe connected account and receive our
 * transfers (§7.2, docs/integrations/stripe.md "Cross-border"): under the full service agreement a
 * platform in the US, UK, EEA, CA or CH can transfer to connected accounts in any of those
 * regions. Client-safe, so the country picker and the server share one list.
 *
 * Stripe does not support every EEA member as an account country (Iceland is missing), so the EEA
 * list is Stripe's. A connected account's country cannot be changed after it is created.
 */
export const PAYOUT_COUNTRIES = {
  AT: "Austria",
  BE: "Belgium",
  BG: "Bulgaria",
  CA: "Canada",
  HR: "Croatia",
  CY: "Cyprus",
  CZ: "Czech Republic",
  DK: "Denmark",
  EE: "Estonia",
  FI: "Finland",
  FR: "France",
  DE: "Germany",
  GR: "Greece",
  HU: "Hungary",
  IE: "Ireland",
  IT: "Italy",
  LV: "Latvia",
  LI: "Liechtenstein",
  LT: "Lithuania",
  LU: "Luxembourg",
  MT: "Malta",
  NL: "Netherlands",
  NO: "Norway",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  SK: "Slovakia",
  SI: "Slovenia",
  ES: "Spain",
  SE: "Sweden",
  CH: "Switzerland",
  GB: "United Kingdom",
  US: "United States",
} as const satisfies Record<string, string>

export type PayoutCountry = keyof typeof PAYOUT_COUNTRIES

export const PAYOUT_COUNTRY_CODES = Object.keys(PAYOUT_COUNTRIES) as PayoutCountry[]

export function isPayoutCountry(value: string | null | undefined): value is PayoutCountry {
  return value != null && Object.hasOwn(PAYOUT_COUNTRIES, value)
}

/** Options for a country select, sorted by name. */
export function payoutCountryOptions(): { code: PayoutCountry; name: string }[] {
  return PAYOUT_COUNTRY_CODES.map((code) => ({ code, name: PAYOUT_COUNTRIES[code] })).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )
}

/** The country's English name, or the code itself when it is not a payout country. */
export function countryName(code: string): string {
  return isPayoutCountry(code) ? PAYOUT_COUNTRIES[code] : code
}
