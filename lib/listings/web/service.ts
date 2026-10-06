import "server-only"

import { eq } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import type { ClaudeDeps } from "@/lib/ai/claude"
import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles } from "@/lib/db/schema"
import {
  checkFetchableUrl,
  decodeBody,
  safeFetch,
  SafeFetchError,
  type NetTransport,
} from "@/lib/net/safe-fetch"
import type { ObjectStorage } from "@/lib/storage/types"

import { saveListingDraft, type ListingWriteResult } from "../store"
import { listingTransport } from "../transport"
import { pageToDraft } from "./mapping"
import { parseWebPage } from "./parse"

/**
 * Import a product from its web page (CLAUDE.md §19.45): the builder pastes a link, we fetch it
 * with `safeFetch` (SSRF rules: public addresses only, checked again after every redirect, 3
 * redirects, 5 s, 2 MB, HTML only), read its Open Graph / Twitter / JSON-LD / title / icons, and
 * write a published listing keyed by the normalised link. Pasting the same link again updates it.
 */

export const WEB_IMPORT_ACCEPT = ["text/html", "application/xhtml+xml"] as const

export type WebImportDeps = { transport?: NetTransport; storage?: ObjectStorage; ai?: ClaudeDeps }

/** "tasktide.example" → "https://tasktide.example"; anything with a scheme is kept as typed. */
export function webInputUrl(raw: string): string {
  const value = raw.trim()
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
}

function refused(message: string): never {
  throw new ActionError(message, { fieldErrors: { url: [message] } })
}

export async function importWebListing(
  database: DbOrTx,
  input: { userId: string; url: string },
  deps: WebImportDeps = {},
): Promise<ListingWriteResult> {
  const [profile] = await database
    .select({ id: builderProfiles.id })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, input.userId))
    .limit(1)
  if (!profile) throw new ActionError("Create your builder profile first.")

  let requested: URL
  try {
    requested = checkFetchableUrl(webInputUrl(input.url))
  } catch (error) {
    if (error instanceof SafeFetchError) refused(error.message)
    throw error
  }
  const transport = deps.transport ?? listingTransport("web")
  let html: string
  let finalUrl: URL
  try {
    const page = await safeFetch(
      requested,
      { accept: WEB_IMPORT_ACCEPT, acceptHeader: "text/html,application/xhtml+xml;q=0.9" },
      transport,
    )
    html = decodeBody(page)
    finalUrl = page.url
  } catch (error) {
    if (error instanceof SafeFetchError) refused(error.message)
    throw error
  }

  const draft = pageToDraft({
    page: parseWebPage(html, finalUrl),
    requestedUrl: requested,
    finalUrl,
  })
  return saveListingDraft(database, {
    builderProfileId: profile.id,
    actorUserId: input.userId,
    draft,
    transport,
    storage: deps.storage,
    ai: deps.ai,
  })
}
