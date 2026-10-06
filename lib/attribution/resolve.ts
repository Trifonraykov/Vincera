import "server-only"

import { and, eq, isNull } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { trackedLinks } from "@/lib/db/schema"

import { parseAttributionCookie, parseRefParam } from "./cookie"

/**
 * The tracked link a checkout is attributed to (§10; CLAUDE.md §19.31 "Attribution"), for the
 * checkout builder: the `attr` cookie when it names an enabled link **of the same launch**, else
 * `?ref=<code>` (forwarded from `/p/[slug]?ref=`), else none. Discount-code attribution is decided
 * at completion from the promotion code, not here.
 */
export type CheckoutAttribution =
  | { trackedLinkId: string; attribution: "cookie" | "ref" }
  | { trackedLinkId: null; attribution: null }

export async function resolveCheckoutAttribution(
  database: DbOrTx,
  input: { launchId: string; cookie: string | null | undefined; ref: string | null | undefined },
): Promise<CheckoutAttribution> {
  const fromCookie = parseAttributionCookie(input.cookie)
  if (fromCookie) {
    const [link] = await database
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.id, fromCookie),
          eq(trackedLinks.launchId, input.launchId),
          isNull(trackedLinks.disabledAt),
        ),
      )
    if (link) return { trackedLinkId: link.id, attribution: "cookie" }
  }
  const code = parseRefParam(input.ref)
  if (code) {
    const [link] = await database
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.code, code),
          eq(trackedLinks.launchId, input.launchId),
          isNull(trackedLinks.disabledAt),
        ),
      )
    if (link) return { trackedLinkId: link.id, attribution: "ref" }
  }
  return { trackedLinkId: null, attribution: null }
}
