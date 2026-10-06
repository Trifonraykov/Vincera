import { getCurrentUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { launchMediaResponse } from "@/lib/launches/media"

/**
 * A launch's product image (§14 signed URLs; lib/launches/media.ts): a redirect to a short-lived
 * signed URL. Public once the launch has gone live; members and admins before that.
 */

type Context = { params: Promise<{ launchId: string; name: string }> }

export const dynamic = "force-dynamic"

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { launchId, name } = await context.params
  return launchMediaResponse({ launchId, name, viewer: await getCurrentUser() }, { db: getDb() })
}
