/**
 * Countries and languages for profile forms (creator `country` / `languages`, §5) and for showing
 * them. Client-safe and deterministic: names come from `Intl.DisplayNames` with a fixed `en`
 * locale, so server and client render the same text.
 *
 * Countries are ISO 3166-1 alpha-2 codes, uppercase (the `creator_profiles_country_format` CHECK).
 * Languages are ISO 639-1 codes (639-2/3 where a language has no two-letter code), lowercase, so
 * matching's `audience_fit` can compare them (§8).
 */

/** ISO 3166-1 alpha-2, plus XK (Kosovo, user-assigned but used by most registries). */
export const COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
  "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
  "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
  "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
  "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
  "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
  "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
  "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
  "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
  "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
  "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "XK", "YE", "YT", "ZA", "ZM", "ZW",
] as const // prettier-ignore
export type CountryCode = (typeof COUNTRY_CODES)[number]

const COUNTRY_SET: ReadonlySet<string> = new Set(COUNTRY_CODES)

export function isCountryCode(value: string | null | undefined): value is CountryCode {
  return value != null && COUNTRY_SET.has(value)
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" })
const languageNames = new Intl.DisplayNames(["en"], { type: "language" })

/** "DE" → "Germany"; unknown codes are returned as they are. */
export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

export type Option<T extends string> = { code: T; name: string }

/** Every country as a select option, sorted by English name. */
export function countryOptions(): Option<CountryCode>[] {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )
}

/**
 * Languages offered on the creator profile: the most spoken languages of creator content and the
 * languages of the EU (the platform's first market, §7.2). The first `COMMON_LANGUAGE_COUNT` are
 * shown up front; the form keeps the rest behind "More languages".
 */
export const LANGUAGE_CODES = [
  // Shown first
  "en", "es", "pt", "fr", "de", "it", "nl", "pl", "ar", "hi", "id", "ja",
  // More
  "bg", "bn", "ca", "cs", "da", "el", "et", "eu", "fa", "fi", "fil", "ga", "gl", "he", "hr", "hu",
  "ko", "lt", "lv", "ms", "mt", "no", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "th", "tr", "uk",
  "ur", "vi", "zh",
] as const // prettier-ignore
export type LanguageCode = (typeof LANGUAGE_CODES)[number]
export const COMMON_LANGUAGE_COUNT = 12

const LANGUAGE_SET: ReadonlySet<string> = new Set(LANGUAGE_CODES)

export function isLanguageCode(value: string): value is LanguageCode {
  return LANGUAGE_SET.has(value)
}

/** "es" → "Spanish"; unknown codes are returned as they are. */
export function languageName(code: string): string {
  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Languages as checkbox options, in `LANGUAGE_CODES` order. */
export function languageOptions(): Option<LanguageCode>[] {
  return LANGUAGE_CODES.map((code) => ({ code, name: languageName(code) }))
}
