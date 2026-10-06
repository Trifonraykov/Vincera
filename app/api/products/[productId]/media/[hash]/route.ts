import { getCurrentUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { listingMediaResponse } from "@/lib/listings/media-route"

/**
 * A listing image (CLAUDE.md §19.45): redirects to a short-lived signed URL of our copy (images
 * are copied into storage on import, never hotlinked), or 404. See lib/listings/media-route.ts.
 */

type Context = { params: Promise<{ productId: string; hash: string }> }

export const dynamic = "force-dynamic"

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { productId, hash } = await context.params
  return listingMediaResponse({ productId, hash, viewer: await getCurrentUser() }, { db: getDb() })
}
