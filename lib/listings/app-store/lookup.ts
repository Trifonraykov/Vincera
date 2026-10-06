import { z } from "zod"

import { safeFetch, SafeFetchError, decodeBody, type NetTransport } from "@/lib/net/safe-fetch"

/**
 * Apple's public, keyless iTunes Lookup API (CLAUDE.md §19.45):
 * `https://itunes.apple.com/lookup?id=<id>&entity=software&limit=200&country=<cc>`.
 *
 * With a developer (artist) id and `entity=software` it answers the artist wrapper followed by the
 * developer's apps; with an app's trackId, that app. Every response is Zod-parsed (§4); results
 * that do not parse are dropped one by one, so one odd app never hides the others. Apple serves the
 * JSON as `text/javascript`.
 */

export const ITUNES_LOOKUP_ORIGIN = "https://itunes.apple.com"
export const ITUNES_HOST = "itunes.apple.com"
/** Apple's image CDN: the only host App Store images are copied from. */
export function isAppleImageHost(hostname: string): boolean {
  return /(^|\.)mzstatic\.com$/i.test(hostname)
}

const idNumber = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)])
const optionalString = z.string().nullish()
const httpUrl = z.string().regex(/^https?:\/\/\S+$/i)

export const appStoreArtistSchema = z.object({
  wrapperType: z.literal("artist"),
  artistId: idNumber,
  artistName: z.string().min(1),
  artistLinkUrl: optionalString,
})
export type AppStoreArtist = z.infer<typeof appStoreArtistSchema>

export const appStoreAppSchema = z.object({
  wrapperType: z.literal("software"),
  trackId: idNumber,
  trackName: z.string().min(1),
  artistId: idNumber,
  artistName: z.string().min(1),
  sellerName: optionalString,
  description: optionalString,
  artworkUrl512: httpUrl.nullish(),
  artworkUrl100: httpUrl.nullish(),
  artworkUrl60: httpUrl.nullish(),
  screenshotUrls: z.array(z.string()).nullish(),
  ipadScreenshotUrls: z.array(z.string()).nullish(),
  formattedPrice: optionalString,
  price: z.number().nonnegative().nullish(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .nullish(),
  averageUserRating: z.number().min(0).max(5).nullish(),
  userRatingCount: z.number().int().nonnegative().nullish(),
  primaryGenreName: optionalString,
  genres: z.array(z.string()).nullish(),
  trackViewUrl: httpUrl.nullish(),
  releaseDate: optionalString,
  currentVersionReleaseDate: optionalString,
})
export type AppStoreApp = z.infer<typeof appStoreAppSchema>

const lookupEnvelopeSchema = z.object({
  resultCount: z.number().int().nonnegative(),
  results: z.array(z.unknown()),
})

export type LookupResult = { artist: AppStoreArtist | null; apps: AppStoreApp[] }

export class AppStoreLookupError extends Error {
  constructor(
    readonly code: "unavailable" | "invalid_response",
    message: string,
  ) {
    super(message)
    this.name = "AppStoreLookupError"
  }
}

export function lookupUrl(input: { id: string; country: string; software: boolean }): URL {
  const url = new URL("/lookup", ITUNES_LOOKUP_ORIGIN)
  url.searchParams.set("id", input.id)
  if (input.software) {
    url.searchParams.set("entity", "software")
    url.searchParams.set("limit", "200")
  }
  url.searchParams.set("country", input.country)
  return url
}

/** Parse a lookup body: the artist (if any) and every software result that parses. */
export function parseLookup(json: unknown): LookupResult {
  const envelope = lookupEnvelopeSchema.safeParse(json)
  if (!envelope.success) {
    throw new AppStoreLookupError("invalid_response", "The App Store sent an answer we can't read.")
  }
  let artist: AppStoreArtist | null = null
  const apps: AppStoreApp[] = []
  for (const result of envelope.data.results) {
    const asArtist = appStoreArtistSchema.safeParse(result)
    if (asArtist.success) {
      artist ??= asArtist.data
      continue
    }
    const asApp = appStoreAppSchema.safeParse(result)
    if (asApp.success) apps.push(asApp.data)
  }
  return { artist, apps }
}

/** One lookup request (never throws a SafeFetchError: they become `unavailable`). */
export async function appStoreLookup(
  input: { id: string; country: string; software: boolean },
  transport: NetTransport,
): Promise<LookupResult> {
  let text: string
  try {
    const result = await safeFetch(
      lookupUrl(input),
      {
        accept: ["text/javascript", "application/json", "application/javascript", "text/json"],
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 10_000,
        allowHost: (host) => host === ITUNES_HOST,
      },
      transport,
    )
    text = decodeBody(result)
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw new AppStoreLookupError("unavailable", "The App Store isn't answering right now.")
    }
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new AppStoreLookupError("invalid_response", "The App Store sent an answer we can't read.")
  }
  return parseLookup(json)
}

export const idString = (value: string | number): string => String(value)
