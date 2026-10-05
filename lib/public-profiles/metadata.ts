import type { Metadata } from "next"

/**
 * Metadata for public profiles: title, description, canonical URL, Open Graph `profile` and a
 * Twitter summary card (relative URLs resolve against the root layout's `metadataBase`).
 */
export function profileMetadata(input: {
  path: string
  title: string
  description: string
  handle: string
  appName: string
}): Metadata {
  const description = truncate(input.description, 160)
  return {
    title: input.title,
    description,
    alternates: { canonical: input.path },
    openGraph: {
      type: "profile",
      title: input.title,
      description,
      url: input.path,
      siteName: input.appName,
      username: input.handle,
    },
    twitter: { card: "summary", title: input.title, description },
  }
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** Metadata when the handle does not resolve: no indexing. */
export const NOT_FOUND_METADATA: Metadata = {
  title: "Profile not found",
  robots: { index: false, follow: false },
}
