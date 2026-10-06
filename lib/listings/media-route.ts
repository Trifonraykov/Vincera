import "server-only"

import { eq } from "drizzle-orm"

import { isAdmin, PUBLIC_PRODUCT_STATUSES } from "@/lib/auth/authz"
import type { AuthUser } from "@/lib/auth/user"
import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, products, users } from "@/lib/db/schema"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import { isOwnMediaKey } from "./media"

/**
 * `GET /api/products/<id>/media/<hash>` (CLAUDE.md §19.45): a listing image, as a redirect to a
 * 10-minute signed URL of the copy in our storage. Public while the listing is (a published
 * status, an active builder); otherwise only its builder and admins. Anything else is 404.
 */

export const LISTING_MEDIA_URL_TTL_SECONDS = 600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } })
}

export async function listingMediaResponse(
  input: { productId: string; hash: string; viewer: AuthUser | null },
  deps: { db: DbOrTx; storage?: ObjectStorage },
): Promise<Response> {
  if (!UUID.test(input.productId) || !/^[0-9a-f]{16}$/.test(input.hash)) return notFound()
  const [row] = await deps.db
    .select({
      status: products.status,
      media: products.media,
      ownerUserId: builderProfiles.userId,
      ownerStatus: users.status,
    })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(eq(products.id, input.productId))
    .limit(1)
  if (!row) return notFound()
  const isPublic =
    row.ownerStatus === "active" &&
    (PUBLIC_PRODUCT_STATUSES as readonly string[]).includes(row.status)
  const viewer = input.viewer
  const allowed =
    isPublic || (viewer !== null && (viewer.id === row.ownerUserId || isAdmin(viewer)))
  if (!allowed) return notFound()
  const item = row.media.find((media) => media.hash === input.hash)
  if (!item || !isOwnMediaKey(input.productId, item.key)) return notFound()
  const url = await (deps.storage ?? getStorage()).signedGetUrl(item.key, {
    expiresInSeconds: LISTING_MEDIA_URL_TTL_SECONDS,
  })
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${LISTING_MEDIA_URL_TTL_SECONDS / 2}`,
    },
  })
}
