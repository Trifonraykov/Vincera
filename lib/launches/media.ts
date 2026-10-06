import "server-only"

import { eq } from "drizzle-orm"

import { canViewLaunchSetup, type AuthzUser } from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import { launches } from "@/lib/db/schema"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import { mediaKeyByName } from "./content"
import { loadLaunchAccess } from "./queries"
import { isPublicLaunch } from "./status"

/**
 * `GET /api/launches/<launchId>/media/<name>`: a product image (§14: private storage, signed
 * URLs). Images of a public launch (live, paused, ended) are public like the product page; before
 * that only the collab's members and admins see them (the setup page's previews). Answers a 302 to
 * a 10-minute signed URL, or 404 for anything else.
 */

export const LAUNCH_MEDIA_URL_TTL_SECONDS = 10 * 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME = /^[0-9a-f-]{36}\.[a-z0-9]+$/

const notFound = () =>
  new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } })

export async function launchMediaResponse(
  input: { launchId: string; name: string; viewer: AuthzUser | null },
  deps: { db: DbOrTx; storage?: ObjectStorage },
): Promise<Response> {
  if (!UUID.test(input.launchId) || !NAME.test(input.name)) return notFound()
  const [row] = await deps.db
    .select({ status: launches.status, wentLiveAt: launches.wentLiveAt, media: launches.media })
    .from(launches)
    .where(eq(launches.id, input.launchId))
  if (!row) return notFound()
  const isPublic = isPublicLaunch(row)
  if (!isPublic) {
    const access = await loadLaunchAccess(deps.db, input.launchId)
    if (!input.viewer || !access || !canViewLaunchSetup(input.viewer, access)) return notFound()
  }
  const key = mediaKeyByName(row.media, input.launchId, input.name)
  if (!key) return notFound()
  const url = await (deps.storage ?? getStorage()).signedGetUrl(key, {
    expiresInSeconds: LAUNCH_MEDIA_URL_TTL_SECONDS,
  })
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${Math.floor(LAUNCH_MEDIA_URL_TTL_SECONDS / 2)}`,
    },
  })
}
